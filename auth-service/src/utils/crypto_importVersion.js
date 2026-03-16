// auth-service/src/utils/crypto.js
// ESM version  —  make sure your package.json has  "type": "module"

import 'dotenv/config';           // carga las variables de entorno
import crypto from 'node:crypto'; // core module (también vale 'crypto')

const ALGO = 'aes-256-cbc';
const KEY  = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes
const IV   = Buffer.from(process.env.ENCRYPTION_IV,  'hex'); // 16 bytes

/**
 * Cifra texto (UTF‑8) con AES‑256‑CBC y devuelve Base64
 * @param {string} text
 * @returns {string}
 */
export function encrypt(text) {
  const cipher = crypto.createCipheriv(ALGO, KEY, IV);
  let enc = cipher.update(text, 'utf8', 'base64');
  enc += cipher.final('base64');
  return enc;
}

/**
 * Descifra un string Base64 generado por `encrypt`
 * @param {string} enc
 * @returns {string}
 */
export function decrypt(enc) {
  const decipher = crypto.createDecipheriv(ALGO, KEY, IV);
  let txt = decipher.update(enc, 'base64', 'utf8');
  txt += decipher.final('utf8');
  return txt;
}

// (opcional) exportación por defecto para compatibilidad
export default { encrypt, decrypt };
