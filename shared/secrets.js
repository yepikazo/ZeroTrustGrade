'use strict';

const crypto = require('node:crypto');

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Perbandingan constant-time untuk secret (gateway secret, client secret).
 * Panjang string boleh terlihat; isi tidak dibandingkan per karakter.
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { hashToken, randomToken, safeEqual };
