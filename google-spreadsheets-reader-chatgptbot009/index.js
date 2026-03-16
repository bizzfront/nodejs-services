/**
 * FUNDASE Private Backend - Google Sheets Reader API (CommonJS)
 *
 * ✅ Reglas (según tu definición final)
 * - module: OBLIGATORIO (define la hoja/módulo a consultar)
 * - time: OPCIONAL (solo aplica si module=agenda o module=vih)
 * - col + like: OPCIONAL (filtro tipo LIKE por columna)
 *   - si envías col debes enviar like y viceversa
 *   - col soporta: "Col1|Col2" o "Col1,Col2"
 *   - col="*" => busca en TODAS las columnas del módulo (modo inteligente)
 * - like: soporta % como wildcard (SQL LIKE)
 *   - si NO trae %, se asume contains => %valor%
 * - termsMode: OPCIONAL (cuando like tiene varias palabras y col es múltiple o *)
 *   - all (default): todas las palabras deben aparecer (en cualquier columna)
 *   - any: con que aparezca una palabra
 *
 * Seguridad:
 * - x-api-key requerido si PRIVATE_API_KEY está definido.
 *
 * Instalación:
 * - npm i express googleapis dotenv
 * - node index.js
 */

require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const {
  PORT = "3000",
  SPREADSHEET_ID,

  DEFAULT_SHEET_AGENDA = "consulta_de_cita",
  /*DEFAULT_SHEET_VIH = "Horario_VIH",*/
  DEFAULT_SHEET_MEDICINAS = "inventario_medicamentos",
  /*DEFAULT_SHEET_LAB = "Catalogo_Laboratorio",
  DEFAULT_SHEET_PRIORIDAD = "Criterios_Prioridad",*/

  CACHE_TTL_MS = "60000",

  TIME_COLUMN_AGENDA = "Hora",
  TIME_COLUMN_VIH_START = "Hora Inicio",
  TIME_COLUMN_VIH_END = "Hora Fin",

  MAX_COLS = "80",
  PRIVATE_API_KEY = "",

  // ✅ estándar recomendado
  GOOGLE_APPLICATION_CREDENTIALS,
} = process.env;

console.log("Starting server with the following configuration:");
console.log({
  PORT,
  SPREADSHEET_ID,
  DEFAULT_SHEET_AGENDA,
  DEFAULT_SHEET_MEDICINAS,
  CACHE_TTL_MS,
  TIME_COLUMN_AGENDA,
  TIME_COLUMN_VIH_START,
  TIME_COLUMN_VIH_END,
  MAX_COLS,
  PRIVATE_API_KEY: PRIVATE_API_KEY ? "***" : "Not set",
  GOOGLE_APPLICATION_CREDENTIALS,
});

if (!SPREADSHEET_ID) throw new Error("Missing env SPREADSHEET_ID");
if (!GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error(
    "Missing env GOOGLE_APPLICATION_CREDENTIALS (path to service-account json)"
  );
}

const TTL = Number(CACHE_TTL_MS);
const MAX_COLS_N = Math.max(1, Number(MAX_COLS));

/** ---------------------------
 * Private auth (x-api-key)
 * -------------------------- */
function authMiddleware(req, res, next) {
  console.log("authMiddleware: Checking for API Key...");
  if (!PRIVATE_API_KEY) {
    console.log("authMiddleware: No PRIVATE_API_KEY set, access granted.");
    return next();
  }

  const provided = req.header("x-api-key");
  if (!provided) {
    console.log("authMiddleware: x-api-key header missing. Access denied.");
    return res.status(401).json({ error: "Unauthorized: Missing API Key" });
  }
  if (provided !== PRIVATE_API_KEY) {
    console.log("authMiddleware: Invalid x-api-key. Access denied.");
    return res.status(401).json({ error: "Unauthorized: Invalid API Key" });
  }
  console.log("authMiddleware: Valid API Key provided. Access granted.");
  return next();
}
app.use(authMiddleware);

/** ---------------------------
 * Cache (TTL)
 * -------------------------- */
const cache = new Map(); // key -> { exp, data }
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) {
    console.log(`cacheGet: MISS for key: ${key}`);
    return null;
  }
  if (Date.now() > v.exp) {
    console.log(`cacheGet: EXPIRED for key: ${key}`);
    cache.delete(key);
    return null;
  }
  console.log(`cacheGet: HIT for key: ${key}`);
  return v.data;
}
function cacheSet(key, data) {
  console.log(`cacheSet: SETTING for key: ${key} with TTL: ${TTL}ms`);
  cache.set(key, { exp: Date.now() + TTL, data });
}
function cacheKey(obj) {
  const key = JSON.stringify(obj);
  console.log(`cacheKey: Generated key: ${key}`);
  return key;
}

/** ---------------------------
 * Google Sheets client
 * -------------------------- */
async function getSheetsClient() {
  console.log("getSheetsClient: Creating Google Sheets client...");
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const client = await auth.getClient();
  console.log("getSheetsClient: Google Auth client obtained.");
  const sheets = google.sheets({ version: "v4", auth: client });
  console.log("getSheetsClient: Google Sheets API client created.");
  return sheets;
}

/** ---------------------------
 * Helpers
 * -------------------------- */
function okModule(module) {
  const isValid = ["medicinas", "agenda"].includes(
    module
  );
  console.log(`okModule: Validating module '${module}'. Is valid: ${isValid}`);
  return isValid;
}

function getSheetNameByModule(module) {
  let sheetName;
  switch (module) {
    case "agenda":
      sheetName = DEFAULT_SHEET_AGENDA;
      break;
    case "vih":
      sheetName = DEFAULT_SHEET_VIH;
      break;
    case "medicinas":
      sheetName = DEFAULT_SHEET_MEDICINAS;
      break;
    case "laboratorio":
      sheetName = DEFAULT_SHEET_LAB;
      break;
    case "prioridad":
      sheetName = DEFAULT_SHEET_PRIORIDAD;
      break;
    default:
      sheetName = null;
  }
  console.log(`getSheetNameByModule: Module '${module}' maps to sheet '${sheetName}'`);
  return sheetName;
}

function colToLetter(idx) {
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  // console.log(`colToLetter: Index ${idx} -> Column ${s}`);
  return s;
}

// HH:MM / HH:MM AM/PM -> "HH:MM"
function normalizeTime(input) {
  console.log(`normalizeTime: Normalizing time for input: '${input}'`);
  if (input == null) return null;
  const s = String(input).trim().toUpperCase();
  if (!s) return null;

  // 12h
  let m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ap = m[3];
    if (hh < 1 || hh > 12 || mm < 0 || mm > 59) return null;

    if (ap === "AM") {
      if (hh === 12) hh = 0;
    } else {
      if (hh !== 12) hh += 12;
    }
    const normalized = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    console.log(`normalizeTime: Converted 12h format '${s}' to 24h '${normalized}'`);
    return normalized;
  }

  // 24h
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    const normalized = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    console.log(`normalizeTime: Validated 24h format '${s}' as '${normalized}'`);
    return normalized;
  }

  console.log(`normalizeTime: Input '${input}' could not be normalized.`);
  return null;
}

function compareHHMM(a, b) {
  const result = a.localeCompare(b);
  console.log(`compareHHMM: Comparing '${a}' and '${b}'. Result: ${result}`);
  return result;
}

function buildRowObject(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    const key = headers[i] || `col_${i}`;
    obj[key] = row[i] ?? "";
  }
  // console.log("buildRowObject: Created object:", obj); // This can be very verbose
  return obj;
}

function parseFields(fieldsParam) {
  if (!fieldsParam) return [];
  const fields = String(fieldsParam)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`parseFields: Parsed fields parameter '${fieldsParam}' into:`, fields);
  return fields;
}

function filterFields(rowObj, fieldsList) {
  if (!fieldsList || fieldsList.length === 0) return rowObj;
  const out = {};
  for (const f of fieldsList) out[f] = rowObj[f] ?? "";
  // console.log("filterFields: Filtered row to:", out); // Can be verbose
  return out;
}

/**
 * col param:
 * - "*" or "all" => all columns
 * - supports separators: | or ,
 */
function parseCols(colParam) {
  if (!colParam) return [];
  const raw = String(colParam).trim();
  if (!raw) return [];
  if (raw === "*" || raw.toLowerCase() === "all") {
    console.log(`parseCols: Parsed '${colParam}' as all columns ['*']`);
    return ["*"];
  }

  const cols = raw
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`parseCols: Parsed '${colParam}' into columns:`, cols);
  return cols;
}

/**
 * Normalize text:
 * - trims
 * - collapses spaces
 * - optionally removes accents
 * - optionally lowercases
 */
function normalizeText(s, { caseSensitive, accentSensitive }) {
  let out = String(s ?? "");
  out = out.trim().replace(/\s+/g, " ");

  if (!accentSensitive) {
    // Remove diacritics
    out = out.normalize("NFD").replace(/\p{M}/gu, "");
  }
  if (!caseSensitive) out = out.toLowerCase();
  return out;
}

/**
 * LIKE -> Regex
 * - supports % wildcard
 * - if no %, assume contains => %value%
 * - NOTE: no ^$ anchoring so it behaves as "contains" by default
 */
function likeToRegex(likePattern, { caseSensitive }) {
  let raw = String(likePattern ?? "").trim();
  console.log(`likeToRegex: Initial pattern: '${raw}', caseSensitive: ${caseSensitive}`);

  // If user doesn't use %, assume contains
  if (!raw.includes("%")) {
    raw = `%${raw}%`;
    console.log(`likeToRegex: No '%' found, wrapping pattern: '${raw}'`);
  }

  // Escape regex special chars except %
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Replace % => .*
  const regexStr = escaped.replace(/%/g, ".*");
  console.log(`likeToRegex: Final regex string: '${regexStr}'`);

  return new RegExp(regexStr, caseSensitive ? "" : "i");
}

/**
 * Smart LIKE filter
 * - Supports multi-column search
 * - If like has multiple words, we "split" into terms and match partially
 *   across columns using termsMode=all|any.
 *
 * Important:
 * - Your case "amoxicilina 500mg" fails on col=Medicamento only because "500mg"
 *   is in Presentación. Use col=Medicamento|Presentación or col=*.
 */
function applyLikeFilter(rows, colNames, likePattern, opts) {
  console.log("applyLikeFilter: Applying filter with options:", { colNames, likePattern, opts });
  const {
    caseSensitive,
    accentSensitive,
    termsMode = "all", // all|any
  } = opts;

  // Normalize pattern for "terms"
  const likeNorm = normalizeText(likePattern, { caseSensitive, accentSensitive });
  console.log(`applyLikeFilter: Normalized LIKE pattern: '${likeNorm}'`);

  // Split into terms (words) for smart matching
  const terms = likeNorm.split(/\s+/).filter(Boolean);
  console.log(`applyLikeFilter: Split into terms:`, terms);

  // Regex for classic LIKE matching (supports %)
  const rx = likeToRegex(likeNorm, { caseSensitive: true }); // already normalized strings, so keep caseSensitive true here

  const byRegex = (r) => {
    // If pattern has %, use regex semantics across columns.
    // But since we convert non-% to %...%, this will always be "contains" anyway.
    const normalizedCells = colNames.map((c) =>
      normalizeText(r[c], { caseSensitive, accentSensitive })
    );
    const isMatch = normalizedCells.some((cell) => rx.test(cell));
    // console.log(`byRegex: Row ${JSON.stringify(r)} match: ${isMatch}`);
    return isMatch;
  };

  const byTerms = (r) => {
    const normalizedCells = colNames.map((c) =>
      normalizeText(r[c], { caseSensitive, accentSensitive })
    );

    if (!terms.length) return true;

    let isMatch;
    if (termsMode === "any") {
      isMatch = terms.some((t) => normalizedCells.some((cell) => cell.includes(t)));
    } else {
      // default all
      isMatch = terms.every((t) => normalizedCells.some((cell) => cell.includes(t)));
    }
    // console.log(`byTerms (${termsMode}): Row ${JSON.stringify(r)} match: ${isMatch}`);
    return isMatch;
  };

  // Strategy:
  // - If pattern contains explicit % wildcards -> use regex matching (classic LIKE)
  // - Else (typical user phrase) -> use terms matching for "intelligent" behavior
  const hasWildcard = String(likePattern).includes("%");
  console.log(`applyLikeFilter: Strategy decision - hasWildcard: ${hasWildcard}. Using ${hasWildcard ? 'byRegex' : 'byTerms'}`);

  const filteredRows = rows.filter((r) => (hasWildcard ? byRegex(r) : byTerms(r)));
  console.log(`applyLikeFilter: Filtered ${rows.length} rows down to ${filteredRows.length}`);
  return filteredRows;
}

async function getHeaders(sheets, sheetName) {
  console.log(`getHeaders: Requesting headers for sheet: '${sheetName}'`);
  const key = cacheKey({ type: "headers", sheetName });
  const cached = cacheGet(key);
  if (cached) {
    console.log("getHeaders: Headers found in cache.");
    return { headers: cached, headersCache: "HIT" };
  }
  console.log("getHeaders: Headers not in cache, fetching from Google Sheets.");

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!1:1`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const headers = (resp.data.values?.[0] || []).map((h) => String(h).trim());
  console.log("getHeaders: Fetched headers:", headers);
  cacheSet(key, headers);
  return { headers, headersCache: "MISS" };
}

async function readWholeSheet(sheets, sheetName, headers) {
  const colCount = Math.min(
    Math.max(headers.length, 1),
    Math.max(MAX_COLS_N, 1)
  );
  const lastColLetter = colToLetter(colCount - 1);
  console.log(`readWholeSheet: Reading sheet '${sheetName}' up to column ${lastColLetter} (count: ${colCount})`);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:${lastColLetter}`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const values = resp.data.values || [];
  console.log(`readWholeSheet: Received ${values.length} total rows (including header).`);
  if (values.length < 2) {
    console.log("readWholeSheet: No data rows found.");
    return [];
  }

  const dataRows = values.slice(1).map((r) => buildRowObject(headers, r));
  console.log(`readWholeSheet: Processed ${dataRows.length} data rows.`);
  return dataRows;
}

/** ---------------------------
 * Routes
 * -------------------------- */
app.get("/health", (req, res) => {
  console.log("Health check endpoint hit.");
  res.json({ ok: true, service: "fundase-sheets-backend" });
});

app.get("/v1/fundase/modules", (req, res) => {
  console.log("Modules endpoint hit.");
  res.json({
    modules: {
      agenda: DEFAULT_SHEET_AGENDA,
      vih: DEFAULT_SHEET_VIH,
      medicinas: DEFAULT_SHEET_MEDICINAS,
      laboratorio: DEFAULT_SHEET_LAB,
      prioridad: DEFAULT_SHEET_PRIORIDAD,
    },
  });
});

/**
 * Main endpoint
 *
 * Examples:
 * - All rows:
 *   /v1/fundase?module=medicinas
 *
 * - Agenda by time:
 *   /v1/fundase?module=agenda&time=08:00
 *
 * - Multi-word phrase across all columns:
 *   /v1/fundase?module=medicinas&col=*&like=amoxicilina 500mg
 *
 * - Multi-columns:
 *   /v1/fundase?module=medicinas&col=Medicamento|Presentación&like=amoxicilina 500mg
 *
 * - Classic LIKE with %:
 *   /v1/fundase?module=medicinas&col=Medicamento&like=%amoxicilina%
 */
app.get("/v1/fundase", async (req, res) => {
  console.log("\n--- New Request to /v1/fundase ---");
  console.log("Request Query:", req.query);

  try {
    // ✅ module is mandatory
    const module = req.query.module
      ? String(req.query.module).toLowerCase().trim()
      : "";
    console.log(`Parsed module: '${module}'`);

    if (!module) {
      console.log("Validation FAIL: Module is missing.");
      return res.status(400).json({
        error: "Missing required query param: module",
        allowed: ["agenda", "vih", "medicinas", "laboratorio", "prioridad"],
      });
    }
    if (!okModule(module)) {
      console.log("Validation FAIL: Module is invalid.");
      return res.status(400).json({
        error: "Invalid module",
        allowed: ["agenda", "vih", "medicinas", "laboratorio", "prioridad"],
      });
    }

    const sheetName = getSheetNameByModule(module);

    // time optional
    const timeRaw = req.query.time;
    const timeNorm = timeRaw ? normalizeTime(timeRaw) : null;
    console.log(`Parsed time: raw='${timeRaw}', normalized='${timeNorm}'`);
    if (timeRaw && !timeNorm) {
      console.log("Validation FAIL: Invalid time format.");
      return res.status(400).json({
        error: "Invalid time format",
        hint: "Use HH:MM or HH:MM AM/PM (e.g. 09:00 or 9:00 AM)",
      });
    }

    // col/like optional but paired
    const cols = parseCols(req.query.col);
    const like = req.query.like ? String(req.query.like) : "";
    console.log(`Parsed filter: cols=${JSON.stringify(cols)}, like='${like}'`);
    if ((cols.length > 0 && !like) || (cols.length === 0 && like)) {
      console.log("Validation FAIL: 'col' and 'like' are not correctly paired.");
      return res.status(400).json({
        error: "Filter requires both 'col' and 'like'",
        example:
          "module=medicinas&col=Medicamento|Presentación&like=amoxicilina 500mg",
        tip: "Use col=* to search across all columns when you don't know where the terms are.",
      });
    }

    // termsMode for multi-word phrase behavior
    const termsModeRaw = String(req.query.termsMode || "all").toLowerCase();
    const termsMode = termsModeRaw === "any" ? "any" : "all";
    console.log(`Parsed termsMode: '${termsMode}'`);

    // case & accent sensitivity
    const caseSensitive =
      String(req.query.caseSensitive || "false").toLowerCase() === "true";
    const accentSensitive =
      String(req.query.accentSensitive || "false").toLowerCase() === "true"; // default false (ignore accents)
    console.log(`Parsed sensitivity: case=${caseSensitive}, accent=${accentSensitive}`);

    const fields = parseFields(req.query.fields);

    const key = cacheKey({
      type: "query",
      module,
      sheetName,
      time: timeNorm,
      cols,
      like,
      termsMode,
      caseSensitive,
      accentSensitive,
      fields,
    });

    const cached = cacheGet(key);
    if (cached) {
      console.log("--- Request Complete (from cache) ---");
      return res.json({ ...cached, cache: "HIT" });
    }

    const sheets = await getSheetsClient();
    const { headers, headersCache } = await getHeaders(sheets, sheetName);
    console.log(`Headers loaded (cache status: ${headersCache}). Headers:`, headers);

    if (!headers || headers.length === 0) {
      console.log("No headers found for this sheet. Returning empty result set.");
      const out = {
        spreadsheetId: SPREADSHEET_ID,
        module,
        sheet: sheetName,
        time: timeNorm,
        likeFilter:
          cols.length && like
            ? { cols, like, termsMode, caseSensitive, accentSensitive }
            : null,
        fields: fields.length ? fields : null,
        count: 0,
        rows: [],
        meta: { headersCache },
      };
      cacheSet(key, out);
      console.log("--- Request Complete (no headers) ---");
      return res.json({ ...out, cache: "MISS" });
    }

    let rows = await readWholeSheet(sheets, sheetName, headers);

    // Optional time filter only for agenda & vih
    if (module === "agenda" && timeNorm) {
      console.log(`Applying time filter for 'agenda' with time '${timeNorm}'`);
      const timeHeader = headers.find(
        (h) => h.toLowerCase() === TIME_COLUMN_AGENDA.toLowerCase()
      );
      if (!timeHeader) {
        console.log(`Validation FAIL: Time column '${TIME_COLUMN_AGENDA}' not found for agenda.`);
        return res.status(400).json({
          error: `Time column not found for agenda. Expected "${TIME_COLUMN_AGENDA}"`,
          headers,
        });
      }
      const initialRowCount = rows.length;
      rows = rows.filter((r) => normalizeTime(r[timeHeader]) === timeNorm);
      console.log(`Time filter applied. ${initialRowCount} -> ${rows.length} rows.`);
    }

    if (module === "vih" && timeNorm) {
      console.log(`Applying time filter for 'vih' with time '${timeNorm}'`);
      const startHeader = headers.find(
        (h) => h.toLowerCase() === TIME_COLUMN_VIH_START.toLowerCase()
      );
      const endHeader = headers.find(
        (h) => h.toLowerCase() === TIME_COLUMN_VIH_END.toLowerCase()
      );

      if (!startHeader || !endHeader) {
        console.log(`Validation FAIL: VIH time range columns not found. Expected "${TIME_COLUMN_VIH_START}" and "${TIME_COLUMN_VIH_END}"`);
        return res.status(400).json({
          error: `VIH time range columns not found. Expected "${TIME_COLUMN_VIH_START}" and "${TIME_COLUMN_VIH_END}"`,
          headers,
        });
      }

      const initialRowCount = rows.length;
      rows = rows.filter((r) => {
        const start = normalizeTime(r[startHeader]);
        const end = normalizeTime(r[endHeader]);
        if (!start || !end) return false;
        return compareHHMM(timeNorm, start) >= 0 && compareHHMM(timeNorm, end) <= 0;
      });
      console.log(`Time filter applied. ${initialRowCount} -> ${rows.length} rows.`);
    }

    // LIKE filter (optional)
    if (cols.length && like) {
      console.log("Applying LIKE filter.");
      // Expand col=* to all headers
      const effectiveCols = cols.length === 1 && cols[0] === "*" ? headers : cols;
      console.log("Effective columns for LIKE filter:", effectiveCols);

      // Validate columns exist
      const missing = effectiveCols.filter((c) => !headers.includes(c));
      if (missing.length) {
        console.log("Validation FAIL: LIKE filter column(s) not found:", missing);
        return res.status(400).json({
          error: "Column(s) not found",
          missing,
          headers,
          hint: "col must match EXACTLY the header name. Use col=* to search all columns.",
        });
      }

      rows = applyLikeFilter(rows, effectiveCols, like, {
        caseSensitive,
        accentSensitive,
        termsMode,
      });
    }

    // fields projection (optional)
    if (fields.length) {
      console.log("Applying fields projection:", fields);
      const initialRowCount = rows.length;
      rows = rows.map((r) => filterFields(r, fields));
      console.log(`Fields projection applied to ${initialRowCount} rows.`);
    }

    const out = {
      spreadsheetId: SPREADSHEET_ID,
      module,
      sheet: sheetName,
      time: timeNorm,
      likeFilter:
        cols.length && like
          ? { cols, like, termsMode, caseSensitive, accentSensitive }
          : null,
      fields: fields.length ? fields : null,
      count: rows.length,
      rows,
      meta: { headersCache },
    };
    console.log(`Final result count: ${rows.length}. Caching and sending response.`);

    cacheSet(key, out);
    console.log("--- Request Complete (from source) ---");
    return res.json({ ...out, cache: "MISS" });
  } catch (err) {
    console.error("!!! INTERNAL SERVER ERROR !!!");
    console.error(err);
    console.log("--- Request Failed ---");
    return res.status(500).json({
      error: "Internal error",
      detail: err?.message || String(err),
    });
  }
});

app.listen(Number(PORT), () => {
  console.log(`\n🚀 FUNDASE private backend running on http://localhost:${PORT}`);
  console.log("Awaiting requests...");
});