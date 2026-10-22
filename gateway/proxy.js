'use strict';

const config = require('../shared/config');

const TIMEOUT_MS = 8000;

/**
 * Meneruskan request yang sudah lolos policy ke service tujuan.
 * Header identitas dari client tidak pernah dipakai; header internal
 * dibentuk ulang dari hasil verifikasi gateway.
 */
async function forward(req, target) {
  const base = target === 'transkrip' ? config.urls.transkrip : config.urls.nilai;
  const url = `${base.replace(/\/$/, '')}${req.originalUrl}`;

  const headers = {
    'x-gateway-secret': config.gatewaySecret,
    'x-request-id': req.requestId,
    'x-auth-subject-type': req.subject.type,
    'x-auth-role': req.subject.role,
  };

  if (req.subject.type === 'user') {
    headers['x-auth-user-id'] = String(req.subject.id);
    headers['x-auth-username'] = req.subject.username;
    if (req.subject.nim) headers['x-auth-nim'] = req.subject.nim;
  } else {
    headers['x-auth-client-id'] = String(req.subject.id);
    headers['x-auth-username'] = req.subject.username;
  }

  const authorization = req.get('authorization');
  if (authorization) headers.authorization = authorization;

  const accept = req.get('accept');
  if (accept) headers.accept = accept;

  const contentType = req.get('content-type');
  if (contentType) headers['content-type'] = contentType;

  const deviceId = req.get('x-device-id');
  if (deviceId) headers['x-device-id'] = deviceId;

  const hasBody =
    Buffer.isBuffer(req.body) && req.body.length > 0 && req.method !== 'GET';

  const response = await fetch(url, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = Buffer.from(await response.arrayBuffer());

  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    wwwAuthenticate: response.headers.get('www-authenticate'),
    body,
  };
}

module.exports = { forward };
