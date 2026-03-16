// auth-service/src/utils/crypto.js
require('dotenv').config();
const crypto = require('crypto');

const ALGO = 'aes-256-cbc';
const KEY  = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes
const IV   = Buffer.from(process.env.ENCRYPTION_IV,  'hex'); // 16 bytes

/**
 * Encrypta un texto usando AES-256-CBC y retorna Base64
 * @param {string} text
 * @returns {string}
 */
function encrypt(text) {
  const cipher = crypto.createCipheriv(ALGO, KEY, IV);
  let enc = cipher.update(text, 'utf8', 'base64');
  enc += cipher.final('base64');
  return enc;
}

/**
 * Desencripta un texto Base64 cifrado con AES-256-CBC
 * @param {string} enc
 * @returns {string}
 */
function decrypt(enc) {
  const decipher = crypto.createDecipheriv(ALGO, KEY, IV);
  let txt = decipher.update(enc, 'base64', 'utf8');
  txt += decipher.final('utf8');
  return txt;
}

module.exports = { encrypt, decrypt };