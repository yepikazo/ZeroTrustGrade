'use strict';

const config = require('../../shared/config');
const { getDb, transaction } = require('../../shared/db');
const { nowIso } = require('../../shared/http');
const { randomToken, hashToken } = require('../../shared/secrets');

const USER_COLUMNS =
  'id, username, nama, role, nim, password_hash, created_at';

function findUserByUsername(username) {
  return getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`)
    .get(username);
}

function findActiveDevice(deviceId, userId) {
  return getDb()
    .prepare(
      'SELECT id, label FROM devices WHERE device_id = ? AND user_id = ? AND active = 1',
    )
    .get(deviceId, userId);
}

function findRefreshToken(refreshToken) {
  return getDb()
    .prepare(
      `SELECT rt.*, u.username, u.nama, u.role, u.nim
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = ?`,
    )
    .get(hashToken(refreshToken));
}

function issueRefreshToken(db, user, deviceId) {
  const refreshToken = randomToken(32);
  const expiresAt = new Date(
    Date.now() + config.jwt.refreshTtl * 1000,
  ).toISOString();
  const result = db
    .prepare(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      hashToken(refreshToken),
      deviceId,
      expiresAt,
      nowIso(),
    );

  return {
    refreshToken,
    refreshId: Number(result.lastInsertRowid),
    expiresAt,
  };
}

function revokeRefreshToken(id) {
  getDb()
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?')
    .run(nowIso(), id);
}

function revokeAllRefreshTokens(userId) {
  getDb()
    .prepare(
      `UPDATE refresh_tokens SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .run(nowIso(), userId);
}

function rotateRefreshToken(row, user, deviceId) {
  return transaction((database) => {
    const next = issueRefreshToken(database, user, deviceId);
    database
      .prepare(
        'UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ?',
      )
      .run(nowIso(), next.refreshId, row.id);
    return next;
  });
}

function findServiceClient(clientId) {
  return getDb()
    .prepare('SELECT * FROM service_clients WHERE client_id = ? AND active = 1')
    .get(clientId);
}

module.exports = {
  findUserByUsername,
  findActiveDevice,
  findRefreshToken,
  issueRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  rotateRefreshToken,
  findServiceClient,
};
