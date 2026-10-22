'use strict';

const config = require('../../shared/config');
const { sendError } = require('../../shared/http');
const { writeAudit } = require('../audit');

function auditOk(req, subject, code, reason, statusCode, startedAt) {
  writeAudit({
    req,
    subject,
    decision: 'allow',
    code,
    reason,
    statusCode,
    latencyMs: Date.now() - startedAt,
  });
}

function auditDeny(req, subject, code, reason, statusCode, startedAt, username) {
  writeAudit({
    req,
    subject,
    decision: 'deny',
    code,
    reason,
    statusCode,
    latencyMs: Date.now() - startedAt,
    username,
  });
}

/**
 * Mencatat penolakan ke audit lalu mengirim response error yang konsisten.
 * `reason` adalah alasan detail untuk audit, sedangkan `message` adalah teks
 * yang dikirim ke client. Jika `reason` tidak diisi, keduanya sama.
 */
function deny(
  req,
  res,
  startedAt,
  { subject = null, status, code, message, reason = message, username = null },
) {
  auditDeny(req, subject, code, reason, status, startedAt, username);
  return sendError(res, status, code, message, req.requestId);
}

function deviceIdFrom(req) {
  return (req.get('x-device-id') || '').trim();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function asString(value) {
  return typeof value === 'string' ? value : null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    nama: user.nama,
    role: user.role,
    nim: user.nim,
  };
}

function userSubject(user, deviceId) {
  return {
    type: 'user',
    id: user.id,
    username: user.username,
    role: user.role,
    nim: user.nim,
    deviceId: deviceId || null,
  };
}

function refreshSubject(row, deviceId) {
  return {
    type: 'user',
    id: row.user_id,
    username: row.username,
    role: row.role,
    nim: row.nim,
    deviceId: deviceId || null,
  };
}

function serviceSubject(client) {
  return {
    type: 'service',
    id: client.client_id,
    username: `service:${client.client_id}`,
    role: 'service',
    deviceId: null,
  };
}

function sessionResponse({ accessToken, refresh, user, device }) {
  const body = {
    token_type: 'Bearer',
    access_token: accessToken,
    expires_in: config.jwt.accessTtl,
    refresh_token: refresh.refreshToken,
    refresh_expires_in: config.jwt.refreshTtl,
    user: publicUser(user),
  };

  if (device) body.device = device;
  return body;
}

module.exports = {
  auditOk,
  auditDeny,
  deny,
  deviceIdFrom,
  isNonEmptyString,
  asString,
  publicUser,
  userSubject,
  refreshSubject,
  serviceSubject,
  sessionResponse,
};
