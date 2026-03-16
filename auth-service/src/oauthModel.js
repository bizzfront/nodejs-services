const pool = require('./db');
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');

const model = {
  // Obtiene client por clientId & clientSecret
  getClient: async (clientId, clientSecret) => {
    const res = await pool.query(
      'SELECT * FROM security.oauth_clients WHERE client_id = $1',
      [clientId]
    );
    const client = res.rows[0];
    if (!client) return null;
    if (client.is_confidential) {
      const match = await bcrypt.compare(clientSecret, client.client_secret);
      if (!match) return null;
    }
    return {
      id: client.id,
      grants: ['authorization_code', 'refresh_token', 'client_credentials', 'password'],
      redirectUris: client.redirect_uris
    };
  },

  // Validación de scopes solicitados contra los permitidos al client
  validateScope: async (user, client, requestedScope) => {
    if (!requestedScope) return '';
    const scopes = requestedScope.split(/\s+/);
    const res = await pool.query(
      `SELECT s.name
         FROM security.client_scopes cs
         JOIN security.scopes s ON s.id = cs.scope_id
        WHERE cs.client_id = $1
          AND s.name = ANY($2)`,
      [client.id, scopes]
    );
    const allowed = res.rows.map(r => r.name);
    if (allowed.length !== scopes.length) {
      return false;
    }
    return scopes.join(' ');
  },

  // Flujo client_credentials: devuelve un "user"
  getUserFromClient: async (client) => ({ id: client.id }),

  // Guarda access & refresh tokens y emite JWT como access token
  saveToken: async (token, client, user) => {
    // Calculamos el JWT
    const payload = {
      sub:   user?.id || null,
      bizz:  user?.bizz_id || null,
      scope: token.scope
    };
    const expiresInSeconds = Math.floor((token.accessTokenExpiresAt.getTime() - Date.now()) / 1000);
    const accessToken = jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: expiresInSeconds + 's' }
    );

    // Insertamos el JWT en la base de datos
    await pool.query(
      'INSERT INTO security.access_tokens(token, client_id, user_id, scope, expires_at) VALUES($1, $2, $3, $4, $5)',
      [accessToken, client.id, user?.id || null, token.scope, token.accessTokenExpiresAt]
    );

    // Guardamos refresh token si existe
    if (token.refreshToken) {
      await pool.query(
        'INSERT INTO security.refresh_tokens(token, client_id, user_id, expires_at) VALUES($1, $2, $3, $4)',
        [token.refreshToken, client.id, user.id, token.refreshTokenExpiresAt]
      );
    }

    // Retornamos el objeto con el JWT en place del token opaco
    return {
      accessToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      refreshToken: token.refreshToken,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt,
      scope: token.scope,
      client,
      user
    };
  },

  // Obtiene usuario por credenciales (username/password)
  getUser: async (username, password) => {
    const res = await pool.query(
      'SELECT * FROM security.users WHERE username = $1',
      [username]
    );
    const user = res.rows[0];
    if (!user || !user.is_active) return null;
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return null;
    return { id: user.id, bizz_id: user.bizz_id, permits: user.permits };
  },

  // Recupera el access token (JWT) de la BD y retorna datos necesarios
  getAccessToken: async (bearerToken) => {
    const res = await pool.query(
      'SELECT * FROM security.access_tokens WHERE token = $1',
      [bearerToken]
    );
    const tok = res.rows[0];
    if (!tok) return null;
    return {
      accessToken: tok.token,
      accessTokenExpiresAt: tok.expires_at,
      scope: tok.scope,
      client: { id: tok.client_id },
      user: { id: tok.user_id, bizz_id: tok.bizz_id }
    };
  },

  // Recupera el refresh token de la BD
  getRefreshToken: async (refreshToken) => {
    const res = await pool.query(
      'SELECT * FROM security.refresh_tokens WHERE token = $1',
      [refreshToken]
    );
    const rt = res.rows[0];
    if (!rt) return null;
    return {
      refreshToken: rt.token,
      refreshTokenExpiresAt: rt.expires_at,
      scope: null,
      client: { id: rt.client_id },
      user: { id: rt.user_id }
    };
  },

  // Revoca (elimina) un refresh token
  revokeToken: async (token) => {
    const result = await pool.query(
      'DELETE FROM security.refresh_tokens WHERE token = $1 RETURNING *',
      [token.refreshToken]
    );
    return result.rowCount > 0;
  },

  // Verifica que el token contenga el scope requerido en rutas protegidas
  verifyScope: async (token, scope) => {
    if (!token.scope) return false;
    const requested = scope.split(/\s+/);
    const granted   = token.scope.split(/\s+/);
    return requested.every(s => granted.includes(s));
  }
};

module.exports = model;
