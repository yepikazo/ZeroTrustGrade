'use strict';

const { getDb } = require('../../shared/db');
const { nowIso } = require('../../shared/http');
const { syncTranscript } = require('./transkripClient');

/**
 * Mengirim nilai final sebuah kelas ke Service Transkrip lewat gateway.
 * Sinkron bersifat idempotent di sisi Transkrip (upsert per mahasiswa+kelas),
 * sehingga aman dipanggil ulang.
 */
async function syncKelas(kelasId) {
  const db = getDb();
  const kelas = db.prepare('SELECT * FROM kelas WHERE id = ?').get(kelasId);

  if (!kelas) {
    return { status: 'failed', error: 'Kelas tidak ditemukan' };
  }

  const items = db
    .prepare(
      `SELECT u.nim, u.nama, n.nilai_angka, n.nilai_huruf
       FROM nilai n JOIN users u ON u.id = n.mahasiswa_id
       WHERE n.kelas_id = ? AND n.nilai_angka IS NOT NULL
       ORDER BY u.nim`,
    )
    .all(kelasId);

  const payload = {
    kelas_id: kelas.id,
    kode_kelas: kelas.kode_kelas,
    nama_mk: kelas.nama_mk,
    sks: kelas.sks,
    items: items.map((item) => ({
      nim: item.nim,
      nama: item.nama,
      nilai_angka: item.nilai_angka,
      nilai_huruf: item.nilai_huruf,
    })),
  };

  try {
    const result = await syncTranscript(payload);
    db.prepare(
      'UPDATE kelas SET sync_status = ?, synced_at = ? WHERE id = ?',
    ).run('synced', nowIso(), kelasId);

    return {
      status: 'synced',
      synced: result.synced ?? items.length,
      skipped: result.skipped ?? 0,
    };
  } catch (error) {
    db.prepare('UPDATE kelas SET sync_status = ? WHERE id = ?').run(
      'failed',
      kelasId,
    );

    return {
      status: 'failed',
      error: error.message,
      code: error.code ?? 'TRANSCRIPT_SYNC_FAILED',
    };
  }
}

module.exports = { syncKelas };
