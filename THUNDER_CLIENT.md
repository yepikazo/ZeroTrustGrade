# Panduan Thunder Client — ZeroTrustGrade

Panduan ini menjelaskan cara memindahkan pengujian manual dari Postman ke
**Thunder Client** (ekstensi VS Code). Pengujian otomatis di
[`tests/smoke.js`](tests/smoke.js) tetap dipakai dan tidak digantikan oleh
panduan ini.

> Catatan versi: pada dokumentasi Thunder Client saat ini, **Import/Export** dan
> **Scripting** ditandai sebagai fitur berbayar. Kalau versi yang dipakai tidak
> mendukung salah satunya, gunakan pembuatan request manual dan **GUI Tests**
> (Assertions + Set Env Variable).

---

## 1. Prasyarat

1. Install ekstensi **Thunder Client** di VS Code.
2. Gunakan Node.js 22 atau lebih baru.
3. Siapkan database dan jalankan semua komponen:

   ```bash
   npm run seed
   npm run dev
   ```

4. Pastikan endpoint berikut hidup:

   | Komponen | URL default |
   |---|---|
   | Gateway | `http://127.0.0.1:3000` |
   | Service Nilai | `http://127.0.0.1:3001` |
   | Service Transkrip | `http://127.0.0.1:3002` |

5. Ambil nilai `GATEWAY_SECRET` dari `.env`. Jangan menuliskan nilai secret
   langsung ke collection yang akan di-commit.

---

## 2. Membuat Environment

Buka tab **Env** di Thunder Client, lalu buat environment
`ZeroTrustGrade Local`.

### Variabel environment

| Variabel | Nilai |
|---|---|
| `baseUrl` | `http://127.0.0.1:3000` |
| `nilaiUrl` | `http://127.0.0.1:3001` |
| `deviceId` | `dev-mhs1-01` |
| `nilaiId` | `1` |
| `kelasId` | `1` |
| `nim` | `2021001` |
| `gatewaySecret` | nilai `GATEWAY_SECRET` dari `.env` |
| `serviceClientId` | `nilai-service` |
| `serviceClientSecret` | nilai `SERVICE_CLIENT_SECRET` dari `.env` |
| `accessToken` | kosong |
| `refreshToken` | kosong |
| `accessTokenDosen` | kosong |
| `refreshTokenDosen` | kosong |
| `accessTokenAdmin` | kosong |
| `serviceToken` | kosong |
| `userId` | kosong |

Set environment tersebut sebagai **Active Environment**.

Untuk token dan secret, gunakan **Local Environment** agar nilainya tidak ikut
ter-export atau ter-commit. Jika memakai scripting, variabel bisa disimpan ke
scope local:

```js
tc.setVar('accessToken', body.access_token, 'local');
```

---

## 3. Membuat Collection

### Opsi A — Import collection Postman

Thunder Client mendukung import format **Postman 2.1.0**.

1. Buka tab **Collection**.
2. Klik menu tiga titik, pilih **Import**.
3. Pilih file:

   ```text
   postman/ZeroTrustGrade.postman_collection.json
   ```

4. Setelah import, periksa setiap request dan bagian **Tests**.

Script Postman (`pm.*`) belum tentu ikut berjalan di Thunder Client. Ganti
script tersebut dengan **GUI Tests** atau script Thunder Client seperti pada
bagian 5.

### Opsi B — Buat collection manual

Buat collection `ZeroTrustGrade` dengan empat folder:

```text
ZeroTrustGrade
├─ 01 Auth
├─ 02 Nilai
├─ 03 Transkrip
└─ 04 Negative Tests
```

---

## 4. Susunan Request

### 4.1 Folder 01 Auth

| Request | Method & URL | Header / Body | Setelah response |
|---|---|---|---|
| Login Mahasiswa | `POST {{baseUrl}}/auth/login` | `X-Device-ID: {{deviceId}}`; body `{"username":"mhs1","password":"Mhs#123"}` | simpan `accessToken`, `refreshToken`, `userId`; cek `expires_in = 600` |
| Login Dosen | `POST {{baseUrl}}/auth/login` | `X-Device-ID: dev-dosen1-01`; body `{"username":"dosen1","password":"Dosen#123"}` | simpan `accessTokenDosen`, `refreshTokenDosen` |
| Login Admin | `POST {{baseUrl}}/auth/login` | `X-Device-ID: dev-admin-01`; body `{"username":"admin","password":"Admin#123"}` | simpan `accessTokenAdmin` |
| Refresh Token | `POST {{baseUrl}}/auth/refresh` | `X-Device-ID: {{deviceId}}`; body `{"refresh_token":"{{refreshToken}}"}` | simpan `accessToken` dan `refreshToken` baru |
| Logout | `POST {{baseUrl}}/auth/logout` | body `{"refresh_token":"{{refreshToken}}"}` | status `204` |
| Service Token | `POST {{baseUrl}}/auth/service` | body `{"client_id":"{{serviceClientId}}","client_secret":"{{serviceClientSecret}}"}` | simpan `serviceToken`; cek `expires_in = 300` |

Urutan folder Auth harus dijaga: login dulu, lalu refresh, logout, dan service
token. Jangan menjalankan Refresh setelah Logout tanpa login ulang.

### 4.2 Folder 02 Nilai

| Request | Method & URL | Header / Body |
|---|---|---|
| GET nilai mahasiswa | `GET {{baseUrl}}/nilai` | `Authorization: Bearer {{accessToken}}`, `X-Device-ID: {{deviceId}}` |
| GET nilai dosen | `GET {{baseUrl}}/nilai` | `Authorization: Bearer {{accessTokenDosen}}`, `X-Device-ID: dev-dosen1-01` |
| PUT nilai | `PUT {{baseUrl}}/nilai/{{nilaiId}}` | Bearer dosen; device dosen; body `{"nilai_angka":86}` |
| Finalisasi | `POST {{baseUrl}}/kelas/{{kelasId}}/finalisasi` | Bearer dosen; device dosen |
| Sinkron ulang | `POST {{baseUrl}}/kelas/{{kelasId}}/sinkron` | Bearer dosen; device dosen |

### 4.3 Folder 03 Transkrip

| Request | Method & URL | Header / Body |
|---|---|---|
| Transkrip mahasiswa | `GET {{baseUrl}}/transkrip/{{nim}}` | Bearer mahasiswa; device mahasiswa |
| Transkrip admin | `GET {{baseUrl}}/transkrip/2021002` | Bearer admin; device admin |
| Sinkron transkrip | `POST {{baseUrl}}/transkrip/sinkron` | Bearer `{{serviceToken}}`; body `{"kelas_id":1,"items":[{"nim":"2021001","nilai_angka":86},{"nim":"2021002","nilai_angka":78}]}` |

### 4.4 Folder 04 Negative Tests

| Request | Method & URL | Header / Body | Expected |
|---|---|---|---|
| Direct service tanpa secret | `GET {{nilaiUrl}}/nilai` | tanpa header | `401 GATEWAY_SECRET_REQUIRED` |
| Direct service lengkap | `GET {{nilaiUrl}}/nilai` | `X-Gateway-Secret: {{gatewaySecret}}`; Bearer `{{accessToken}}`; `X-Auth-User-Id: {{userId}}`; `X-Auth-Role: mahasiswa` | `200` |
| Transkrip NIM lain | `GET {{baseUrl}}/transkrip/2021002` | Bearer mahasiswa; device mahasiswa | `403 NOT_OWNER` |
| Admin ke /nilai | `GET {{baseUrl}}/nilai` | Bearer admin; device admin | `403 ROLE_NOT_ALLOWED` |
| Device tidak terdaftar | `GET {{baseUrl}}/nilai` | Bearer mahasiswa; `X-Device-ID: dev-mhs2-01` | `403 DEVICE_NOT_REGISTERED` |
| User token ke sinkron | `POST {{baseUrl}}/transkrip/sinkron` | Bearer admin; device admin; body `{"kelas_id":1,"items":[]}` | `403 SERVICE_TOKEN_REQUIRED` |

---

## 5. Tests dan Token Chaining

### 5.1 GUI Tests (tanpa scripting)

Buka tab **Tests** pada request.

#### Assertions

Tambahkan assertion lewat bagian **Assertions**:

- **Status Code** → `equals` → `200`
- **JSON** → path `expires_in` → `equals` → `600`
- **JSON** → path `error.code` → `equals` → `NOT_OWNER`

#### Set Env Variable

Gunakan bagian **Set Env Variable** untuk mengisi token otomatis:

| Request | Source | Variable |
|---|---|---|
| Login Mahasiswa | `json.access_token` | `{{accessToken}}` |
| Login Mahasiswa | `json.refresh_token` | `{{refreshToken}}` |
| Login Mahasiswa | `json.user.id` | `{{userId}}` |
| Login Dosen | `json.access_token` | `{{accessTokenDosen}}` |
| Login Dosen | `json.refresh_token` | `{{refreshTokenDosen}}` |
| Login Admin | `json.access_token` | `{{accessTokenAdmin}}` |
| Refresh | `json.access_token` | `{{accessToken}}` |
| Refresh | `json.refresh_token` | `{{refreshToken}}` |
| Service Token | `json.access_token` | `{{serviceToken}}` |

Pastikan environment `ZeroTrustGrade Local` aktif. Jika nilai variabel tidak
langsung terlihat di tab Env, tutup lalu buka kembali tab tersebut.

### 5.2 Scripting

Padanan script Postman ke Thunder Client:

| Postman | Thunder Client |
|---|---|
| `pm.response.code` | `tc.response.status` |
| `pm.response.json()` | `tc.response.json` |
| `pm.collectionVariables.set()` | `tc.setVar()` |
| `pm.test()` | `tc.test()` |
| `pm.expect()` | `expect()` |

Perhatikan: `tc.response.json` adalah **property**, bukan function.

#### Login Mahasiswa

```js
tc.test('200 OK', () => {
  expect(tc.response.status).to.equal(200);
});

const body = tc.response.json;
tc.setVar('accessToken', body.access_token);
tc.setVar('refreshToken', body.refresh_token);
tc.setVar('userId', body.user.id);

tc.test('access token 10 menit', () => {
  expect(body.expires_in).to.equal(600);
});
```

#### Login Dosen

```js
const body = tc.response.json;
tc.setVar('accessTokenDosen', body.access_token);
tc.setVar('refreshTokenDosen', body.refresh_token);
```

#### Login Admin

```js
tc.setVar('accessTokenAdmin', tc.response.json.access_token);
```

#### Refresh Token

```js
const body = tc.response.json;
tc.setVar('accessToken', body.access_token);
tc.setVar('refreshToken', body.refresh_token);
```

#### Service Token

```js
tc.setVar('serviceToken', tc.response.json.access_token);

tc.test('token service 5 menit', () => {
  expect(tc.response.json.expires_in).to.equal(300);
});
```

#### GET nilai mahasiswa

```js
tc.test('hanya nilai sendiri', () => {
  const rows = tc.response.json.data;
  expect(rows.every((row) => row.nim === '2021001')).to.equal(true);
});
```

#### Negative test

```js
tc.test('403 NOT_OWNER', () => {
  expect(tc.response.status).to.equal(403);
  expect(tc.response.json.error.code).to.equal('NOT_OWNER');
});
```

---

## 6. Menjalankan Semua Request

1. Jalankan seed terlebih dahulu:

   ```bash
   npm run seed
   ```

2. Klik kanan collection `ZeroTrustGrade`.
3. Pilih **Run All**.
4. Pilih mode **Sequential**.
5. Set iterasi `1` dan delay `0`.
6. Jalankan folder dengan urutan:

   ```text
   01 Auth → 02 Nilai → 03 Transkrip → 04 Negative Tests
   ```

Seed perlu dijalankan sebelum full run karena request `PUT /nilai`,
finalisasi, dan sinkron mengubah state database. Jika dijalankan ulang tanpa
seed, finalisasi dapat menghasilkan `409 ALREADY_FINAL`.

`nilaiId` dan `kelasId` default bernilai `1` setelah seed. Kalau ID berubah,
ambil dari response `GET /nilai` atau sesuaikan variabel environment.

---

## 7. Migrasi dari Postman ke Thunder Client

Setelah collection Thunder Client terbukti berjalan:

1. Export collection dari Thunder Client:
   - klik kanan collection → **Export** → format Thunder Client.
2. Simpan file hasil export, misalnya:

   ```text
   thunder/ZeroTrustGrade.json
   ```

3. Perbarui `README.md`:
   - ganti referensi Postman dengan Thunder Client;
   - ubah struktur repo dari `postman/` menjadi `thunder/`;
   - tambahkan tautan ke panduan ini.
4. Hapus folder `postman/` setelah semua request Thunder Client terverifikasi.
5. Jangan commit environment yang berisi token atau secret.

Kalau fitur export tidak tersedia di versi Thunder Client yang dipakai,
collection tetap dapat digunakan secara lokal. Dokumentasikan nama collection,
environment, dan urutan request agar orang lain bisa membuatnya ulang.

### Struktur yang disarankan

```text
ZeroTrustGrade/
├─ THUNDER_CLIENT.md              # panduan ini
├─ thunder/
│  └─ ZeroTrustGrade.json         # hasil export, tanpa secret
└─ tests/
   └─ smoke.js                    # pengujian otomatis
```

---

## 8. Keamanan

- Simpan `GATEWAY_SECRET`, `SERVICE_CLIENT_SECRET`, access token, dan refresh
  token di **Local Environment**, bukan di collection.
- Jangan menempelkan token ke body atau URL request.
- Jangan commit file environment yang berisi secret.
- `.env` sudah diabaikan oleh Git; jangan mengubahnya menjadi file yang
  di-commit.
- Collection yang di-export sebaiknya hanya berisi variabel `{{...}}`, bukan
  nilai secret.

---

## 9. Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| `401 NO_TOKEN` | Header Authorization belum diisi | Pastikan `Authorization: Bearer {{accessToken}}` |
| `403 DEVICE_MISSING` | `X-Device-ID` tidak dikirim | Tambahkan header device sesuai user |
| `403 DEVICE_NOT_REGISTERED` | Device salah atau database belum di-seed | Jalankan `npm run seed`; cek `deviceId` |
| `409 ALREADY_FINAL` | Kelas sudah difinalisasi | Jalankan `npm run seed` sebelum full run |
| Variabel token tidak berubah | Environment tidak aktif atau scope salah | Set active environment; cek `tc.setVar` |
| `tc.response.json` undefined | Response bukan JSON atau request gagal | Cek status dan body response |
| Script Postman tidak berjalan | `pm.*` bukan API Thunder Client | Ganti dengan `tc.*` atau GUI Tests |
| Import collection tidak tersedia | Fitur import versi berbayar | Buat collection manual sesuai bagian 4 |

---

## 10. Ringkasan Perbedaan Postman dan Thunder Client

| Aspek | Postman | Thunder Client |
|---|---|---|
| Penyimpanan collection | File collection di repo | Lokal di VS Code, bisa di-export |
| Variabel | Collection/environment variables | Environment + Local Environment |
| Test | Script `pm.test` | GUI Assertions atau `tc.test` |
| Set token | `pm.collectionVariables.set` | `tc.setVar` atau GUI Set Env Variable |
| Response JSON | `pm.response.json()` | `tc.response.json` |
| Runner | Collection Runner | Run All / Collection Runner |
| CI | Newman/Postman CLI | Thunder Client CLI (opsional) |

Untuk regression test otomatis, tetap gunakan:

```bash
npm test
```
