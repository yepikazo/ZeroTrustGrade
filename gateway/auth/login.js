'use strict';

const bcrypt = require('bcryptjs');

const { getDb } = require('../../shared/db');
const { signAccess } = require('../../shared/jwt');
const { REASONS } = require('../../shared/constants');
const {
  auditOk,
  deny,
  deviceIdFrom,
  isNonEmptyString,
  asString,
  userSubject,
  sessionResponse,
} = require('./common');
const {
  findUserByUsername,
  findActiveDevice,
  issueRefreshToken,
} = require('./store');

// Dipakai agar waktu respons untuk username tidak dikenal tetap mirip dengan
// username yang ada (mengurangi user enumeration).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-not-used', 10);

// ── POST /auth/login ─────────────────────────────────────────
function login(req, res) {
  const startedAt = Date.now();
  const { username, password } = req.body ?? {};
  const deviceId = deviceIdFrom(req);

  if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
    return deny(req, res, startedAt, {
      status: 400,
      code: REASONS.INVALID_REQUEST,
      message: 'Body login wajib berisi username dan password',
      username: asString(username),
    });
  }

  const user = findUserByUsername(username);
  const passwordOk = bcrypt.compareSync(password, user?.password_hash ?? DUMMY_HASH);

  if (!user || !passwordOk) {
    return deny(req, res, startedAt, {
      status: 401,
      code: REASONS.INVALID_CREDENTIALS,
      message: 'Username atau password salah',
      username,
    });
  }

  const subject = userSubject(user, deviceId);

  if (!deviceId) {
    return deny(req, res, startedAt, {
      subject,
      status: 403,
      code: REASONS.DEVICE_MISSING,
      message: 'Login wajib menyertakan header X-Device-ID',
      reason: 'Login wajib menyertakan X-Device-ID',
    });
  }

  const device = findActiveDevice(deviceId, user.id);

  if (!device) {
    return deny(req, res, startedAt, {
      subject,
      status: 403,
      code: REASONS.DEVICE_NOT_REGISTERED,
      message: `Device ${deviceId} tidak terdaftar untuk user ${user.username}`,
    });
  }

  const accessToken = signAccess(user);
  const refresh = issueRefreshToken(getDb(), user, deviceId);

  auditOk(
    req,
    subject,
    REASONS.ALLOWED,
    'Login berhasil: kredensial valid dan device terdaftar',
    200,
    startedAt,
  );

  return res.status(200).json(
    sessionResponse({
      accessToken,
      refresh,
      user,
      device: { id: deviceId, label: device.label },
    }),
  );
}

module.exports = login;
