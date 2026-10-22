'use strict';

/**
 * Menjalankan ketiga komponen dengan urutan yang benar:
 * Transkrip → Nilai → Gateway.
 *
 * Gateway dinyalakan terakhir, tetapi Service Nilai baru meminta token service
 * saat ada finalisasi, sehingga tidak ada race saat startup.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../shared/config');

const ROOT = path.resolve(__dirname, '..');
const children = [];
let shuttingDown = false;

function hasSeedData() {
  if (!fs.existsSync(config.dbPath)) return false;
  let db;
  try {
    db = new DatabaseSync(config.dbPath);
    return db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function runSeed() {
  console.log('[dev] Database belum berisi seed, menjalankan npm run seed...\n');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'shared/seed.js')], {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function start(name, entry) {
  const child = spawn(process.execPath, [path.join(ROOT, entry)], {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env,
  });
  children.push({ name, child });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[dev] ${name} berhenti (kode ${code ?? 'null'}, sinyal ${signal ?? '-'}); menghentikan semua proses`,
    );
    shutdown(code && code !== 0 ? code : 1);
  });

  return child;
}

async function waitForHealth(url, name, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
    } catch {
      // belum siap
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} tidak siap setelah ${timeoutMs / 1000} detik (${url})`);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGINT');
  }
  setTimeout(() => process.exit(exitCode), 800).unref();
}

async function main() {
  if (!hasSeedData()) runSeed();

  console.log('[dev] menyalakan Service Transkrip...');
  start('transkrip', 'services/transkrip/server.js');
  await waitForHealth(`${config.urls.transkrip}/health`, 'transkrip');

  console.log('[dev] menyalakan Service Nilai...');
  start('nilai', 'services/nilai/server.js');
  await waitForHealth(`${config.urls.nilai}/health`, 'nilai');

  console.log('[dev] menyalakan API Gateway...');
  start('gateway', 'gateway/server.js');
  await waitForHealth(`${config.urls.gateway}/health`, 'gateway');

  console.log('\n[dev] Semua komponen siap.');
  console.log(`[dev] Gateway : ${config.urls.gateway}`);
  console.log('[dev] Tekan Ctrl+C untuk menghentikan semuanya.\n');
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((error) => {
  console.error('[dev] gagal:', error.message);
  shutdown(1);
});
