'use strict';

const crypto = require('node:crypto');
const config = require('./config');

function requestId(req, res, next) {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

function fullPath(req) {
  return `${req.baseUrl || ''}${req.path || ''}` || '/';
}

function getBearer(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function sendError(res, status, code, message, requestId, details) {
  if (status === 401) {
    res.setHeader('WWW-Authenticate', 'Bearer');
  }
  const body = {
    error: {
      code,
      message,
      request_id: requestId ?? null,
    },
  };
  if (details !== undefined) body.error.details = details;
  return res.status(status).json(body);
}

function clientIp(req) {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return raw.replace(/^::ffff:/, '');
}

function parseHHMM(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function localTimeInZone(date) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.accessWindow.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    hour,
    minute,
    minutes: hour * 60 + minute,
    label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

/**
 * Jam akses hanya membatasi operasi perubahan (PUT /nilai, finalisasi).
 * Start inklusif, end eksklusif. Mendukung rentang yang melewati tengah malam.
 */
function accessWindowStatus(now = new Date()) {
  const { enabled, start, end, timezone } = config.accessWindow;
  const local = localTimeInZone(now);

  if (!enabled) {
    return {
      allowed: true,
      localTime: local.label,
      timezone,
      window: `${start}-${end}`,
      reason: 'Pembatasan jam akses dinonaktifkan',
    };
  }

  const startMinutes = parseHHMM(start);
  const endMinutes = parseHHMM(end);
  const current = local.minutes;

  let allowed;
  if (startMinutes === endMinutes) {
    allowed = true; // dianggap 24 jam
  } else if (startMinutes < endMinutes) {
    allowed = current >= startMinutes && current < endMinutes;
  } else {
    allowed = current >= startMinutes || current < endMinutes;
  }

  return {
    allowed,
    localTime: local.label,
    timezone,
    window: `${start}-${end}`,
    reason: allowed
      ? `Dalam jam akses ${start}-${end} ${timezone}`
      : `Di luar jam akses ${start}-${end} ${timezone} (sekarang ${local.label})`,
  };
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  requestId,
  fullPath,
  getBearer,
  sendError,
  clientIp,
  accessWindowStatus,
  nowIso,
};
