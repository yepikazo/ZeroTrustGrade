'use strict';

const config = require('./config');
const { verifyBearer, TokenError } = require('./jwt');
const { getBearer, sendError } = require('./http');
const { safeEqual } = require('./secrets');
const { REASONS } = require('./constants');

/**
 * Middleware pertahanan berlapis di setiap service.
 *
 * Service tidak boleh percaya begitu saja pada jaringan internal:
 *   1. wajib X-Gateway-Secret yang benar;
 *   2. wajib JWT valid (signature + exp + audience + typ);
 *   3. header identitas yang ditambahkan gateway harus cocok dengan isi token.
 *
 * Dengan begitu request langsung ke port 3001/3002 tetap ditolak walaupun
 * penyerang mengetahui URL service.
 */
function verifyGateway(expectedType) {
  return (req, res, next) => {
    const requestId = req.get('x-request-id') || null;

    const gatewaySecret = req.get('x-gateway-secret') || '';
    if (!safeEqual(gatewaySecret, config.gatewaySecret)) {
      return sendError(
        res,
        401,
        REASONS.GATEWAY_SECRET_REQUIRED,
        'X-Gateway-Secret tidak ada atau tidak valid; service hanya menerima request dari gateway',
        requestId,
      );
    }

    const token = getBearer(req);
    if (!token) {
      return sendError(
        res,
        401,
        REASONS.NO_TOKEN,
        'Access token wajib dikirim melalui header Authorization',
        requestId,
      );
    }

    let payload;
    try {
      payload = verifyBearer(token, expectedType);
    } catch (error) {
      if (error instanceof TokenError) {
        return sendError(res, 401, error.code, error.message, requestId);
      }
      throw error;
    }

    if (expectedType === 'access') {
      const userId = req.get('x-auth-user-id');
      const role = req.get('x-auth-role');
      if (!userId || userId !== String(payload.sub)) {
        return sendError(
          res,
          401,
          REASONS.IDENTITY_MISMATCH,
          'Header identitas gateway tidak cocok dengan subjek token',
          requestId,
        );
      }
      if (role && role !== payload.role) {
        return sendError(
          res,
          401,
          REASONS.IDENTITY_MISMATCH,
          'Role pada header identitas tidak cocok dengan token',
          requestId,
        );
      }
    } else {
      const clientId = req.get('x-auth-client-id');
      if (!clientId || clientId !== payload.client_id) {
        return sendError(
          res,
          401,
          REASONS.IDENTITY_MISMATCH,
          'Header client ID tidak cocok dengan token service',
          requestId,
        );
      }
    }

    req.auth = payload;
    req.requestId = requestId;
    return next();
  };
}

module.exports = { verifyGateway };
