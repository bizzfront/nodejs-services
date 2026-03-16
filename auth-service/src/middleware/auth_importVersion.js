// auth-middleware.js   (usa extensión .js si tu package.json tiene "type":"module",
//                       o .mjs si no la vas a cambiar)

import jwt from 'jsonwebtoken';

/**
 * Verifica el encabezado Authorization: Bearer <token>
 * y añade el payload decodificado a req.user
 */
export default function authMiddleware (req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Malformed authorization header' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;          // ← usuario disponible en la ruta
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
