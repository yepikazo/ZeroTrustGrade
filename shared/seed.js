'use strict';

/**
 * Reset database + isi data awal.
 * Jalankan: npm run seed
 *
 * PERINGATAN: seluruh tabel dihapus. Jangan jalankan saat data demo penting
 * belum dicadangkan.
 */

const bcrypt = require('bcryptjs');
const config = require('./config');
const { getDb, initSchema, closeDb } = require('./db');
const { angkaKeHuruf } = require('./grades');
const { hashToken } = require('./secrets');
const { nowIso } = require('./http');

const PASSWORD = {
  admin: 'Admin#123',
  dosen: 'Dosen#123',
  mahasiswa: 'Mhs#123',
};

function resetSchema(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS transkrip;
    DROP TABLE IF EXISTS nilai;
    DROP TABLE IF EXISTS refresh_tokens;
    DROP TABLE IF EXISTS devices;
    DROP TABLE IF EXISTS kelas;
    DROP TABLE IF EXISTS service_clients;
    DROP TABLE IF EXISTS users;
  `);
  db.exec('PRAGMA foreign_keys = ON');
  initSchema();
}

function insertUser(db, user) {
  const result = db
    .prepare(
      `INSERT INTO users (username, password_hash, nama, role, nim, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.username,
      bcrypt.hashSync(user.password, 10),
      user.nama,
      user.role,
      user.nim ?? null,
      nowIso(),
    );
  return Number(result.lastInsertRowid);
}

function insertDevice(db, userId, deviceId, label) {
  db.prepare(
    `INSERT INTO devices (user_id, device_id, label, active, created_at)
     VALUES (?, ?, ?, 1, ?)`,
  ).run(userId, deviceId, label, nowIso());
}

function insertKelas(db, kode, namaMk, sks, dosenId) {
  const result = db
    .prepare(
      `INSERT INTO kelas (kode_kelas, nama_mk, sks, dosen_id, is_final, sync_status)
       VALUES (?, ?, ?, ?, 0, 'pending')`,
    )
    .run(kode, namaMk, sks, dosenId);
  return Number(result.lastInsertRowid);
}

function insertNilai(db, kelasId, mahasiswaId, angka) {
  db.prepare(
    `INSERT INTO nilai (kelas_id, mahasiswa_id, nilai_angka, nilai_huruf, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(kelasId, mahasiswaId, angka, angkaKeHuruf(angka), nowIso());
}

function main() {
  const db = getDb();
  resetSchema(db);

  const now = nowIso();

  const adminId = insertUser(db, {
    username: 'admin',
    password: PASSWORD.admin,
    nama: 'Admin Prodi Informatika',
    role: 'admin',
  });

  const dosen1Id = insertUser(db, {
    username: 'dosen1',
    password: PASSWORD.dosen,
    nama: 'Dr. Ani Rahmawati, M.Kom.',
    role: 'dosen',
  });

  const dosen2Id = insertUser(db, {
    username: 'dosen2',
    password: PASSWORD.dosen,
    nama: 'Budi Santoso, M.Kom.',
    role: 'dosen',
  });

  const mhs1Id = insertUser(db, {
    username: 'mhs1',
    password: PASSWORD.mahasiswa,
    nama: 'Citra Lestari',
    role: 'mahasiswa',
    nim: '2021001',
  });

  const mhs2Id = insertUser(db, {
    username: 'mhs2',
    password: PASSWORD.mahasiswa,
    nama: 'Dedi Pratama',
    role: 'mahasiswa',
    nim: '2021002',
  });

  const mhs3Id = insertUser(db, {
    username: 'mhs3',
    password: PASSWORD.mahasiswa,
    nama: 'Eka Putri',
    role: 'mahasiswa',
    nim: '2021003',
  });

  insertDevice(db, adminId, 'dev-admin-01', 'Laptop Admin');
  insertDevice(db, dosen1Id, 'dev-dosen1-01', 'Laptop Dosen 1');
  insertDevice(db, dosen2Id, 'dev-dosen2-01', 'Laptop Dosen 2');
  insertDevice(db, mhs1Id, 'dev-mhs1-01', 'HP Citra');
  insertDevice(db, mhs2Id, 'dev-mhs2-01', 'HP Dedi');
  insertDevice(db, mhs3Id, 'dev-mhs3-01', 'HP Eka');

  const kelasIf101 = insertKelas(db, 'IF101', 'Pemrograman Web', 3, dosen1Id);
  const kelasIf201 = insertKelas(db, 'IF201', 'Basis Data', 3, dosen2Id);

  insertNilai(db, kelasIf101, mhs1Id, 82);
  insertNilai(db, kelasIf101, mhs2Id, 78);
  insertNilai(db, kelasIf201, mhs2Id, 88);
  insertNilai(db, kelasIf201, mhs3Id, 91);

  db.prepare(
    `INSERT INTO service_clients (client_id, secret_hash, name, active, created_at)
     VALUES (?, ?, ?, 1, ?)`,
  ).run(
    config.serviceClient.id,
    hashToken(config.serviceClient.secret),
    'Service Nilai',
    now,
  );

  const counts = {
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    devices: db.prepare('SELECT COUNT(*) AS n FROM devices').get().n,
    kelas: db.prepare('SELECT COUNT(*) AS n FROM kelas').get().n,
    nilai: db.prepare('SELECT COUNT(*) AS n FROM nilai').get().n,
  };

  console.log('\n✓ Database di-reset dan diisi data awal');
  console.log(`  Lokasi : ${config.dbPath}`);
  console.log(
    `  Isi    : ${counts.users} user, ${counts.devices} device, ${counts.kelas} kelas, ${counts.nilai} nilai\n`,
  );

  console.log('Akun & device terdaftar');
  console.log('┌──────────┬────────────┬──────────────────────────────┬─────────────────┐');
  console.log('│ Username │ Role       │ Nama                         │ Device ID       │');
  console.log('├──────────┼────────────┼──────────────────────────────┼─────────────────┤');
  const rows = db
    .prepare(
      `SELECT u.username, u.role, u.nama, d.device_id
       FROM users u JOIN devices d ON d.user_id = u.id
       ORDER BY u.id`,
    )
    .all();
  for (const row of rows) {
    console.log(
      `│ ${row.username.padEnd(8)} │ ${row.role.padEnd(10)} │ ${row.nama.padEnd(28)} │ ${row.device_id.padEnd(15)} │`,
    );
  }
  console.log('└──────────┴────────────┴──────────────────────────────┴─────────────────┘');

  console.log('\nPassword seed');
  console.log(`  admin            : ${PASSWORD.admin}`);
  console.log(`  dosen1 / dosen2  : ${PASSWORD.dosen}`);
  console.log(`  mhs1 / mhs2 / mhs3: ${PASSWORD.mahasiswa}`);

  console.log('\nKelas');
  for (const row of db
    .prepare(
      `SELECT k.kode_kelas, k.nama_mk, u.nama AS dosen
       FROM kelas k JOIN users u ON u.id = k.dosen_id ORDER BY k.id`,
    )
    .all()) {
    console.log(`  ${row.kode_kelas} — ${row.nama_mk} (${row.dosen})`);
  }

  console.log('\nService client');
  console.log(`  client_id     : ${config.serviceClient.id}`);
  console.log(`  client_secret : ${config.serviceClient.secret}  (hanya di .env)`);

  closeDb();
}

try {
  main();
} catch (error) {
  console.error('\n✗ Seed gagal:', error.message);
  closeDb();
  process.exitCode = 1;
}
