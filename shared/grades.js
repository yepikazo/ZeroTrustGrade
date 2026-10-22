'use strict';

/**
 * Konversi nilai angka ke huruf. Dibuat di server agar client tidak bisa
 * mengirim huruf yang tidak konsisten dengan angkanya.
 */
function angkaKeHuruf(angka) {
  if (typeof angka !== 'number' || !Number.isFinite(angka)) return null;
  if (angka >= 85) return 'A';
  if (angka >= 75) return 'B';
  if (angka >= 65) return 'C';
  if (angka >= 55) return 'D';
  return 'E';
}

function validAngka(angka) {
  return typeof angka === 'number' && Number.isFinite(angka) && angka >= 0 && angka <= 100;
}

module.exports = { angkaKeHuruf, validAngka };
