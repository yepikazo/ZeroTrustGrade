'use strict';

const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const config = require('./config');
const { REASONS } = require('./constants');

class TokenError extends Error {
  constructor(code, message, payload = null) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
    this.payload = payload;
  }
}

function signAccess(user, options = {}) {
  const expiresIn = options.expiresIn ?? config.jwt.accessTtl;
  return jwt.sign(
    {
      role: user.role,
      username: user.username,
      nim: user.nim ?? null,
      typ: 'access',
    },
    config.jwt.accessSecret,
    {
      algorithm: 'HS256',
      subject: String(user.id),
      issuer: config.jwt.issuer,
      audience: config.jwt.accessAudience,
      jwtid: options.jti ?? randomUUID(),
      expiresIn,
    },
  );
}

function signService(clientId, options = {}) {
  const expiresIn = options.expiresIn ?? config.jwt.serviceTtl;
  return jwt.sign(
    {
      role: 'service',
      typ: 'service',
      client_id: clientId,
    },
    config.jwt.serviceSecret,
    {
      algorithm: 'HS256',
      subject: `service:${clientId}`,
      issuer: config.jwt.issuer,
      audience: config.jwt.serviceAudience,
      jwtid: options.jti ?? randomUUID(),
      expiresIn,
    },
  );
}

/**
 * Memverifikasi Bearer token dan memastikan tipenya sesuai.
 * Tipe dibaca dari payload (tanpa dipercaya) hanya untuk memilih secret;
 * tanda tangan tetap wajib valid dengan secret yang tepat.
 */
function verifyBearer(token, expectedType) {
  if (!token) {
    throw new TokenError(REASONS.NO_TOKEN, 'Access token tidak ditemukan');
  }

  let decoded;
  try {
    decoded = jwt.decode(token, { complete: true });
  } catch {
    throw new TokenError(REASONS.TOKEN_INVALID, 'Format token tidak valid');
  }
  if (!decoded || !decoded.payload) {
    throw new TokenError(REASONS.TOKEN_INVALID, 'Format token tidak valid');
  }

  const claimedType = decoded.payload.typ;
  const isService = claimedType === 'service';
  const secret = isService ? config.jwt.serviceSecret : config.jwt.accessSecret;
  const audience = isService ? config.jwt.serviceAudience : config.jwt.accessAudience;

  let payload;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
      audience,
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new TokenError(REASONS.TOKEN_EXPIRED, 'Token sudah kedaluwarsa');
    }
    throw new TokenError(REASONS.TOKEN_INVALID, 'Tanda tangan atau isi token tidak valid');
  }

  if (payload.typ !== 'access' && payload.typ !== 'service') {
    throw new TokenError(REASONS.TOKEN_INVALID, 'Tipe token tidak dikenal');
  }

  if (expectedType && payload.typ !== expectedType) {
    throw new TokenError(
      REASONS.WRONG_TOKEN_TYPE,
      expectedType === 'service'
        ? 'Endpoint ini hanya menerima token service'
        : 'Endpoint ini hanya menerima access token user',
      payload,
    );
  }

  return payload;
}

module.exports = { TokenError, signAccess, signService, verifyBearer };
