'use strict';

const config = require('../../shared/config');

class ServiceCallError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ServiceCallError';
    this.status = status;
    this.code = code;
  }
}

let cache = { token: null, expiresAt: 0 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestServiceToken() {
  const response = await fetch(`${config.urls.gateway}/auth/service`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.serviceClient.id,
      client_secret: config.serviceClient.secret,
    }),
    signal: AbortSignal.timeout(5000),
  });

  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  if (!response.ok || !body.access_token) {
    throw new ServiceCallError(
      response.status,
      body?.error?.code ?? 'AUTH_SERVICE_FAILED',
      body?.error?.message ?? `Gagal memperoleh token service (HTTP ${response.status})`,
    );
  }

  return body;
}

/**
 * Token service di-cache di memori dan diperbarui sebelum kedaluwarsa.
 * Service Nilai tidak menyimpan client secret di setiap request.
 */
async function getServiceToken(force = false) {
  if (!force && cache.token && Date.now() < cache.expiresAt) {
    return cache.token;
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const body = await requestServiceToken();
      cache = {
        token: body.access_token,
        expiresAt: Date.now() + Math.max(30, body.expires_in - 20) * 1000,
      };
      return cache.token;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(250 * (attempt + 1));
    }
  }

  throw lastError;
}

/**
 * Memanggil Service Transkrip melalui GATEWAY (bukan langsung ke port 3002),
 * sehingga panggilan antar-service tetap melewati policy dan audit log.
 */
async function syncTranscript(payload) {
  let token = await getServiceToken();
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${config.urls.gateway}/transkrip/sinkron`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });

    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }

    if (response.status === 401 && attempt === 0) {
      // Token service bisa saja baru dicabut/kedaluwarsa; minta sekali lagi.
      token = await getServiceToken(true);
      continue;
    }

    if (!response.ok) {
      lastError = new ServiceCallError(
        response.status,
        body?.error?.code ?? 'TRANSCRIPT_SYNC_FAILED',
        body?.error?.message ?? `Sinkron transkrip gagal (HTTP ${response.status})`,
      );
      throw lastError;
    }

    return body;
  }

  throw lastError ?? new ServiceCallError(500, 'TRANSCRIPT_SYNC_FAILED', 'Sinkron gagal');
}

module.exports = { getServiceToken, syncTranscript, ServiceCallError };
