-- Skema database bersama untuk Gateway, Service Nilai, dan Service Transkrip.
-- Dijalankan idempoten saat startup; `npm run seed` melakukan reset + isi data awal.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  nama          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'dosen', 'mahasiswa')),
  nim           TEXT    UNIQUE,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  TEXT    NOT NULL UNIQUE,
  label      TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- Refresh token disimpan sebagai hash SHA-256, bukan plaintext.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  device_id    TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  revoked_at   TEXT,
  replaced_by  INTEGER,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_hash ON refresh_tokens(token_hash);

CREATE TABLE IF NOT EXISTS service_clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT    NOT NULL UNIQUE,
  secret_hash TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS kelas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kode_kelas   TEXT    NOT NULL UNIQUE,
  nama_mk      TEXT    NOT NULL,
  sks          INTEGER NOT NULL,
  dosen_id     INTEGER NOT NULL REFERENCES users(id),
  is_final     INTEGER NOT NULL DEFAULT 0,
  finalized_at TEXT,
  sync_status  TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (sync_status IN ('pending', 'synced', 'failed')),
  synced_at    TEXT
);

CREATE TABLE IF NOT EXISTS nilai (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kelas_id      INTEGER NOT NULL REFERENCES kelas(id) ON DELETE CASCADE,
  mahasiswa_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nilai_angka   REAL,
  nilai_huruf   TEXT,
  updated_at    TEXT,
  updated_by    INTEGER REFERENCES users(id),
  UNIQUE (kelas_id, mahasiswa_id)
);
CREATE INDEX IF NOT EXISTS idx_nilai_kelas ON nilai(kelas_id);
CREATE INDEX IF NOT EXISTS idx_nilai_mahasiswa ON nilai(mahasiswa_id);

-- Transkrip hanya berisi nilai yang sudah difinalisasi (hasil sinkron).
CREATE TABLE IF NOT EXISTS transkrip (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mahasiswa_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kelas_id     INTEGER NOT NULL REFERENCES kelas(id) ON DELETE CASCADE,
  kode_kelas   TEXT    NOT NULL,
  nama_mk      TEXT    NOT NULL,
  sks          INTEGER NOT NULL,
  nilai_angka  REAL    NOT NULL,
  nilai_huruf  TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  UNIQUE (mahasiswa_id, kelas_id)
);
CREATE INDEX IF NOT EXISTS idx_transkrip_mahasiswa ON transkrip(mahasiswa_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT    NOT NULL,
  request_id   TEXT    NOT NULL,
  subject_type TEXT    NOT NULL,
  subject_id   TEXT,
  username     TEXT,
  role         TEXT,
  method       TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  device_id    TEXT,
  decision     TEXT    NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason_code  TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  status_code  INTEGER,
  latency_ms   INTEGER,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);
CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_logs(decision);
