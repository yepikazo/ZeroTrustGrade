'use strict';

const express = require('express');

const config = require('../../shared/config');
const { initSchema, getDb, transaction, closeDb } = require('../../shared/db');
const { sendError, accessWindowStatus, nowIso } = require('../../shared/http');
const { REASONS } = require('../../shared/constants');
const { angkaKeHuruf, validAngka } = require('../../shared/grades');
const { verifyGateway } = require('../../shared/internal');
const { HttpError } = require('../../shared/errors');
const { syncKelas } = require('./sync');

initSchema();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

const NILAI_SELECT = `
  SELECT n.id, n.kelas_id, k.kode_kelas, k.nama_mk, k.sks, k.is_final,
         u.nim, u.nama AS mahasiswa, n.nilai_angka, n.nilai_huruf,
         n.updated_at, n.updated_by
  FROM nilai n
  JOIN kelas k ON k.id = n.kelas_id
  JOIN users u ON u.id = n.mahasiswa_id
`;

const KELAS_SELECT = `
  SELECT k.id, k.kode_kelas, k.nama_mk, k.sks, k.dosen_id,
         u.username AS dosen, k.is_final, k.finalized_at, k.sync_status, k.synced_at
  FROM kelas k JOIN users u ON u.id = k.dosen_id
`;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'nilai' });
});

// ── GET /nilai ───────────────────────────────────────────────
// Scope TIDAK diambil dari query parameter; client tidak bisa meminta nilai
// mahasiswa lain dengan mengubah URL.
app.get('/nilai', verifyGateway('access'), (req, res, next) => {
  try {
    const userId = Number(req.auth.sub);
    const db = getDb();
    let rows;

    if (req.auth.role === 'mahasiswa') {
      rows = db
        .prepare(`${NILAI_SELECT} WHERE n.mahasiswa_id = ? ORDER BY k.kode_kelas`)
        .all(userId);
    } else if (req.auth.role === 'dosen') {
      rows = db
        .prepare(`${NILAI_SELECT} WHERE k.dosen_id = ? ORDER BY k.kode_kelas, u.nim`)
        .all(userId);
    } else {
      throw new HttpError(
        403,
        REASONS.ROLE_NOT_ALLOWED,
        `Role ${req.auth.role} tidak berhak melihat nilai`,
      );
    }

    return res.json({
      scope: req.auth.role === 'mahasiswa' ? 'self' : 'dosen',
      data: rows,
    });
  } catch (error) {
    return next(error);
  }
});

// ── PUT /nilai/:id ───────────────────────────────────────────
app.put('/nilai/:id', verifyGateway('access'), (req, res, next) => {
  try {
    if (req.auth.role !== 'dosen') {
      throw new HttpError(
        403,
        REASONS.ROLE_NOT_ALLOWED,
        'Hanya dosen yang boleh mengubah nilai',
      );
    }

    const nilaiId = Number(req.params.id);
    if (!Number.isSafeInteger(nilaiId) || nilaiId <= 0) {
      throw new HttpError(400, REASONS.INVALID_REQUEST, 'ID nilai tidak valid');
    }

    const angka = req.body?.nilai_angka;
    if (!validAngka(angka)) {
      throw new HttpError(
        400,
        REASONS.INVALID_REQUEST,
        'nilai_angka wajib berupa angka 0-100',
      );
    }

    const userId = Number(req.auth.sub);
    const huruf = angkaKeHuruf(angka);

    const updated = transaction((db) => {
      const row = db
        .prepare(
          `SELECT n.id, n.kelas_id, k.kode_kelas, k.dosen_id, k.is_final
           FROM nilai n JOIN kelas k ON k.id = n.kelas_id
           WHERE n.id = ?`,
        )
        .get(nilaiId);

      if (!row) {
        throw new HttpError(404, REASONS.RESOURCE_NOT_FOUND, 'Nilai tidak ditemukan');
      }

      if (row.dosen_id !== userId) {
        throw new HttpError(
          403,
          REASONS.NOT_OWNER,
          `Kelas ${row.kode_kelas} bukan kelas yang Anda ampu`,
        );
      }

      if (row.is_final === 1) {
        throw new HttpError(
          409,
          REASONS.ALREADY_FINAL,
          `Nilai kelas ${row.kode_kelas} sudah difinalisasi`,
        );
      }

      const window = accessWindowStatus();
      if (!window.allowed) {
        throw new HttpError(403, REASONS.OUTSIDE_ACCESS_HOURS, window.reason);
      }

      db.prepare(
        `UPDATE nilai
         SET nilai_angka = ?, nilai_huruf = ?, updated_at = ?, updated_by = ?
         WHERE id = ?`,
      ).run(angka, huruf, nowIso(), userId, nilaiId);

      return db.prepare(`${NILAI_SELECT} WHERE n.id = ?`).get(nilaiId);
    });

    return res.json({ data: updated });
  } catch (error) {
    return next(error);
  }
});

// ── POST /kelas/:id/finalisasi ───────────────────────────────
app.post('/kelas/:id/finalisasi', verifyGateway('access'), async (req, res, next) => {
  try {
    if (req.auth.role !== 'dosen') {
      throw new HttpError(
        403,
        REASONS.ROLE_NOT_ALLOWED,
        'Hanya dosen yang boleh memfinalisasi nilai',
      );
    }

    const kelasId = Number(req.params.id);
    if (!Number.isSafeInteger(kelasId) || kelasId <= 0) {
      throw new HttpError(400, REASONS.INVALID_REQUEST, 'ID kelas tidak valid');
    }

    const userId = Number(req.auth.sub);

    transaction((db) => {
      const kelas = db
        .prepare('SELECT id, kode_kelas, dosen_id, is_final FROM kelas WHERE id = ?')
        .get(kelasId);

      if (!kelas) {
        throw new HttpError(404, REASONS.RESOURCE_NOT_FOUND, 'Kelas tidak ditemukan');
      }

      if (kelas.dosen_id !== userId) {
        throw new HttpError(
          403,
          REASONS.NOT_OWNER,
          `Kelas ${kelas.kode_kelas} bukan kelas yang Anda ampu`,
        );
      }

      if (kelas.is_final === 1) {
        throw new HttpError(
          409,
          REASONS.ALREADY_FINAL,
          `Kelas ${kelas.kode_kelas} sudah difinalisasi`,
        );
      }

      const window = accessWindowStatus();
      if (!window.allowed) {
        throw new HttpError(403, REASONS.OUTSIDE_ACCESS_HOURS, window.reason);
      }

      db.prepare(
        `UPDATE kelas
         SET is_final = 1, finalized_at = ?, sync_status = 'pending'
         WHERE id = ?`,
      ).run(nowIso(), kelasId);
    });

    const sync = await syncKelas(kelasId);
    const kelas = getDb().prepare(`${KELAS_SELECT} WHERE k.id = ?`).get(kelasId);

    if (sync.status !== 'synced') {
      return sendError(
        res,
        502,
        REASONS.TRANSCRIPT_SYNC_FAILED,
        `Nilai kelas ${kelas.kode_kelas} sudah final, tetapi sinkron transkrip gagal: ${sync.error}`,
        req.requestId,
        { finalized: true, kelas, sync },
      );
    }

    return res.json({
      message: `Kelas ${kelas.kode_kelas} difinalisasi dan transkrip tersinkron`,
      kelas,
      sync,
    });
  } catch (error) {
    return next(error);
  }
});

// ── POST /kelas/:id/sinkron (retry jika sinkron gagal) ────────
app.post('/kelas/:id/sinkron', verifyGateway('access'), async (req, res, next) => {
  try {
    if (req.auth.role !== 'dosen') {
      throw new HttpError(
        403,
        REASONS.ROLE_NOT_ALLOWED,
        'Hanya dosen yang boleh menyinkronkan transkrip kelas',
      );
    }

    const kelasId = Number(req.params.id);
    if (!Number.isSafeInteger(kelasId) || kelasId <= 0) {
      throw new HttpError(400, REASONS.INVALID_REQUEST, 'ID kelas tidak valid');
    }

    const userId = Number(req.auth.sub);
    const kelas = getDb()
      .prepare('SELECT id, kode_kelas, dosen_id, is_final FROM kelas WHERE id = ?')
      .get(kelasId);

    if (!kelas) {
      throw new HttpError(404, REASONS.RESOURCE_NOT_FOUND, 'Kelas tidak ditemukan');
    }
    if (kelas.dosen_id !== userId) {
      throw new HttpError(
        403,
        REASONS.NOT_OWNER,
        `Kelas ${kelas.kode_kelas} bukan kelas yang Anda ampu`,
      );
    }
    if (kelas.is_final !== 1) {
      throw new HttpError(
        409,
        REASONS.NOT_FINAL,
        `Kelas ${kelas.kode_kelas} belum difinalisasi`,
      );
    }

    const sync = await syncKelas(kelasId);
    const fresh = getDb().prepare(`${KELAS_SELECT} WHERE k.id = ?`).get(kelasId);

    if (sync.status !== 'synced') {
      return sendError(
        res,
        502,
        REASONS.TRANSCRIPT_SYNC_FAILED,
        `Sinkron ulang gagal: ${sync.error}`,
        req.requestId,
        { finalized: true, kelas: fresh, sync },
      );
    }

    return res.json({
      message: `Transkrip kelas ${fresh.kode_kelas} berhasil disinkronkan ulang`,
      kelas: fresh,
      sync,
    });
  } catch (error) {
    return next(error);
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof HttpError) {
    return sendError(
      res,
      error.status,
      error.code,
      error.message,
      req.requestId,
    );
  }

  if (error.type === 'entity.parse.failed') {
    return sendError(
      res,
      400,
      REASONS.INVALID_REQUEST,
      'Body JSON tidak valid',
      req.requestId,
    );
  }

  console.error('[nilai] error:', error);
  return sendError(
    res,
    500,
    REASONS.INTERNAL_ERROR,
    'Terjadi kesalahan internal Service Nilai',
    req.requestId,
  );
});

let shuttingDown = false;

const server = app.listen(config.ports.nilai, config.host, () => {
  console.log(
    `[nilai] Resource Service berjalan di http://${config.host}:${config.ports.nilai}`,
  );
  console.log('[nilai] wajib X-Gateway-Secret + JWT valid pada setiap request');
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[nilai] ${signal} diterima, menutup server...`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
