'use strict';

const express = require('express');

const config = require('../../shared/config');
const { initSchema, getDb, transaction, closeDb } = require('../../shared/db');
const { sendError, nowIso } = require('../../shared/http');
const { REASONS } = require('../../shared/constants');
const { angkaKeHuruf, validAngka } = require('../../shared/grades');
const { verifyGateway } = require('../../shared/internal');
const { HttpError } = require('../../shared/errors');

initSchema();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'transkrip' });
});

// ── GET /transkrip/:nim ──────────────────────────────────────
app.get('/transkrip/:nim', verifyGateway('access'), (req, res, next) => {
  try {
    const nim = String(req.params.nim);

    if (req.auth.role === 'mahasiswa' && req.auth.nim !== nim) {
      throw new HttpError(
        403,
        REASONS.NOT_OWNER,
        `Mahasiswa ${req.auth.nim} hanya boleh melihat transkrip NIM sendiri`,
      );
    }

    if (req.auth.role !== 'mahasiswa' && req.auth.role !== 'admin') {
      throw new HttpError(
        403,
        REASONS.ROLE_NOT_ALLOWED,
        `Role ${req.auth.role} tidak berhak mengakses transkrip`,
      );
    }

    const db = getDb();
    const mahasiswa = db
      .prepare(`SELECT id, nim, nama FROM users WHERE nim = ? AND role = 'mahasiswa'`)
      .get(nim);

    if (!mahasiswa) {
      throw new HttpError(
        404,
        REASONS.RESOURCE_NOT_FOUND,
        `Mahasiswa dengan NIM ${nim} tidak ditemukan`,
      );
    }

    const data = db
      .prepare(
        `SELECT kelas_id, kode_kelas, nama_mk, sks, nilai_angka, nilai_huruf, updated_at
         FROM transkrip WHERE mahasiswa_id = ? ORDER BY kode_kelas`,
      )
      .all(mahasiswa.id);

    return res.json({
      nim: mahasiswa.nim,
      nama: mahasiswa.nama,
      total_sks: data.reduce((total, item) => total + item.sks, 0),
      data,
    });
  } catch (error) {
    return next(error);
  }
});

// ── POST /transkrip/sinkron (hanya token service) ────────────
app.post('/transkrip/sinkron', verifyGateway('service'), (req, res, next) => {
  try {
    if (req.auth.typ !== 'service' || req.auth.role !== 'service') {
      throw new HttpError(
        403,
        REASONS.SERVICE_TOKEN_REQUIRED,
        'Sinkron transkrip hanya menerima token service',
      );
    }

    const body = req.body ?? {};
    const kelasId = Number(body.kelas_id);

    if (!Number.isSafeInteger(kelasId) || kelasId <= 0) {
      throw new HttpError(400, REASONS.INVALID_REQUEST, 'kelas_id tidak valid');
    }
    if (!Array.isArray(body.items) || body.items.length > 1000) {
      throw new HttpError(
        400,
        REASONS.INVALID_REQUEST,
        'items wajib berupa array (maksimal 1000)',
      );
    }

    const db = getDb();
    const kelas = db
      .prepare('SELECT id, kode_kelas, nama_mk, sks, is_final FROM kelas WHERE id = ?')
      .get(kelasId);

    if (!kelas) {
      throw new HttpError(404, REASONS.RESOURCE_NOT_FOUND, 'Kelas tidak ditemukan');
    }
    if (kelas.is_final !== 1) {
      throw new HttpError(
        409,
        REASONS.NOT_FINAL,
        `Kelas ${kelas.kode_kelas} belum difinalisasi; transkrip tidak boleh diisi`,
      );
    }

    const skipped = [];
    const now = nowIso();

    const synced = transaction((database) => {
      const findMahasiswa = database.prepare(
        `SELECT id FROM users WHERE nim = ? AND role = 'mahasiswa'`,
      );
      const upsert = database.prepare(
        `INSERT INTO transkrip
           (mahasiswa_id, kelas_id, kode_kelas, nama_mk, sks,
            nilai_angka, nilai_huruf, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (mahasiswa_id, kelas_id) DO UPDATE SET
           kode_kelas  = excluded.kode_kelas,
           nama_mk     = excluded.nama_mk,
           sks         = excluded.sks,
           nilai_angka = excluded.nilai_angka,
           nilai_huruf = excluded.nilai_huruf,
           updated_at  = excluded.updated_at`,
      );

      let count = 0;
      for (const item of body.items) {
        const nim = typeof item?.nim === 'string' ? item.nim.trim() : '';
        const angka = item?.nilai_angka;

        if (!nim || !validAngka(angka)) {
          skipped.push({ nim: nim || null, reason: 'NIM atau nilai_angka tidak valid' });
          continue;
        }

        const mahasiswa = findMahasiswa.get(nim);
        if (!mahasiswa) {
          skipped.push({ nim, reason: 'Mahasiswa tidak ditemukan' });
          continue;
        }

        // Huruf selalu dihitung ulang di server, bukan dipercaya dari payload.
        upsert.run(
          mahasiswa.id,
          kelas.id,
          kelas.kode_kelas,
          kelas.nama_mk,
          kelas.sks,
          angka,
          angkaKeHuruf(angka),
          now,
        );
        count += 1;
      }
      return count;
    });

    return res.json({
      kelas_id: kelas.id,
      kode_kelas: kelas.kode_kelas,
      synced,
      skipped: skipped.length,
      skipped_details: skipped.slice(0, 20),
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

  console.error('[transkrip] error:', error);
  return sendError(
    res,
    500,
    REASONS.INTERNAL_ERROR,
    'Terjadi kesalahan internal Service Transkrip',
    req.requestId,
  );
});

let shuttingDown = false;

const server = app.listen(config.ports.transkrip, config.host, () => {
  console.log(
    `[transkrip] Resource Service berjalan di http://${config.host}:${config.ports.transkrip}`,
  );
  console.log('[transkrip] wajib X-Gateway-Secret + JWT valid pada setiap request');
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[transkrip] ${signal} diterima, menutup server...`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
