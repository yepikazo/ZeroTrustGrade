'use strict';

const { verifyBearer, TokenError } = require('../shared/jwt');
const { getBearer, sendError } = require('../shared/http');
const { REASONS } = require('../shared/constants');
const { getDb } = require('../shared/db');
const { writeAudit } = require('./audit');

function deny(req, res, status, code, message, subject = null) {
  writeAudit({
    req,
    subject,
    decision: 'deny',
    code,
    reason: message,
    statusCode: status,
    latencyMs: 0,
  });
  return sendError(res, status, code, message, req.requestId);
}

/**
 * Membentuk subjek audit dari payload JWT yang sudah terverifikasi.
 * Dipakai ketika request ditolak karena tipe token salah, sehingga audit
 * tetap mencatat user/service yang sebenarnya.
 */
function subjectFromPayload(payload, req) {
  if (!payload) return null;
  const deviceId = (req.get('x-device-id') || '').trim() || null;

  if (payload.typ === 'access') {
    return {
      type: 'user',
      id: payload.sub,
      username: payload.username ?? null,
      role: payload.role ?? null,
      nim: payload.nim ?? null,
      deviceId,
    };
  }

  if (payload.typ === 'service') {
    return {
      type: 'service',
      id: payload.client_id,
      username: `service:${payload.client_id}`,
      role: 'service',
      deviceId: null,
    };
  }

  return null;
}

/**
 * Autentikasi di gateway (PEP):
 *  - endpoint user  : access token valid + device terdaftar milik user
 *  - endpoint service: token service valid (tanpa device)
 *
 * Semua kegagalan dicatat ke audit_logs dengan alasannya.
 */
function authenticate(req, res, next) {
  const isServiceEndpoint = req.method === 'POST' && req.path === '/transkrip/sinkron';
  const token = getBearer(req);

  if (!token) {
    return deny(
      req,
      res,
      401,
      REASONS.NO_TOKEN,
      'Header Authorization: Bearer <token> wajib dikirim',
    );
  }

  let payload;
  try {
    payload = verifyBearer(token, isServiceEndpoint ? 'service' : 'access');
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;

    const subject = subjectFromPayload(error.payload, req);

    if (isServiceEndpoint && error.code === REASONS.WRONG_TOKEN_TYPE) {
      return deny(
        req,
        res,
        403,
        REASONS.SERVICE_TOKEN_REQUIRED,
        'Endpoint sinkron transkrip hanya menerima token service',
        subject,
      );
    }

    return deny(req, res, 401, error.code, error.message, subject);
  }

  if (isServiceEndpoint) {
    const client = getDb()
      .prepare('SELECT * FROM service_clients WHERE client_id = ? AND active = 1')
      .get(payload.client_id);

    if (!client) {
      return deny(
        req,
        res,
        401,
        REASONS.TOKEN_INVALID,
        'Service client tidak dikenal atau sudah dinonaktifkan',
        subjectFromPayload(payload, req),
      );
    }

    req.subject = {
      type: 'service',
      id: payload.client_id,
      username: `service:${payload.client_id}`,
      role: 'service',
      deviceId: null,
    };
    return next();
  }

  const user = getDb()
    .prepare('SELECT id, username, nama, role, nim FROM users WHERE id = ?')
    .get(Number(payload.sub));

  if (!user || user.role !== payload.role) {
    return deny(
      req,
      res,
      401,
      REASONS.TOKEN_INVALID,
      'Subjek token tidak lagi valid',
      subjectFromPayload(payload, req),
    );
  }

  const subject = {
    type: 'user',
    id: user.id,
    username: user.username,
    role: user.role,
    nim: user.nim,
    deviceId: null,
  };

  const deviceId = (req.get('x-device-id') || '').trim();
  if (!deviceId) {
    return deny(
      req,
      res,
      403,
      REASONS.DEVICE_MISSING,
      'Header X-Device-ID wajib dikirim untuk request user',
      subject,
    );
  }

  const device = getDb()
    .prepare(
      'SELECT id FROM devices WHERE device_id = ? AND user_id = ? AND active = 1',
    )
    .get(deviceId, user.id);

  if (!device) {
    return deny(
      req,
      res,
      403,
      REASONS.DEVICE_NOT_REGISTERED,
      `Device ${deviceId} tidak terdaftar untuk user ${user.username}`,
      { ...subject, deviceId },
    );
  }

  subject.deviceId = deviceId;
  req.subject = subject;
  return next();
}

module.exports = { authenticate, deny };
