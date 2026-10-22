'use strict';

/**
 * Menampilkan audit log terbaru.
 *   npm run audit          → 15 baris terakhir
 *   npm run audit -- 50    → 50 baris terakhir
 */

const { DatabaseSync } = require('node:sqlite');
const config = require('../shared/config');

const limit = Math.max(1, Math.min(500, Number(process.argv[2]) || 15));

let db;
try {
  db = new DatabaseSync(config.dbPath);
  const rows = db
    .prepare(
      `SELECT id, ts, subject_type, subject_id, username, role, method, path,
              device_id, decision, reason_code, reason, status_code, latency_ms
       FROM audit_logs ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);

  if (rows.length === 0) {
    console.log('Belum ada audit log. Jalankan beberapa request terlebih dahulu.');
    process.exit(0);
  }

  const summary = db
    .prepare(
      `SELECT decision, COUNT(*) AS total FROM audit_logs GROUP BY decision ORDER BY decision`,
    )
    .all();

  console.log(`\nAudit log terakhir (${rows.length} dari total ${summary.reduce((n, r) => n + r.total, 0)})\n`);

  const table = rows.map((row) => ({
    id: row.id,
    waktu: row.ts.replace('T', ' ').replace('Z', 'Z'),
    subjek: row.subject_type === 'service'
      ? `service:${row.subject_id}`
      : row.username ?? 'anonymous',
    role: row.role ?? '-',
    request: `${row.method} ${row.path}`,
    device: row.device_id ?? '-',
    hasil: row.decision.toUpperCase(),
    alasan: row.reason_code,
    http: row.status_code ?? '-',
  }));

  console.table(table);
  console.log('Ringkasan:', summary.map((r) => `${r.decision}=${r.total}`).join(', '));
  console.log('');
} catch (error) {
  console.error('Gagal membaca audit log:', error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
