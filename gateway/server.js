'use strict';

const express = require('express');

const config = require('../shared/config');
const { initSchema, closeDb } = require('../shared/db');
const { requestId, sendError } = require('../shared/http');
const { REASONS } = require('../shared/constants');
const authRouter = require('./auth');
const { authenticate } = require('./authenticate');
const { decide } = require('./policy');
const { forward } = require('./proxy');
const { writeAudit, finishAudit, markUpstreamFailure } = require('./audit');

initSchema();

const app = express();
app.disable('x-powered-by');
app.use(requestId);

// Health check operasional (tanpa data sensitif).
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'gateway',
    clock: new Date().toISOString(),
  });
});

// /auth/* ditangani langsung gateway (Policy Administrator).
// Body JSON diparse hanya untuk route ini; route resource tetap raw agar
// bisa diteruskan apa adanya ke service.
app.use('/auth', express.json({ limit: '32kb' }), authRouter);

// Route resource: buffer mentah, lalu diverifikasi dan diproxy.
app.use(express.raw({ type: () => true, limit: '128kb' }));
app.use(authenticate);

app.use(async (req, res, next) => {
  const startedAt = Date.now();

  try {
    const decision = decide({
      subject: req.subject,
      method: req.method,
      path: req.path,
    });

    const auditId = writeAudit({
      req,
      subject: req.subject,
      decision: decision.allow ? 'allow' : 'deny',
      code: decision.code,
      reason: decision.message,
      statusCode: decision.allow ? null : decision.status,
      latencyMs: decision.allow ? null : 0,
    });

    if (!decision.allow) {
      finishAudit(auditId, decision.status, Date.now() - startedAt);
      return sendError(
        res,
        decision.status,
        decision.code,
        decision.message,
        req.requestId,
      );
    }

    let result;
    try {
      result = await forward(req, decision.target);
    } catch (error) {
      const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      const status = timeout ? 504 : 502;
      const code = timeout ? REASONS.UPSTREAM_TIMEOUT : REASONS.UPSTREAM_ERROR;
      const message = timeout
        ? `Service ${decision.target} tidak merespons dalam batas waktu`
        : `Gagal meneruskan request ke service ${decision.target}`;

      console.error(`[gateway] ${req.requestId} ${message}:`, error.message);
      markUpstreamFailure(auditId, status, code, message, Date.now() - startedAt);
      return sendError(res, status, code, message, req.requestId);
    }

    finishAudit(auditId, result.status, Date.now() - startedAt);

    res.status(result.status);
    if (result.contentType) res.setHeader('Content-Type', result.contentType);
    if (result.wwwAuthenticate) {
      res.setHeader('WWW-Authenticate', result.wwwAuthenticate);
    }

    if (result.status === 204 || result.body.length === 0) {
      return res.end();
    }
    return res.send(result.body);
  } catch (error) {
    return next(error);
  }
});

// Error handler terakhir: jangan bocorkan stack trace ke client.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error.type === 'entity.parse.failed') {
    return sendError(
      res,
      400,
      REASONS.INVALID_REQUEST,
      'Body JSON tidak valid',
      req.requestId,
    );
  }

  if (error.type === 'entity.too.large') {
    return sendError(
      res,
      413,
      REASONS.INVALID_REQUEST,
      'Ukuran body melebihi batas',
      req.requestId,
    );
  }

  console.error(`[gateway] ${req.requestId} error:`, error);
  return sendError(
    res,
    500,
    REASONS.INTERNAL_ERROR,
    'Terjadi kesalahan internal gateway',
    req.requestId,
  );
});

let shuttingDown = false;

const server = app.listen(config.ports.gateway, config.host, () => {
  const { enabled, start, end, timezone } = config.accessWindow;
  console.log(
    `[gateway] PEP berjalan di http://${config.host}:${config.ports.gateway}`,
  );
  console.log(`[gateway] /auth/*        -> ditangani gateway`);
  console.log(
    `[gateway] /nilai, /kelas -> ${config.urls.nilai} (Service Nilai)`,
  );
  console.log(
    `[gateway] /transkrip     -> ${config.urls.transkrip} (Service Transkrip)`,
  );
  console.log(
    `[gateway] jam akses      -> ${enabled ? `${start}-${end} ${timezone} (aktif)` : 'nonaktif'}`,
  );
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[gateway] ${signal} diterima, menutup server...`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
