/**
 * FUNDASE Private Backend - Google Sheets Reader API (CommonJS)
 *
 * Obligatorio:
 *  - module: agenda|vih|medicinas|laboratorio|prioridad
 *
 * Opcional:
 *  - time: HH:MM or HH:MM AM/PM (solo afecta agenda y vih)
 *  - col: uno o varios headers exactos separados por | o , (ej: Médico|Especialidad)
 *  - like: patrón tipo SQL LIKE (soporta % como wildcard)
 *  - caseSensitive: true|false (default false)
 *  - fields: lista de headers a devolver (comma-separated)
 *
 * Por defecto:
 *  - sin col+like => devuelve todas las filas (o todas las de la hora si time aplica)
 */

require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const {
  PORT = "3000",
  HOST = 'http://localhost',
  SPREADSHEET_ID,
  DEFAULT_SHEET_AGENDA = "Agenda_Citas",
  DEFAULT_SHEET_VIH = "Horario_VIH",
  DEFAULT_SHEET_MEDICINAS = "Inventario_Medicinas",
  DEFAULT_SHEET_LAB = "Catalogo_Laboratorio",
  DEFAULT_SHEET_PRIORIDAD = "Criterios_Prioridad",
  DEFAULT_SHEET_SEDES = "Sedes",
  CACHE_TTL_MS = "60000",
  TIME_COLUMN_AGENDA = "Hora",
  TIME_COLUMN_VIH_START = "Hora Inicio",
  TIME_COLUMN_VIH_END = "Hora Fin",
  MAX_COLS = "80",
  PRIVATE_API_KEY = "",
  GOOGLE_APPLICATION_CREDENTIALS,
} = process.env;

if (!SPREADSHEET_ID) throw new Error("Missing env SPREADSHEET_ID");
if (!GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error("Missing env GOOGLE_APPLICATION_CREDENTIALS (path to service-account json)");
}

const TTL = Number(CACHE_TTL_MS);
const MAX_COLS_N = Math.max(1, Number(MAX_COLS));

/** -------- Private auth -------- */
function authMiddleware(req, res, next) {
  console.log("authMiddleware: Enter");
  // si quieres health público, descomenta:
  // if (req.path === "/health") return next();

  if (!PRIVATE_API_KEY) {
    console.log("authMiddleware: No PRIVATE_API_KEY set, skipping auth");
    return next();
  }

  const provided = req.header("x-api-key");
  console.log(`authMiddleware: Provided x-api-key: ${provided}`);
  if (!provided || provided !== PRIVATE_API_KEY) {
    console.error("authMiddleware: Unauthorized access");
    return res.status(401).json({ error: "Unauthorized" });
  }
  console.log("authMiddleware: Authorized");
  return next();
}
app.use(authMiddleware);

/** -------- Cache -------- */
const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    cache.delete(key);
    return null;
  }
  return v.data;
}
function cacheSet(key, data) {
  cache.set(key, { exp: Date.now() + TTL, data });
}
function cacheKey(obj) {
  return JSON.stringify(obj);
}

/** -------- Google Sheets client -------- */
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

/** -------- Helpers -------- */
function colToLetter(idx) {
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normalizeTime(input) {
  if (input == null) return null;
  const s = String(input).trim().toUpperCase();
  if (!s) return null;

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
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  return null;
}

function compareHHMM(a, b) {
  return a.localeCompare(b);
}

function buildRowObject(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    const key = headers[i] || `col_${i}`;
    obj[key] = row[i] ?? "";
  }
  return obj;
}

function parseFields(fieldsParam) {
  if (!fieldsParam) return [];
  return String(fieldsParam)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function filterFields(rowObj, fieldsList) {
  if (!fieldsList || fieldsList.length === 0) return rowObj;
  const out = {};
  for (const f of fieldsList) out[f] = rowObj[f] ?? "";
  return out;
}

function okModule(module) {
  return ["agenda", "vih", "medicinas", "laboratorio", "prioridad", "sedes"].includes(module);
}

function getSheetNameByModule(module) {
  switch (module) {
    case "agenda":
      return DEFAULT_SHEET_AGENDA;
    case "vih":
      return DEFAULT_SHEET_VIH;
    case "medicinas":
      return DEFAULT_SHEET_MEDICINAS;
    case "laboratorio":
      return DEFAULT_SHEET_LAB;
    case "prioridad":
      return DEFAULT_SHEET_PRIORIDAD;
    case "sedes":
      return DEFAULT_SHEET_SEDES;
    default:
      return null;
  }
}

function normalizeText(s, { caseSensitive, accentSensitive }) {
  let out = String(s ?? "");

  // normaliza espacios
  out = out.trim().replace(/\s+/g, " ");

  // quitar acentos si accentSensitive=false
  // (NFD separa letras+diacríticos, luego removemos marcas \p{M})
  if (!accentSensitive) {
    out = out.normalize("NFD").replace(/\p{M}/gu, "");
  }

  if (!caseSensitive) out = out.toLowerCase();

  return out;
}

/**
 * LIKE mejorado:
 * - Soporta % como wildcard.
 * - Si el usuario NO pone %, asumimos "contiene" => %valor%
 * - No usamos ^$ cuando es contains.
 */
function likeToRegex(likePattern, { caseSensitive }) {
  let raw = String(likePattern ?? "").trim();

  // ✅ Si no trae %, asumimos contains
  if (!raw.includes("%")) {
    raw = `%${raw}%`;
  }

  // Escape regex special chars excepto %
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // % => .*
  const regexStr = escaped.replace(/%/g, ".*");

  return new RegExp(regexStr, caseSensitive ? "" : "i");
}


function parseCols(colParam) {
  if (!colParam) return [];
  return String(colParam)
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyLikeFilter(rows, colNames, likePattern, opts) {
  const { caseSensitive, accentSensitive } = opts;

  const rx = likeToRegex(
    // ojo: likeToRegex ya se ocupa de % y case
    likePattern,
    { caseSensitive }
  );

  // OR entre columnas: si alguna columna hace match, la fila queda.
  return rows.filter((r) => colNames.some((colName) => {
    const cell = normalizeText(r[colName], { caseSensitive, accentSensitive });
    // si caseSensitive=false, rx ya trae /i, pero cell ya está lower; no pasa nada.
    return rx.test(cell);
  }));
}

async function getHeaders(sheets, sheetName) {
  const headerCacheKey = cacheKey({ type: "headers", sheetName });
  const cached = cacheGet(headerCacheKey);
  if (cached) return { headers: cached, cache: "HIT" };

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!1:1`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const headers = (resp.data.values?.[0] || []).map((h) => String(h).trim());
  cacheSet(headerCacheKey, headers);
  return { headers, cache: "MISS" };
}

async function readWholeSheet(sheets, sheetName, headers) {
  const colCount = Math.min(Math.max(headers.length, 1), Math.max(MAX_COLS_N, 1));
  const lastColLetter = colToLetter(colCount - 1);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:${lastColLetter}`,
    valueRenderOption: "FORMATTED_VALUE",
  });

  const values = resp.data.values || [];
  if (values.length < 2) return [];

  const dataRows = values.slice(1);
  return dataRows.map((r) => buildRowObject(headers, r));
}

/** -------- Routes -------- */
app.get("/health", (req, res) => res.json({ ok: true, service: "fundase-sheets-backend" }));

app.get("/v1/fundase/modules", (req, res) => {
  res.json({
    modules: {
      agenda: DEFAULT_SHEET_AGENDA,
      vih: DEFAULT_SHEET_VIH,
      medicinas: DEFAULT_SHEET_MEDICINAS,
      laboratorio: DEFAULT_SHEET_LAB,
      prioridad: DEFAULT_SHEET_PRIORIDAD,
      sedes: DEFAULT_SHEET_SEDES,
    },
  });
});

/**
 * Main endpoint
 * module is REQUIRED
 */
app.get("/v1/fundase", async (req, res) => {
  try {
    const module = req.query.module ? String(req.query.module).toLowerCase() : "";
    if (!module) {
      return res.status(400).json({
        error: "Missing required query param: module",
        allowed: ["agenda", "vih", "medicinas", "laboratorio", "prioridad", "sedes"],
      });
    }
    if (!okModule(module)) {
      return res.status(400).json({
        error: "Invalid module",
        allowed: ["agenda", "vih", "medicinas", "laboratorio", "prioridad", "sedes"],
      });
    }

    const sheetName = getSheetNameByModule(module);

    // time is OPTIONAL, but if present must be valid.
    const timeRaw = req.query.time;
    const timeNorm = timeRaw ? normalizeTime(timeRaw) : null;
    if (timeRaw && !timeNorm) {
      return res.status(400).json({
        error: "Invalid time format",
        hint: "Use HH:MM or HH:MM AM/PM (e.g. 09:00 or 9:00 AM)",
      });
    }

    // LIKE filter params
    const colRaw = req.query.col ? String(req.query.col) : "";
    const cols = parseCols(colRaw);
    const like = req.query.like ? String(req.query.like) : "";

    // If one is provided, both must be provided
    if ((cols.length && !like) || (!cols.length && like)) {
      return res.status(400).json({
        error: "LIKE filter requires both 'col' and 'like'",
        example: "module=agenda&time=08:00&col=Médico&like=%López%",
      });
    }

    const caseSensitive = String(req.query.caseSensitive || "false").toLowerCase() === "true";
    const fields = parseFields(req.query.fields);

    const reqKey = cacheKey({
      type: "query",
      module,
      sheetName,
      time: timeNorm,
      cols,
      like,
      caseSensitive,
      fields,
    });

    const cached = cacheGet(reqKey);
    if (cached) return res.json({ ...cached, cache: "HIT" });

    const sheets = await getSheetsClient();
    const { headers, cache: headerCache } = await getHeaders(sheets, sheetName);

    if (!headers || headers.length === 0) {
      const out = {
        spreadsheetId: SPREADSHEET_ID,
        module,
        sheet: sheetName,
        time: timeNorm,
        likeFilter: cols.length ? { cols, like, caseSensitive } : null,
        fields: fields.length ? fields : null,
        count: 0,
        rows: [],
        meta: { headersCache: headerCache },
      };
      cacheSet(reqKey, out);
      return res.json({ ...out, cache: "MISS" });
    }

    // Validate columns exist if using LIKE
    if (cols.length) {
      const missingCols = cols.filter((col) => !headers.some((h) => h === col));
      if (missingCols.length) {
        return res.status(400).json({
          error: "Column not found",
          col: colRaw,
          missingCols,
          headers,
          hint: "col must match EXACTLY one or more header names in the sheet. Use | or , to separate multiple columns.",
        });
      }
    }

    let rows = await readWholeSheet(sheets, sheetName, headers);

    // ---- optional time filter only for agenda/vih ----
    if (module === "agenda" && timeNorm) {
      const timeHeader = headers.find((h) => h.toLowerCase() === TIME_COLUMN_AGENDA.toLowerCase());
      if (!timeHeader) {
        return res.status(400).json({
          error: `Time column not found for agenda. Expected "${TIME_COLUMN_AGENDA}"`,
          headers,
        });
      }
      rows = rows.filter((r) => normalizeTime(r[timeHeader]) === timeNorm);
    }

    if (module === "vih" && timeNorm) {
      const startHeader = headers.find((h) => h.toLowerCase() === TIME_COLUMN_VIH_START.toLowerCase());
      const endHeader = headers.find((h) => h.toLowerCase() === TIME_COLUMN_VIH_END.toLowerCase());

      if (!startHeader || !endHeader) {
        return res.status(400).json({
          error: `VIH time range columns not found. Expected "${TIME_COLUMN_VIH_START}" and "${TIME_COLUMN_VIH_END}"`,
          headers,
        });
      }

      rows = rows.filter((r) => {
        const start = normalizeTime(r[startHeader]);
        const end = normalizeTime(r[endHeader]);
        if (!start || !end) return false;
        return compareHHMM(timeNorm, start) >= 0 && compareHHMM(timeNorm, end) <= 0;
      });
    }

    // ---- optional LIKE filter ----
    if (cols.length && like) {
      rows = applyLikeFilter(rows, cols, like, { caseSensitive, accentSensitive: false });
    }

    // ---- optional fields projection ----
    if (fields.length) {
      rows = rows.map((r) => filterFields(r, fields));
    }

    const out = {
      spreadsheetId: SPREADSHEET_ID,
      module,
      sheet: sheetName,
      time: timeNorm,
      likeFilter: cols.length ? { cols, like, caseSensitive } : null,
      fields: fields.length ? fields : null,
      count: rows.length,
      rows,
      meta: { headersCache: headerCache },
    };

    cacheSet(reqKey, out);
    return res.json({ ...out, cache: "MISS" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal error", detail: err?.message || String(err) });
  }
});

app.listen(Number(PORT, HOST), () => {
  console.log(`FUNDASE private backend running on http://localhost:${PORT}`);
});