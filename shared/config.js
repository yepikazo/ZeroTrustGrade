'use strict';

/**
 * Konfigurasi terpusat. Membaca .env di root repo (jika ada).
 * Variabel environment dari shell menang atas isi .env, sehingga demo dapat
 * mengubah jam akses tanpa mengedit file:
 *   ACCESS_START=00:00 ACCESS_END=00:01 npm run dev
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const envFile = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.join(ROOT, '.env');

if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function str(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback) {
  const value = str(name, '').toLowerCase();
  if (value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function required(name) {
  const value = str(name, '');
  if (!value) {
    throw new Error(
      `Konfigurasi ${name} belum diisi. Salin .env.example menjadi .env lalu jalankan ulang.`,
    );
  }
  return value;
}

const ports = {
  gateway: int('PORT_GATEWAY', 3000),
  nilai: int('PORT_NILAI', 3001),
  transkrip: int('PORT_TRANSKRIP', 3002),
};

const host = str('HOST', '127.0.0.1');

const config = {
  root: ROOT,
  env: str('NODE_ENV', 'development'),
  host,
  ports,
  dbPath: path.resolve(ROOT, str('DB_PATH', 'data/app.sqlite')),

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    serviceSecret: required('JWT_SERVICE_SECRET'),
    issuer: str('JWT_ISSUER', 'zerotrustgrade'),
    accessAudience: 'ztg-api',
    serviceAudience: 'ztg-service',
    accessTtl: int('ACCESS_TOKEN_TTL', 600),
    serviceTtl: int('SERVICE_TOKEN_TTL', 300),
    refreshTtl: int('REFRESH_TOKEN_TTL', 86400),
  },

  gatewaySecret: required('GATEWAY_SECRET'),

  serviceClient: {
    id: str('SERVICE_CLIENT_ID', 'nilai-service'),
    secret: required('SERVICE_CLIENT_SECRET'),
  },

  accessWindow: {
    enabled: bool('ACCESS_WINDOW_ENABLED', true),
    start: str('ACCESS_START', '07:00'),
    end: str('ACCESS_END', '21:00'),
    timezone: str('APP_TZ', 'Asia/Jakarta'),
  },

  urls: {
    gateway: str('GATEWAY_URL', `http://${host}:${ports.gateway}`),
    nilai: str('NILAI_URL', `http://${host}:${ports.nilai}`),
    transkrip: str('TRANSKRIP_URL', `http://${host}:${ports.transkrip}`),
  },
};

// Validasi format jam lebih awal agar kesalahan konfigurasi tidak baru
// terlihat saat request pertama.
for (const [key, value] of Object.entries({
  ACCESS_START: config.accessWindow.start,
  ACCESS_END: config.accessWindow.end,
})) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`Format ${key} harus HH:MM (24 jam), ditemukan "${value}"`);
  }
}

module.exports = config;
