// src/index.js
require('dotenv').config();
const express = require('express');
const OAuth2Server = require('oauth2-server');
const model = require('./oauthModel');
const { encrypt, decrypt } = require('./utils/crypto');
const authMiddleware = require('./middleware/auth'); // ← Importar
const pool = require('./db.js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const cors = require('cors');

const crypto = require('crypto');
const { promisify } = require('util');
const genSalt = promisify(crypto.randomBytes);


const allowedOrigins = new Set([
  'https://cloud.bizzfront.com',
  'https://adminapi.bizzfront.com',
  'http://localhost:8080' // por ejemplo en dev
]);


const pgCryptoHash = async (plainText) => {
  const saltRounds = 10;
  const hash = await bcrypt.hash(plainText, saltRounds);
  return hash;
};

app.use(cors({
  origin: (origin, callback) => {
    // allow requests with no origin (e.g. mobile apps, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS no permitido por origen: ${origin}`));
    }
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

// Para parsear JSON
app.use(express.json());
// Para parsear bodies application/x-www-form-urlencoded (OAuth2 requiere esto)
app.use(express.urlencoded({ extended: true }));

// Configuramos el servidor OAuth2
app.oauth = new OAuth2Server({
  model,
  allowBearerTokensInQueryString: true
});

// --- Middleware para rutas protegidas ---
const authenticate = async (req, res, next) => {
  const request  = new OAuth2Server.Request(req);
  const response = new OAuth2Server.Response(res);
  try {
    const oauthUser = await app.oauth.authenticate(request, response);
    // opcional: lo dejo en req.user
    req.user = oauthUser;
    next();
  } catch (err) {
    res.status(err.code || 401).json(err);
  }
};

// --- Endpoint de token OAuth2 ---
app.post('/oauth/token', async (req, res, next) => {
  const request  = new OAuth2Server.Request(req);
  const response = new OAuth2Server.Response(res);
  try {
    const token = await app.oauth.token(request, response);
    // Devuelvo el token en JSON
    res.json(token);
  } catch (err) {
    res.status(err.code || 500).json(err);
  }
});

// --- Endpoint para autenticar al bot
app.post('/oauth/bot-token', async (req, res) => {
  const { client_id, client_secret, assistant_id } = req.body;
  if (!client_id || !client_secret || !assistant_id)
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM security.bot_clients 
       WHERE client_id = $1 AND assistant_id = $2 AND enabled = true`,
      [client_id, assistant_id]
    );
    const client = rows[0];
    if (!client)
      return res.status(401).json({ error: 'Cliente no válido o inactivo.' });

    const match = await bcrypt.compare(client_secret, client.client_secret_hash);
    if (!match)
      return res.status(401).json({ error: 'Credenciales incorrectas.' });

    const payload = {
      sub: client.client_id,
      bizz: client.bizz_id,
      assistant: client.assistant_id,
      scope: client.scope
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600
    });
  } catch (err) {
    console.error('Error en /oauth/bot-token:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});



// Endpoint para revocar refresh tokens
app.post('/oauth/revoke', async (req, res) => {
  const refreshToken = req.body.refresh_token;
  if (!refreshToken) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Falta parámetro refresh_token'
    });
  }
  try {
    const revoked = await model.revokeToken({ refreshToken });
    if (!revoked) {
      return res.status(404).json({
        error: 'invalid_token',
        error_description: 'Refresh token no encontrado o ya revocado'
      });
    }
    // Éxito: no hay body o un mensaje simple
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({
      error: 'server_error',
      error_description: err.message
    });
  }
});

// POST /api/v1/user/email-notif-config
app.post(`/bizz/email-notif-config`, authMiddleware, async (req, res) => {
	console.log(req.user)
  // req.user.bizz llega de tu middleware JWT
  const { bizz: bizz_id } = req.user || {};
  console.log(bizz_id)
  const { host, port, secure, user, pass, from, to } = req.body;
  if (!bizz_id || !host || !port || !user || !pass) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }

  // Ciframos credenciales
  const encrypted = {
	  host: encrypt(req.body.host),
	  port: req.body.port,
	  secure: req.body.secure,
	  user: encrypt(req.body.user),
	  pass: encrypt(req.body.pass),
	  from: encrypt(from), // ← nuevo
	  to: encrypt(to)      // ← nuevo
	};


  // Insert o update en bizz_configs
  await pool.query(
    `INSERT INTO security.bizz_configs(bizz_id, email_nots_config)
       VALUES($1, $2)
     ON CONFLICT (bizz_id) DO
       UPDATE SET email_nots_config = $2;`,
    [bizz_id, JSON.stringify(encrypted)]
  );

  return res.json({ success: true });
});

app.get(`/bizz/email-notif-config`, authMiddleware, async (req, res) => {
  const { bizz: bizz_id } = req.user || {};
  if (!bizz_id) {
    return res.status(400).json({ error: 'bizz_id obligatorio en token.' });
  }

  const { rows } = await pool.query(
    'SELECT email_nots_config FROM security.bizz_configs WHERE bizz_id = $1',
    [bizz_id]
  );
  if (rows.length === 0 || !rows[0].email_nots_config) {
    return res.status(404).json({ error: 'Configuración de e-mail no encontrada.' });
  }

  let stored;
  try {
    stored = JSON.parse(rows[0].email_nots_config);
  } catch {
    return res.status(500).json({ error: 'Formato inválido de configuración.' });
  }

  // Desciframos
  let cfg;
  try {
    cfg = {
      host:   stored.host,
      port:   stored.port,
      secure: stored.secure,
      user:   stored.user,
      pass:   stored.pass,
	  from:	stored.from, // ← nuevo
	  to:	stored.to      // ← nuevo
    };
  } catch {
    return res.status(500).json({ error: 'Error al descifrar credenciales.' });
  }

  return res.json(cfg);
});

app.get(`/bizz/email-notif-config-decrypt`, authMiddleware, async (req, res) => {
  const { bizz: bizz_id } = req.user || {};
  if (!bizz_id) {
    return res.status(400).json({ error: 'bizz_id obligatorio en token.' });
  }

  const { rows } = await pool.query(
    'SELECT email_nots_config FROM security.bizz_configs WHERE bizz_id = $1',
    [bizz_id]
  );
  if (rows.length === 0 || !rows[0].email_nots_config) {
    return res.status(404).json({ error: 'Configuración de e-mail no encontrada.' });
  }

  let stored;
  try {
    stored = JSON.parse(rows[0].email_nots_config);
  } catch {
    return res.status(500).json({ error: 'Formato inválido de configuración.' });
  }

  // Desciframos
  let cfg;
  try {
    cfg = {
      host:   decrypt(stored.host),
      port:   stored.port,
      secure: stored.secure,
      user:   decrypt(stored.user),
      pass:   decrypt(stored.pass),
	  from:   decrypt(stored.from),
      to:   decrypt(stored.to),
    };
  } catch {
    return res.status(500).json({ error: 'Error al descifrar credenciales.' });
  }

  return res.json(cfg);
});

// Ejemplo de ruta protegida
app.get('/secure-data', authenticate, (req, res) => {
  res.json({
    message: 'Acceso autorizado',
    user: req.user
  });
});

// Ejemplo de ruta protegida
app.get('/health', (req, res) => {
  res.json({
    message: 'Is alive!',
    user: 'None'
  });
});

// POST /bot-clients/register
app.post('/bot-clients/register', authMiddleware, async (req, res) => {
  const { assistant_id, client_id, client_secret, scope } = req.body;
  const { bizz } = req.user || {};
  
  console.log('req.body is: ', req.body)
  console.log('bizz is: ', bizz)

  if (!bizz || !assistant_id || !client_id || !client_secret) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

  try {
    const client_secret_hash = await pgCryptoHash(client_secret);

    await pool.query(
	  `INSERT INTO security.bot_clients (client_id, client_secret_hash, bizz_id, assistant_id, scope)
	   VALUES ($1, $2, $3, $4, $5)
	   ON CONFLICT (client_id) DO UPDATE
	   SET client_secret_hash = EXCLUDED.client_secret_hash,
		   assistant_id = EXCLUDED.assistant_id,
		   scope = EXCLUDED.scope`,
	  [client_id, client_secret_hash, bizz, assistant_id, scope]
	);

    res.status(201).json({ success: true, message: 'Bot registrado exitosamente' });
  } catch (err) {
    console.error('Error registrando bot:', err);
    res.status(500).json({ error: 'Error interno al registrar bot' });
  }
});

// POST /api/v1/user/channels-config
app.post(`/bizz/assitants/channels-config`, authMiddleware, async (req, res) => {
	console.log(req.user)
	// req.user.bizz llega de tu middleware JWT
	const { bizz: bizz_id } = req.user || {};
	console.log(bizz_id)
	const { assistant_id, whatsapp, facebook, instagram, whatsapp_url, facebook_url, instagram_url } = req.body;
	if (!bizz_id || !assistant_id || !whatsapp || !facebook || !instagram) {
		return res.status(400).json({ error: 'Faltan datos obligatorios.' });
	}

	// Ciframos credenciales
	const encrypted = {
		whatsapp: encrypt(whatsapp),
		facebook: encrypt(facebook),
		instagram: encrypt(instagram),
		whatsapp_url: encrypt(whatsapp_url),
		facebook_url: encrypt(facebook_url),
		instagram_url: encrypt(instagram_url)
	};

	// Insert o update en assitant_configs
	await pool.query(
	  `INSERT INTO security.assistant_configs (bizz_id, assistant_id, channel_config)
		   VALUES ($1, $2, $3)
	   ON CONFLICT (bizz_id, assistant_id)
		   DO UPDATE SET channel_config = $3;`,
	  [bizz_id, assistant_id, JSON.stringify(encrypted)]
	);

  return res.json({ success: true });
});

app.post(`/bizz/intents_config_leads`, authMiddleware, async (req, res) => {
  const { bizz: bizz_id } = req.user || {};
  const intentsConfigLeads = req.body;

  if (!bizz_id) {
    return res.status(400).json({ error: 'bizz_id obligatorio en token.' });
  }

  if (
    !intentsConfigLeads ||
    (typeof intentsConfigLeads === 'object' && Object.keys(intentsConfigLeads).length === 0)
  ) {
    return res.status(400).json({ error: 'Configuracion intents_config_leads obligatoria.' });
  }

  await pool.query(
    `INSERT INTO security.bizz_configs(bizz_id, intents_config_leads)
       VALUES($1, $2)
     ON CONFLICT (bizz_id) DO
       UPDATE SET intents_config_leads = $2;`,
    [bizz_id, JSON.stringify(intentsConfigLeads)]
  );

  return res.json({ success: true });
});

app.get(`/bizz/intents_config_leads`, authMiddleware, async (req, res) => {
  const { bizz: bizz_id } = req.user || {};
  if (!bizz_id) {
    return res.status(400).json({ error: 'bizz_id obligatorio en token.' });
  }

  const { rows } = await pool.query(
    'SELECT intents_config_leads FROM security.bizz_configs WHERE bizz_id = $1',
    [bizz_id]
  );
  if (rows.length === 0 || !rows[0].intents_config_leads) {
    return res.status(404).json({ error: 'Configuracion intents_config_leads no encontrada.' });
  }

  try {
    return res.json(JSON.parse(rows[0].intents_config_leads));
  } catch {
    return res.status(500).json({ error: 'Formato invalido de intents_config_leads.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Auth service escuchando en puerto ${PORT}`));
