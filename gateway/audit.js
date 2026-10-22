'use strict';

const { getDb } = require('../shared/db');
const { clientIp, fullPath, nowIso } = require('../shared/http');

/**
 * Mencatat satu keputusan akses. Dipanggil untuk ALLOW maupun DENY.
 * Tidak pernah menyimpan password, access token, refresh token, atau secret.
 */
function writeAudit({
  req,
  subject = null,
  decision,
  code,
  reason,
  statusCode = null,
  latencyMs = null,
  username = null,
}) {
  const db = getDb();
  const subjectType = subject?.type ?? 'anonymous';
  const subjectId = subject?.id !== undefined && subject?.id !== null
    ? String(subject.id)
    : null;
  const deviceId = subject?.deviceId ?? req.get('x-device-id') ?? null;

  const result = db
    .prepare(
      `INSERT INTO audit_logs
         (ts, request_id, subject_type, subject_id, username, role, method, path,
          device_id, decision, reason_code, reason, status_code, latency_ms, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nowIso(),
      req.requestId,
      subjectType,
      subjectId,
      subject?.username ?? username ?? null,
      subject?.role ?? null,
      req.method,
      fullPath(req),
      deviceId,
      decision,
      code,
      reason,
      statusCode,
      latencyMs,
      clientIp(req),
    );

  return Number(result.lastInsertRowid);
}

function finishAudit(id, statusCode, latencyMs) {
  if (!id) return;
  try {
    getDb()
      .prepare('UPDATE audit_logs SET status_code = ?, latency_ms = ? WHERE id = ?')
      .run(statusCode, latencyMs, id);
  } catch (error) {
    console.error('[audit] gagal memperbarui status:', error.message);
  }
}

function markUpstreamFailure(id, statusCode, code, reason, latencyMs) {
  if (!id) return;
  try {
    getDb()
      .prepare(
        `UPDATE audit_logs
         SET status_code = ?, latency_ms = ?, reason_code = ?, reason = ?
         WHERE id = ?`,
      )
      .run(statusCode, latencyMs, code, reason, id);
  } catch (error) {
    console.error('[audit] gagal mencatat kegagalan upstream:', error.message);
  }
}

module.exports = { writeAudit, finishAudit, markUpstreamFailure };
