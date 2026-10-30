# ZeroTrustGrade

Sistem Nilai dengan penerapan **Zero Trust Security** untuk tugas praktikum
Keamanan Informasi (KP70065004), Informatika Universitas Siliwangi.

Seluruh akses melewati **API Gateway** sebagai *Policy Enforcement Point* (PEP).
Gateway meminta keputusan ke **Policy Engine** yang membaca atribut dari database,
mencatat **audit log**, lalu meneruskan request. Service Nilai dan Service Transkrip
tetap memverifikasi **gateway secret** dan **JWT** sendiri, sehingga tidak dapat
diakses langsung.

---

## 1. Arsitektur

```
                       +--------------------------------+
   curl / Postman ---> |  API Gateway :3000             |
                       |  PEP + Policy Engine + Audit   |
                       |  Auth (login/refresh/logout)   |
                       +------+------------------+------+
                              |                  |
             X-Gateway-Secret |                  | X-Gateway-Secret
             + access token   |                  | + token service
                              v                  v
                    +------------------+   +---------------------+
                    | Service Nilai    |   | Service Transkrip   |
                    | :3001            |   | :3002               |
                    +--------+---------+   +----------+----------+
                             |                        |
                             +-----------+------------+
                                         v
                              +------------------------+
                              | SQLite data/app.sqlite |
                              | users, devices, kelas, |
                              | nilai, transkrip,      |
                              | refresh_tokens, audit  |
                              +------------------------+
```

Alur satu request user:

1. Client mengirim `Authorization: Bearer <access>` dan `X-Device-ID`.
2. Gateway memverifikasi JWT, tipe token, dan device terdaftar milik user.
3. Policy Engine memutuskan **allow/deny** berdasarkan role + data di database
   (pemilik kelas, NIM, status final) + jam akses.
4. Gateway menulis audit log, lalu meneruskan request dengan
   `X-Gateway-Secret` dan header identitas hasil verifikasi.
5. Service memverifikasi ulang gateway secret + JWT + kecocokan identitas.
6. Response kembali ke client; gateway melengkapi status code pada audit.

Panggilan Service Nilai → Service Transkrip juga melalui gateway memakai
**token service** (bukan koneksi langsung ke port 3002).

---

## 2. Persyaratan

- **Node.js >= 22.5** (memakai modul bawaan `node:sqlite`, tanpa kompilasi native)
- npm
- Tidak perlu Docker, MySQL, atau Laragon. Semua berjalan di satu komputer.

```bash
node -v   # pastikan v22.5 atau lebih baru
```

---

## 3. Menjalankan

```bash
# 1. Buat .env + secret acak (atau salin manual .env.example -> .env)
npm run setup

# 2. Install dependency
npm install

# 3. Reset + isi data awal
npm run seed

# 4. Jalankan ketiga komponen (Transkrip -> Nilai -> Gateway)
npm run dev
```

Keluaran yang diharapkan:

```
[dev] menyalakan Service Transkrip...
[transkrip] Resource Service berjalan di http://127.0.0.1:3002
[dev] menyalakan Service Nilai...
[nilai] Resource Service berjalan di http://127.0.0.1:3001
[dev] menyalakan API Gateway...
[gateway] PEP berjalan di http://127.0.0.1:3000
[gateway] jam akses -> 07:00-21:00 Asia/Jakarta (aktif)
```

Hentikan dengan `Ctrl+C`. Untuk menjalankan komponen terpisah:

```bash
npm run start:transkrip
npm run start:nilai
npm run start:gateway
```

> `.env` berisi secret lokal. Jangan commit file tersebut. Untuk mengubah secret,
> jalankan `npm run setup -- --force`, lalu `npm run seed` lagi agar hash client
> secret di database ikut diperbarui.

---

## 4. Akun, Device ID, dan Data Seed

### Akun

| Username | Password | Role | Nama | Device ID |
|---|---|---|---|---|
| `admin` | `Admin#123` | admin | Admin Prodi Informatika | `dev-admin-01` |
| `dosen1` | `Dosen#123` | dosen | Prof. Wiener Peter S.Kom, M.Kom, CEH, CCNA, MTCNA, IPU, ASEAN ENG | `dev-dosen1-01` |
| `dosen2` | `Dosen#123` | dosen | Carlos M.Kom | `dev-dosen2-01` |
| `mhs1` | `Mhs#123` | mahasiswa | Yasraf (`2470061110700`) | `dev-mhs1-01` |
| `mhs2` | `Mhs#123` | mahasiswa | Syifa (`2470061110701`) | `dev-mhs2-01` |
| `mhs3` | `Mhs#123` | mahasiswa | Maulana (`2470061110702`) | `dev-mhs3-01` |

Setiap user hanya memiliki **satu device terdaftar** pada data awal.

### Kelas

| Kode | Mata Kuliah | SKS | Dosen | Mahasiswa | Nilai awal |
|---|---|---|---|---|---|
| `IF101` | Keamanan Informasi | 3 | dosen1 | mhs1, mhs2 | 82, 78 |
| `IF201` | Komputasi Paralel | 3 | dosen2 | mhs2, mhs3 | 88, 91 |

`mhs2` sengaja terdaftar di dua kelas untuk menguji isolasi data dan transkrip
lintas mata kuliah. Transkrip awalnya kosong dan baru terisi setelah finalisasi.

### Service client

| Client ID | Secret | Token |
|---|---|---|
| `nilai-service` | `svc-nilai-secret-2026` (dari `.env`) | JWT 5 menit, `role: service` |

---

## 5. API

Semua endpoint resource diakses melalui `http://127.0.0.1:3000`.
Contoh di bawah memakai `curl`; koleksi Postman tersedia di
[`postman/ZeroTrustGrade.postman_collection.json`](postman/ZeroTrustGrade.postman_collection.json).

### 5.1 Login

```bash
curl -s -X POST http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Device-ID: dev-mhs1-01' \
  -d '{"username":"mhs1","password":"Mhs#123"}'
```

Response:

```json
{
  "token_type": "Bearer",
  "access_token": "<JWT 10 menit>",
  "expires_in": 600,
  "refresh_token": "<token acak 1 hari>",
  "refresh_expires_in": 86400,
  "user": { "id": 4, "username": "mhs1", "role": "mahasiswa", "nim": "2470061110700" },
  "device": { "id": "dev-mhs1-01", "label": "Arch Linux Yasraf" }
}
```

Simpan token untuk contoh berikut:

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -H 'X-Device-ID: dev-mhs1-01' \
  -d '{"username":"mhs1","password":"Mhs#123"}' | jq -r .access_token)
```

### 5.2 Refresh & logout

```bash
curl -s -X POST http://127.0.0.1:3000/auth/refresh \
  -H 'Content-Type: application/json' \
  -H 'X-Device-ID: dev-mhs1-01' \
  -d '{"refresh_token":"<refresh>"}'

curl -s -X POST http://127.0.0.1:3000/auth/logout \
  -H 'Content-Type: application/json' \
  -d '{"refresh_token":"<refresh>"}'
```

Refresh melakukan **rotasi**: token lama dicabut, token baru diterbitkan. Jika
token lama dipakai lagi, seluruh sesi user dicabut (*assume breach*).

### 5.3 Nilai

```bash
# Mahasiswa: hanya nilai sendiri
curl -s http://127.0.0.1:3000/nilai \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Device-ID: dev-mhs1-01'

# Dosen: hanya kelas yang diampu
curl -s -X PUT http://127.0.0.1:3000/nilai/1 \
  -H "Authorization: Bearer $DOSEN" \
  -H 'X-Device-ID: dev-dosen1-01' \
  -H 'Content-Type: application/json' \
  -d '{"nilai_angka":86}'

# Finalisasi -> otomatis memanggil sinkron transkrip lewat gateway
curl -s -X POST http://127.0.0.1:3000/kelas/1/finalisasi \
  -H "Authorization: Bearer $DOSEN" \
  -H 'X-Device-ID: dev-dosen1-01'
```

Nilai huruf dihitung server: `>=85 A`, `>=75 B`, `>=65 C`, `>=55 D`, selain itu `E`.

### 5.4 Transkrip

```bash
# Mahasiswa (NIM sendiri) atau admin (semua NIM)
curl -s http://127.0.0.1:3000/transkrip/2470061110700 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Device-ID: dev-mhs1-01'

# Sinkron hanya untuk token service (dipanggil Service Nilai)
curl -s -X POST http://127.0.0.1:3000/transkrip/sinkron \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "kelas_id": 1,
    "items": [
      { "nim": "2470061110700", "nilai_angka": 86 },
      { "nim": "2470061110701", "nilai_angka": 78 }
    ]
  }'
```

### 5.5 Token service

```bash
curl -s -X POST http://127.0.0.1:3000/auth/service \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"nilai-service","client_secret":"svc-nilai-secret-2026"}'
```

### 5.6 Format error

```json
{
  "error": {
    "code": "NOT_OWNER",
    "message": "Kelas IF101 bukan kelas yang Anda ampu",
    "request_id": "b1f0..."
  }
}
```

| HTTP | Arti | Contoh kode |
|---|---|---|
| 400 | Request tidak valid | `INVALID_REQUEST` |
| 401 | Autentikasi gagal | `NO_TOKEN`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `WRONG_TOKEN_TYPE`, `REFRESH_REVOKED` |
| 403 | Kebijakan menolak | `DEVICE_MISSING`, `DEVICE_NOT_REGISTERED`, `ROLE_NOT_ALLOWED`, `NOT_OWNER`, `OUTSIDE_ACCESS_HOURS`, `SERVICE_TOKEN_REQUIRED` |
| 404 | Resource tidak ada | `RESOURCE_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 409 | Konflik status | `ALREADY_FINAL`, `NOT_FINAL` |
| 502/504 | Service tujuan gagal/timeout | `TRANSCRIPT_SYNC_FAILED`, `UPSTREAM_ERROR` |

---

## 6. Matriks Kebijakan (Tabel 3)

| Endpoint | Role | Keputusan Policy Engine |
|---|---|---|
| `POST /auth/login` | semua | Kredensial valid + device terdaftar |
| `POST /auth/refresh` | semua | Refresh valid, belum dicabut, belum kedaluwarsa, device cocok |
| `POST /auth/logout` | semua | Refresh token dicabut (idempotent) |
| `POST /auth/service` | Service Nilai | Client ID + secret valid (hash di database) |
| `GET /nilai` | mahasiswa, dosen | Scope dari token: NIM sendiri / kelas yang diampu. Query client diabaikan |
| `PUT /nilai/:id` | dosen | `kelas.dosen_id = sub`, belum final, pukul 07.00–21.00 |
| `POST /kelas/:id/finalisasi` | dosen | Pemilik kelas, belum final, jam akses; lalu sinkron transkrip |
| `GET /transkrip/:nim` | mahasiswa, admin | Mahasiswa hanya NIM sendiri; admin semua NIM |
| `POST /transkrip/sinkron` | Service Nilai | Hanya token `typ=service`; token user ditolak |
| `POST /kelas/:id/sinkron` | dosen | Tambahan: retry sinkron jika panggilan sebelumnya gagal |

Admin **tidak** memiliki akses ke `/nilai`, dan dosen **tidak** memiliki akses ke
`/transkrip`, sesuai Tabel 3.

---

## 7. Penerapan Kebutuhan Bagian 4

### 4.1 Autentikasi dan Token

| Kebutuhan | Implementasi |
|---|---|
| Access token 10 menit, `sub` + `role` | [`shared/jwt.js`](shared/jwt.js) — `signAccess`, `verifyBearer`; TTL dari `ACCESS_TOKEN_TTL=600` |
| Refresh token 1 hari, tersimpan, dapat dicabut | [`shared/schema.sql`](shared/schema.sql) tabel `refresh_tokens`; [`gateway/auth/store.js`](gateway/auth/store.js) — hash SHA-256, rotasi, logout mencabut |
| Token service 5 menit, `role: service` | [`gateway/auth/service.js`](gateway/auth/service.js) `POST /auth/service` + [`shared/jwt.js`](shared/jwt.js) `signService` |
| Gateway secret | [`gateway/proxy.js`](gateway/proxy.js) menambahkan `X-Gateway-Secret`; [`shared/internal.js`](shared/internal.js) memverifikasi constant-time |
| Verifikasi ulang di service | [`shared/internal.js`](shared/internal.js) — cek secret, signature, `exp`, audience, `typ`, dan kecocokan header identitas |

Secret access token dan service token **berbeda**. Service token tidak bisa dipakai
di endpoint user karena `typ` diperiksa.

### 4.2 Kebijakan Akses

- [`gateway/policy.js`](gateway/policy.js) adalah Policy Engine. Keputusan
  kepemilikan diambil dari database, bukan dari isi token:
  - `PUT /nilai/:id` → baca `nilai` join `kelas`, bandingkan `kelas.dosen_id`.
  - `POST /kelas/:id/finalisasi` → cek `dosen_id` dan `is_final`.
  - `GET /transkrip/:nim` → bandingkan `users.nim` dengan `sub`/`nim` pada token.
- [`services/nilai/server.js`](services/nilai/server.js) dan
  [`services/transkrip/server.js`](services/transkrip/server.js) mengulang cek
  kepemilikan sebagai pertahanan berlapis.
- Panggilan antar-service: [`services/nilai/transkripClient.js`](services/nilai/transkripClient.js)
  meminta token service lalu `POST /transkrip/sinkron` **ke gateway**, bukan
  langsung ke port 3002.

### 4.3 Verifikasi Konteks

- **Device**: tabel `devices`; [`gateway/authenticate.js`](gateway/authenticate.js)
  menolak request tanpa `X-Device-ID` atau device milik user lain. Login juga
  memeriksa device sebelum menerbitkan token.
- **Jam akses**: [`shared/http.js`](shared/http.js) `accessWindowStatus()`,
  hanya diterapkan pada `PUT /nilai/:id` dan finalisasi. Dikonfigurasi lewat
  `ACCESS_START`, `ACCESS_END`, `APP_TZ`; mendukung rentang melewati tengah malam.
- **Demo jam akses** tanpa mengubah kode:

  ```bash
  # terminal 1 — gateway dengan jendela yang tidak mencakup waktu sekarang
  ACCESS_START=00:00 ACCESS_END=00:01 npm run dev
  ```

  Lalu jalankan `PUT /nilai/1`; gateway mengembalikan
  `403 OUTSIDE_ACCESS_HOURS`. Ubah kembali ke `07:00`/`21:00` untuk demo normal.

### 4.4 Audit Log

[`gateway/audit.js`](gateway/audit.js) menulis tabel `audit_logs` untuk setiap
keputusan **allow dan deny**, termasuk login gagal, device salah, dan panggilan
service:

| Kolom | Isi |
|---|---|
| `ts`, `request_id` | waktu ISO + ID korelasi |
| `subject_type`, `subject_id`, `username`, `role` | user / service / anonymous |
| `method`, `path` | endpoint yang diakses |
| `device_id` | konteks device |
| `decision`, `reason_code`, `reason` | hasil + alasan manusiawi |
| `status_code`, `latency_ms`, `ip` | hasil HTTP dan durasi |

Lihat audit terbaru:

```bash
npm run audit
npm run audit -- 50
```

---

## 8. Pengujian

### 8.1 Smoke test otomatis

Pastikan `npm run dev` berjalan di terminal lain, lalu:

```bash
npm test
```

Script [`tests/smoke.js`](tests/smoke.js) me-reset database, lalu menjalankan
**37 pengujian** end-to-end:

- akses langsung service tanpa/salah gateway secret;
- login device salah, password salah, device tidak terdaftar;
- scope nilai mahasiswa (query parameter tidak bisa diakali);
- mahasiswa vs admin vs dosen pada transkrip dan nilai;
- dosen lain tidak bisa mengubah/memfinalisasi kelas orang lain;
- di luar jam akses (gateway kedua di port 3105 dengan konfigurasi berbeda);
- finalisasi + sinkron transkrip lewat gateway;
- nilai final tidak bisa diubah dan finalisasi ulang ditolak;
- token service vs token user di `/transkrip/sinkron`;
- verifikasi ganda di service (secret + token + header identitas);
- access token kedaluwarsa, refresh rotation, device binding, logout;
- audit log berisi allow/deny dan tidak memuat JWT.

### 8.2 Uji manual penting

```bash
# 1. Service tidak bisa diakses langsung
curl -i http://127.0.0.1:3001/nilai
# 401 GATEWAY_SECRET_REQUIRED

# 2. Device tidak terdaftar
curl -i http://127.0.0.1:3000/nilai \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Device-ID: dev-mhs2-01'
# 403 DEVICE_NOT_REGISTERED

# 3. Mahasiswa melihat transkrip orang lain
curl -i http://127.0.0.1:3000/transkrip/2470061110701 \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Device-ID: dev-mhs1-01'
# 403 NOT_OWNER

# 4. Token user ke endpoint service
curl -i -X POST http://127.0.0.1:3000/transkrip/sinkron \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Device-ID: dev-mhs1-01' \
  -H 'Content-Type: application/json' -d '{}'
# 403 SERVICE_TOKEN_REQUIRED
```

### 8.3 Reset data

```bash
npm run seed
```

Seed menghapus seluruh tabel lalu mengisi data awal. Jalankan ulang jika ID atau
status final sudah berubah setelah demo.

---

## 9. Struktur Repository

```
ZeroTrustGrade/
├─ package.json
├─ .env.example
├─ .env                        # lokal, tidak di-commit
├─ data/app.sqlite             # dibuat oleh npm run seed
├─ shared/
│  ├─ config.js                # env + validasi jam
│  ├─ schema.sql               # skema database
│  ├─ seed.js                  # reset + data awal
│  ├─ db.js                    # koneksi SQLite WAL + transaksi
│  ├─ jwt.js                   # access & service token
│  ├─ internal.js              # verifikasi gateway secret + JWT di service
│  ├─ http.js                  # error, request id, jam akses
│  ├─ secrets.js               # hash token + constant-time compare
│  ├─ grades.js                # angka -> huruf
│  ├─ errors.js
│  └─ constants.js             # role, reason code
├─ gateway/
│  ├─ server.js                # PEP: auth, policy, audit, proxy
│  ├─ auth.js                  # router /auth/* (komposisi)
│  ├─ auth/                    # handler login/refresh/logout/service + helper
│  ├─ authenticate.js          # token + device
│  ├─ policy.js                # Policy Engine (allow/deny + alasan)
│  ├─ audit.js                 # audit log
│  └─ proxy.js                 # forward + header internal
├─ services/
│  ├─ nilai/
│  │  ├─ server.js             # GET/PUT nilai, finalisasi, retry sinkron
│  │  ├─ transkripClient.js    # token service + panggilan ke gateway
│  │  └─ sync.js               # kirim nilai final ke transkrip
│  └─ transkrip/
│     └─ server.js             # GET transkrip, POST sinkron
├─ scripts/
│  ├─ dev.js                   # jalankan ketiga komponen berurutan
│  ├─ setup.js                 # buat .env + secret acak
│  └─ audit.js                 # tampilkan audit log
├─ tests/smoke.js              # 37 pengujian end-to-end
├─ postman/                    # koleksi Postman
└─ docs/
   ├─ RENCANA.md               # rancangan & kebutuhan
   └─ DEMO.md                  # skrip video 6–9 menit
```

---

## 10. Keputusan Desain & Keamanan

1. **Satu database SQLite** dipakai gateway dan kedua service (sesuai tugas),
   mode WAL + `busy_timeout` + transaksi `BEGIN IMMEDIATE` untuk finalisasi.
2. **`node:sqlite` bawaan Node** dipilih agar tidak perlu kompilasi native
   `better-sqlite3`; API-nya sinkron seperti better-sqlite3.
3. **Gateway tidak mempercayai header client.** Header `X-Auth-*` dan
   `X-Gateway-Secret` dari client tidak pernah diteruskan; gateway membentuk ulang
   header internal dari hasil verifikasi.
4. **Service tidak diekspos ke jaringan.** Ketiganya bind `127.0.0.1`. Bahkan jika
   port 3001/3002 diakses lokal, request tetap ditolak tanpa secret + token.
5. **Refresh token disimpan hash SHA-256**, terikat `user_id` + `device_id`, dengan
   `revoked_at` dan `replaced_by`.
6. **Rotasi refresh + deteksi reuse.** Token lama yang dipakai ulang dianggap
   indikasi pencurian; semua sesi user dicabut.
7. **Secret constant-time compare** untuk gateway secret dan client secret.
8. **Huruf nilai dihitung server**, bukan dari body client. Transkrip juga
   menghitung ulang huruf dari angka.
9. **Sinkron idempotent** dengan `UNIQUE(mahasiswa_id, kelas_id)` + `UPSERT`.
10. **Finalisasi tetap tercatat** walaupun sinkron gagal; tersedia endpoint retry
    `POST /kelas/:id/sinkron` agar demo tidak macet.
11. **Audit tidak menyimpan token/password**; hanya subjek, endpoint, device,
    keputusan, dan alasan.

---

## 11. Troubleshooting

| Masalah | Solusi |
|---|---|
| `EADDRINUSE` | Hentikan proses lain: `lsof -i :3000` lalu `kill <pid>` |
| `Konfigurasi ... belum diisi` | `cp .env.example .env` |
| `Cannot find module 'node:sqlite'` | Gunakan Node >= 22.5 (`node -v`) |
| `database is locked` | Jalankan hanya satu `npm run dev`; WAL butuh satu penulis |
| Login selalu 401 | Pastikan password seed dan `npm run seed` sudah dijalankan |
| Token service invalid setelah ganti secret | Ganti `SERVICE_CLIENT_SECRET` lalu `npm run seed` |
| Smoke test gagal karena data final | `npm test` otomatis reset; jika manual, `npm run seed` |
| Ingin mulai bersih | `npm run seed` lalu restart `npm run dev` |

---

## 12. Luaran Tugas

- [x] Repository kode + README (cara jalan, akun, device ID).
- [x] API Gateway, Service Nilai, Service Transkrip terpisah.
- [x] Semua kebutuhan 4.1–4.4 diterapkan dan dapat diuji.
- [x] Data seed melebihi minimal (6 user, 6 device, 2 kelas, 4 nilai).
- [x] Koleksi Postman + smoke test otomatis.
- [ ] Video demo 6–9 menit — panduan perekaman ada di [`docs/DEMO.md`](docs/DEMO.md).
