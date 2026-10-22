'use strict';

const config = require('../../shared/config');
const { signService } = require('../../shared/jwt');
const { REASONS } = require('../../shared/constants');
const { hashToken, safeEqual } = require('../../shared/secrets');
const {
  auditOk,
  deny,
  isNonEmptyString,
  serviceSubject,
} = require('./common');
const { findServiceClient } = require('./store');

// ── POST /auth/service ───────────────────────────────────────
function service(req, res) {
  const startedAt = Date.now();
  const { client_id: clientId, client_secret: clientSecret } = req.body ?? {};

  if (!isNonEmptyString(clientId) || !isNonEmptyString(clientSecret)) {
    return deny(req, res, startedAt, {
      status: 400,
      code: REASONS.INVALID_REQUEST,
      message: 'Body wajib berisi client_id dan client_secret',
      username: clientId,
    });
  }

  const client = findServiceClient(clientId);
  const valid = client && safeEqual(hashToken(clientSecret), client.secret_hash);

  if (!valid) {
    return deny(req, res, startedAt, {
      status: 401,
      code: REASONS.SERVICE_CLIENT_INVALID,
      message: 'Client ID atau secret tidak valid',
      reason: `Client ID/secret tidak valid untuk ${clientId}`,
      username: clientId,
    });
  }

  const token = signService(client.client_id);
  const subject = serviceSubject(client);

  auditOk(
    req,
    subject,
    REASONS.ALLOWED,
    `Token service diterbitkan untuk ${client.client_id} (berlaku ${config.jwt.serviceTtl} detik)`,
    200,
    startedAt,
  );

  return res.status(200).json({
    token_type: 'Bearer',
    access_token: token,
    expires_in: config.jwt.serviceTtl,
    role: 'service',
    client_id: client.client_id,
  });
}

module.exports = service;
