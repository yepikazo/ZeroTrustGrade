'use strict';

const { REASONS } = require('../../shared/constants');
const {
  auditOk,
  deny,
  deviceIdFrom,
  isNonEmptyString,
  refreshSubject,
} = require('./common');
const { findRefreshToken, revokeRefreshToken } = require('./store');

// ── POST /auth/logout ────────────────────────────────────────
function logout(req, res) {
  const startedAt = Date.now();
  const { refresh_token: refreshToken } = req.body ?? {};

  if (!isNonEmptyString(refreshToken)) {
    return deny(req, res, startedAt, {
      status: 400,
      code: REASONS.INVALID_REQUEST,
      message: 'Body logout wajib berisi refresh_token',
    });
  }

  const row = findRefreshToken(refreshToken);

  if (row && !row.revoked_at) {
    revokeRefreshToken(row.id);
  }

  const subject = row ? refreshSubject(row, deviceIdFrom(req)) : null;

  auditOk(
    req,
    subject,
    REASONS.LOGOUT,
    row
      ? 'Refresh token dicabut'
      : 'Refresh token tidak dikenal (logout idempotent)',
    204,
    startedAt,
  );

  return res.status(204).end();
}

module.exports = logout;
