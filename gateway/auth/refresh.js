'use strict';

const { signAccess } = require('../../shared/jwt');
const { REASONS } = require('../../shared/constants');
const {
  auditOk,
  deny,
  deviceIdFrom,
  isNonEmptyString,
  refreshSubject,
  sessionResponse,
} = require('./common');
const {
  findRefreshToken,
  revokeAllRefreshTokens,
  rotateRefreshToken,
} = require('./store');

// ── POST /auth/refresh ───────────────────────────────────────
function refresh(req, res) {
  const startedAt = Date.now();
  const { refresh_token: refreshToken } = req.body ?? {};
  const deviceId = deviceIdFrom(req);

  if (!isNonEmptyString(refreshToken)) {
    return deny(req, res, startedAt, {
      status: 400,
      code: REASONS.INVALID_REQUEST,
      message: 'Body refresh wajib berisi refresh_token',
    });
  }

  if (!deviceId) {
    return deny(req, res, startedAt, {
      status: 403,
      code: REASONS.DEVICE_MISSING,
      message: 'Refresh wajib menyertakan header X-Device-ID',
      reason: 'Refresh wajib menyertakan X-Device-ID',
    });
  }

  const row = findRefreshToken(refreshToken);

  if (!row) {
    return deny(req, res, startedAt, {
      status: 401,
      code: REASONS.REFRESH_INVALID,
      message: 'Refresh token tidak valid',
      reason: 'Refresh token tidak dikenal',
    });
  }

  const subject = refreshSubject(row, deviceId);

  if (row.revoked_at) {
    // Assume breach: token yang sudah dicabut lalu dipakai ulang dianggap
    // indikasi pencurian token, sehingga seluruh sesi user dicabut.
    revokeAllRefreshTokens(row.user_id);

    return deny(req, res, startedAt, {
      subject,
      status: 401,
      code: REASONS.REFRESH_REVOKED,
      message: 'Refresh token sudah dicabut',
      reason: 'Refresh token sudah dicabut; seluruh sesi user ikut dicabut',
    });
  }

  if (row.expires_at <= new Date().toISOString()) {
    return deny(req, res, startedAt, {
      subject,
      status: 401,
      code: REASONS.REFRESH_EXPIRED,
      message: 'Refresh token sudah kedaluwarsa',
    });
  }

  if (row.device_id !== deviceId) {
    return deny(req, res, startedAt, {
      subject,
      status: 401,
      code: REASONS.DEVICE_MISMATCH,
      message: 'Refresh token tidak cocok dengan device yang mengirim request',
      reason: `Refresh token terikat pada device ${row.device_id}, bukan ${deviceId}`,
    });
  }

  const user = {
    id: row.user_id,
    username: row.username,
    nama: row.nama,
    role: row.role,
    nim: row.nim,
  };

  const rotated = rotateRefreshToken(row, user, deviceId);
  const accessToken = signAccess(user);

  auditOk(
    req,
    subject,
    REASONS.REFRESH_ROTATED,
    'Refresh token valid; token lama dicabut dan token baru diterbitkan',
    200,
    startedAt,
  );

  return res.status(200).json(
    sessionResponse({
      accessToken,
      refresh: rotated,
      user,
    }),
  );
}

module.exports = refresh;
