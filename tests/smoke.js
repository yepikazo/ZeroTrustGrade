'use strict';

/**
 * Smoke test end-to-end terhadap sistem yang sedang berjalan.
 *
 * Jalankan server lebih dulu (npm run dev), lalu:
 *   npm test
 *
 * Script akan me-reset database (seed) agar hasil deterministik, lalu menguji
 * skenario positif dan negatif dari Tabel 3 + kebutuhan 4.1–4.4.
 */

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const jwt = require('jsonwebtoken');

const config = require('../shared/config');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY = config.urls.gateway;
const NILAI = config.urls.nilai;
const TRANSKRIP = config.urls.transkrip;

let pass = 0;
let fail = 0;
const failures = [];

function eq(actual, expected, label) {
  assert.equal(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function ok(condition, label) {
  assert.ok(condition, label);
}

function expectError(response, status, code, label) {
  const body = JSON.stringify(response.data);
  eq(response.status, status, `${label} (body: ${body})`);
  eq(response.data?.error?.code, code, `${label} reason (body: ${body})`);
}

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    fail += 1;
    failures.push({ name, error });
    console.log(`✗ ${name}`);
    console.log(`   ${error.message}`);
  }
}

async function call(base, method, route, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.device) headers['x-device-id'] = options.device;

  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${base}${route}`, { method, headers, body });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data, text };
}

async function login(username, password, device) {
  return call(GATEWAY, 'POST', '/auth/login', {
    device,
    body: { username, password },
  });
}

async function waitForHealth(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // belum siap
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Tidak dapat menghubungi ${url}`);
}

function seedDatabase() {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'shared/seed.js')],
    { cwd: ROOT, env: process.env, stdio: 'ignore' },
  );
  if (result.status !== 0) {
    throw new Error('Seed database gagal. Jalankan "npm run seed" secara manual.');
  }
}

function minutesNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: config.accessWindow.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function hhmm(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(
    normalized % 60,
  ).padStart(2, '0')}`;
}

/**
 * Menjalankan gateway kedua di port 3105 dengan jendela akses yang dijamin
 * tidak mencakup waktu sekarang. Ini membuktikan pembatasan jam dapat diatur
 * lewat konfigurasi tanpa mengubah kode.
 */
async function testOutsideHours(token, device, nilaiId) {
  const port = 3105;
  const current = minutesNow();
  const start = hhmm(current - 120);
  const end = hhmm(current - 60);

  const child = spawn(process.execPath, [path.join(ROOT, 'gateway/server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT_GATEWAY: String(port),
      ACCESS_WINDOW_ENABLED: 'true',
      ACCESS_START: start,
      ACCESS_END: end,
    },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`);
    const response = await call(`http://127.0.0.1:${port}`, 'PUT', `/nilai/${nilaiId}`, {
      token,
      device,
      body: { nilai_angka: 70 },
    });
    expectError(
      response,
      403,
      'OUTSIDE_ACCESS_HOURS',
      `jam akses ${start}-${end} seharusnya menolak`,
    );
  } finally {
    child.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function checkAudit() {
  const db = new DatabaseSync(config.dbPath);
  const count = (where, ...params) =>
    db
      .prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${where}`)
      .get(...params).n;

  try {
    ok(count('1 = 1') > 20, 'audit log seharusnya mencatat banyak keputusan');
    ok(count("decision = 'allow'") > 0, 'harus ada keputusan allow');
    ok(count("decision = 'deny'") > 0, 'harus ada keputusan deny');
    ok(
      count("decision = 'deny' AND reason_code = 'NOT_OWNER'") >= 2,
      'harus ada deny NOT_OWNER (dosen/mahasiswa)',
    );
    ok(
      count("reason_code = 'DEVICE_NOT_REGISTERED'") > 0,
      'harus ada deny DEVICE_NOT_REGISTERED',
    );
    ok(
      count("reason_code = 'ALREADY_FINAL'") > 0,
      'harus ada deny ALREADY_FINAL',
    );
    ok(
      count("reason_code = 'SERVICE_TOKEN_REQUIRED'") > 0,
      'harus ada deny SERVICE_TOKEN_REQUIRED',
    );
    ok(
      count(
        "reason_code = 'SERVICE_TOKEN_REQUIRED' AND username = 'admin'",
      ) > 0,
      'subjek user tetap tercatat saat token user ditolak di endpoint service',
    );
    ok(
      count("reason_code = 'OUTSIDE_ACCESS_HOURS'") > 0,
      'harus ada deny OUTSIDE_ACCESS_HOURS',
    );
    ok(
      count(
        "decision = 'allow' AND subject_type = 'service' AND path = '/transkrip/sinkron'",
      ) > 0,
      'panggilan service ke sinkron harus tercatat allow',
    );
    ok(
      count("request_id IS NULL OR request_id = ''") === 0,
      'setiap audit harus punya request_id',
    );
    ok(
      count("reason LIKE '%eyJ%' OR username LIKE '%eyJ%' OR path LIKE '%eyJ%'") === 0,
      'audit tidak boleh memuat token JWT',
    );
  } finally {
    db.close();
  }
}

async function main() {
  if (!process.argv.includes('--no-seed')) {
    seedDatabase();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  // Preflight: pastikan ketiga komponen hidup sebelum menguji.
  for (const [name, url] of [
    ['gateway', `${GATEWAY}/health`],
    ['nilai', `${NILAI}/health`],
    ['transkrip', `${TRANSKRIP}/health`],
  ]) {
    try {
      await waitForHealth(url, 3000);
    } catch {
      console.error(
        `\n✗ ${name} tidak berjalan di ${url}.\n  Jalankan "npm run dev" di terminal lain lebih dulu.\n`,
      );
      process.exit(1);
    }
  }

  console.log('\nZeroTrustGrade — smoke test\n');

  let mhs1;
  let admin;
  let dosen1;
  let dosen2;
  let serviceToken;
  let nilaiId;
  let kelas1Id;
  let kelas2Id;

  // ── 1. Pertahanan service (tidak bisa diakses langsung) ────
  await test('Service Nilai menolak request tanpa X-Gateway-Secret', async () => {
    const response = await call(NILAI, 'GET', '/nilai');
    expectError(response, 401, 'GATEWAY_SECRET_REQUIRED', 'akses langsung');
  });

  await test('Service Nilai menolak secret salah', async () => {
    const response = await call(NILAI, 'GET', '/nilai', {
      headers: { 'x-gateway-secret': 'secret-palsu' },
    });
    expectError(response, 401, 'GATEWAY_SECRET_REQUIRED', 'secret salah');
  });

  // ── 2. Autentikasi & konteks device ───────────────────────
  await test('Login dengan device tidak terdaftar ditolak', async () => {
    const response = await login('mhs1', 'Mhs#123', 'dev-mhs2-01');
    expectError(response, 403, 'DEVICE_NOT_REGISTERED', 'login device salah');
  });

  await test('Login dengan password salah ditolak', async () => {
    const response = await login('mhs1', 'salah', 'dev-mhs1-01');
    expectError(response, 401, 'INVALID_CREDENTIALS', 'password salah');
  });

  await test('Login valid mengembalikan access + refresh token', async () => {
    mhs1 = await login('mhs1', 'Mhs#123', 'dev-mhs1-01');
    eq(mhs1.status, 200, 'status login');
    ok(mhs1.data.access_token, 'access_token ada');
    ok(mhs1.data.refresh_token, 'refresh_token ada');
    eq(mhs1.data.expires_in, 600, 'access token 10 menit');
    eq(mhs1.data.refresh_expires_in, 86400, 'refresh token 1 hari');
    eq(mhs1.data.user.role, 'mahasiswa', 'role');
    eq(mhs1.data.user.nim, '2470061110700', 'nim');
  });

  await test('Request user tanpa X-Device-ID ditolak', async () => {
    const response = await call(GATEWAY, 'GET', '/nilai', {
      token: mhs1.data.access_token,
    });
    expectError(response, 403, 'DEVICE_MISSING', 'device missing');
  });

  await test('Device milik user lain ditolak', async () => {
    const response = await call(GATEWAY, 'GET', '/nilai', {
      token: mhs1.data.access_token,
      device: 'dev-mhs2-01',
    });
    expectError(response, 403, 'DEVICE_NOT_REGISTERED', 'device user lain');
  });

  // ── 3. Otorisasi mahasiswa ────────────────────────────────
  await test('Mahasiswa hanya melihat nilai miliknya (query tidak bisa diakali)', async () => {
    const response = await call(
      GATEWAY,
      'GET',
      '/nilai?mahasiswa_id=5&nim=2470061110701',
      { token: mhs1.data.access_token, device: 'dev-mhs1-01' },
    );
    eq(response.status, 200, 'status');
    eq(response.data.scope, 'self', 'scope');
    ok(response.data.data.length > 0, 'ada nilai');
    for (const row of response.data.data) {
      eq(row.nim, '2470061110700', 'NIM pada hasil');
    }
  });

  await test('Mahasiswa melihat transkrip sendiri', async () => {
    const response = await call(GATEWAY, 'GET', '/transkrip/2470061110700', {
      token: mhs1.data.access_token,
      device: 'dev-mhs1-01',
    });
    eq(response.status, 200, 'status');
    eq(response.data.nim, '2470061110700', 'nim');
    eq(response.data.data.length, 0, 'transkrip masih kosong sebelum finalisasi');
  });

  await test('Mahasiswa tidak boleh melihat transkrip NIM lain', async () => {
    const response = await call(GATEWAY, 'GET', '/transkrip/2470061110701', {
      token: mhs1.data.access_token,
      device: 'dev-mhs1-01',
    });
    expectError(response, 403, 'NOT_OWNER', 'transkrip orang lain');
  });

  // ── 4. Otorisasi admin ────────────────────────────────────
  await test('Admin login dan melihat transkrip semua NIM', async () => {
    admin = await login('admin', 'Admin#123', 'dev-admin-01');
    eq(admin.status, 200, 'status login');
    const response = await call(GATEWAY, 'GET', '/transkrip/2470061110701', {
      token: admin.data.access_token,
      device: 'dev-admin-01',
    });
    eq(response.status, 200, 'status transkrip');
    eq(response.data.nim, '2470061110701', 'nim');
  });

  await test('Admin tetap tidak boleh mengakses /nilai', async () => {
    const response = await call(GATEWAY, 'GET', '/nilai', {
      token: admin.data.access_token,
      device: 'dev-admin-01',
    });
    expectError(response, 403, 'ROLE_NOT_ALLOWED', 'admin ke nilai');
  });

  // ── 5. Otorisasi dosen & kepemilikan dari database ────────
  await test('Dosen login dan hanya melihat kelas yang diampu', async () => {
    dosen1 = await login('dosen1', 'Dosen#123', 'dev-dosen1-01');
    dosen2 = await login('dosen2', 'Dosen#123', 'dev-dosen2-01');
    eq(dosen1.status, 200, 'login dosen1');
    eq(dosen2.status, 200, 'login dosen2');

    const r1 = await call(GATEWAY, 'GET', '/nilai', {
      token: dosen1.data.access_token,
      device: 'dev-dosen1-01',
    });
    eq(r1.status, 200, 'status dosen1');
    eq(r1.data.data.length, 2, 'dua mahasiswa di IF101');
    for (const row of r1.data.data) eq(row.kode_kelas, 'IF101', 'kelas dosen1');
    nilaiId = r1.data.data[0].id;
    kelas1Id = r1.data.data[0].kelas_id;

    const r2 = await call(GATEWAY, 'GET', '/nilai', {
      token: dosen2.data.access_token,
      device: 'dev-dosen2-01',
    });
    for (const row of r2.data.data) eq(row.kode_kelas, 'IF201', 'kelas dosen2');
    kelas2Id = r2.data.data[0].kelas_id;
  });

  await test('Dosen tidak boleh mengubah nilai kelas dosen lain', async () => {
    const response = await call(GATEWAY, 'PUT', `/nilai/${nilaiId}`, {
      token: dosen2.data.access_token,
      device: 'dev-dosen2-01',
      body: { nilai_angka: 60 },
    });
    expectError(response, 403, 'NOT_OWNER', 'dosen lain');
  });

  await test('Dosen mengubah nilai kelas sendiri', async () => {
    const response = await call(GATEWAY, 'PUT', `/nilai/${nilaiId}`, {
      token: dosen1.data.access_token,
      device: 'dev-dosen1-01',
      body: { nilai_angka: 86 },
    });
    eq(response.status, 200, 'status');
    eq(response.data.data.nilai_angka, 86, 'nilai baru');
    eq(response.data.data.nilai_huruf, 'A', 'huruf dihitung server');
  });

  await test('Validasi nilai di luar 0-100 ditolak', async () => {
    const response = await call(GATEWAY, 'PUT', `/nilai/${nilaiId}`, {
      token: dosen1.data.access_token,
      device: 'dev-dosen1-01',
      body: { nilai_angka: 101 },
    });
    expectError(response, 400, 'INVALID_REQUEST', 'nilai 101');
  });

  await test('Dosen tidak boleh memfinalisasi kelas dosen lain', async () => {
    const response = await call(GATEWAY, 'POST', `/kelas/${kelas2Id}/finalisasi`, {
      token: dosen1.data.access_token,
      device: 'dev-dosen1-01',
    });
    expectError(response, 403, 'NOT_OWNER', 'finalisasi kelas orang lain');
  });

  // ── 6. Jam akses (gateway kedua dengan konfigurasi berbeda) ──
  await test('Perubahan nilai di luar jam akses ditolak', async () => {
    await testOutsideHours(
      dosen1.data.access_token,
      'dev-dosen1-01',
      nilaiId,
    );
  });

  // ── 7. Finalisasi & sinkron transkrip ─────────────────────
  await test('Finalisasi kelas memicu sinkron transkrip lewat gateway', async () => {
    const response = await call(GATEWAY, 'POST', `/kelas/${kelas1Id}/finalisasi`, {
      token: dosen1.data.access_token,
      device: 'dev-dosen1-01',
    });
    eq(response.status, 200, `status (body: ${JSON.stringify(response.data)})`);
    eq(response.data.kelas.is_final, 1, 'kelas final');
    eq(response.data.kelas.sync_status, 'synced', 'sync status');
    eq(response.data.sync.status, 'synced', 'sync');
    eq(response.data.sync.synced, 2, 'dua nilai tersinkron');
  });

  await test('Nilai yang sudah final tidak dapat diubah', async () => {
    const response = await call(GATEWAY, 'PUT', `/nilai/${nilaiId}`, {
      token: dosen1.data.access_token,
      device: 'dev-dosen1-01',
      body: { nilai_angka: 90 },
    });
    expectError(response, 409, 'ALREADY_FINAL', 'nilai final');
  });

  await test('Finalisasi ulang ditolak', async () => {
    const response = await call(GATEWAY, 'POST', `/kelas/${kelas1Id}/finalisasi`, {
      token: dosen1.data.access_token,
      device: 'dev-dosen1-01',
    });
    expectError(response, 409, 'ALREADY_FINAL', 'finalisasi ulang');
  });

  await test('Transkrip mahasiswa terisi setelah finalisasi', async () => {
    const response = await call(GATEWAY, 'GET', '/transkrip/2470061110700', {
      token: mhs1.data.access_token,
      device: 'dev-mhs1-01',
    });
    eq(response.status, 200, 'status');
    eq(response.data.data.length, 1, 'satu mata kuliah');
    eq(response.data.data[0].kode_kelas, 'IF101', 'kode kelas');
    eq(response.data.data[0].nilai_huruf, 'A', 'nilai huruf');
    eq(response.data.total_sks, 3, 'total SKS');
  });

  await test('Dosen tidak boleh mengakses transkrip', async () => {
    const response = await call(GATEWAY, 'GET', '/transkrip/2470061110700', {
      token: dosen1.data.access_token,
      device: 'dev-dosen1-01',
    });
    expectError(response, 403, 'ROLE_NOT_ALLOWED', 'dosen ke transkrip');
  });

  // ── 8. Token service & panggilan antar-service ────────────
  await test('Client secret salah tidak mendapat token service', async () => {
    const response = await call(GATEWAY, 'POST', '/auth/service', {
      body: {
        client_id: config.serviceClient.id,
        client_secret: 'secret-palsu',
      },
    });
    expectError(response, 401, 'SERVICE_CLIENT_INVALID', 'secret service salah');
  });

  await test('Service Nilai memperoleh token service 5 menit', async () => {
    const response = await call(GATEWAY, 'POST', '/auth/service', {
      body: {
        client_id: config.serviceClient.id,
        client_secret: config.serviceClient.secret,
      },
    });
    eq(response.status, 200, 'status');
    eq(response.data.expires_in, 300, 'token service 5 menit');
    eq(response.data.role, 'service', 'role service');
    serviceToken = response.data.access_token;
  });

  await test('Token user (admin) ditolak di endpoint sinkron', async () => {
    const response = await call(GATEWAY, 'POST', '/transkrip/sinkron', {
      token: admin.data.access_token,
      device: 'dev-admin-01',
      body: { kelas_id: kelas1Id, items: [] },
    });
    expectError(response, 403, 'SERVICE_TOKEN_REQUIRED', 'admin ke sinkron');
  });

  await test('Token service ditolak di endpoint user', async () => {
    const response = await call(GATEWAY, 'GET', '/nilai', {
      token: serviceToken,
      device: 'dev-dosen1-01',
    });
    expectError(response, 401, 'WRONG_TOKEN_TYPE', 'service token ke /nilai');
  });

  await test('Sinkron transkrip idempotent dengan token service', async () => {
    const body = {
      kelas_id: kelas1Id,
      items: [
        { nim: '2470061110700', nilai_angka: 86 },
        { nim: '2470061110701', nilai_angka: 78 },
      ],
    };
    const first = await call(GATEWAY, 'POST', '/transkrip/sinkron', {
      token: serviceToken,
      body,
    });
    eq(first.status, 200, 'sinkron pertama');
    eq(first.data.synced, 2, 'dua baris');

    const second = await call(GATEWAY, 'POST', '/transkrip/sinkron', {
      token: serviceToken,
      body,
    });
    eq(second.status, 200, 'sinkron kedua');
    eq(second.data.synced, 2, 'tetap dua baris (upsert, bukan duplikasi)');
  });

  // ── 9. Verifikasi ganda di service ────────────────────────
  await test('Service menolak secret valid tanpa token', async () => {
    const response = await call(NILAI, 'GET', '/nilai', {
      headers: { 'x-gateway-secret': config.gatewaySecret },
    });
    expectError(response, 401, 'NO_TOKEN', 'secret tanpa token');
  });

  await test('Service menolak token valid tanpa header identitas gateway', async () => {
    const response = await call(NILAI, 'GET', '/nilai', {
      headers: {
        'x-gateway-secret': config.gatewaySecret,
        authorization: `Bearer ${mhs1.data.access_token}`,
      },
    });
    expectError(response, 401, 'IDENTITY_MISMATCH', 'tanpa header identitas');
  });

  await test('Service menerima request lengkap (secret + token + identitas)', async () => {
    const response = await call(NILAI, 'GET', '/nilai', {
      headers: {
        'x-gateway-secret': config.gatewaySecret,
        authorization: `Bearer ${mhs1.data.access_token}`,
        'x-auth-user-id': String(mhs1.data.user.id),
        'x-auth-role': 'mahasiswa',
      },
    });
    eq(response.status, 200, 'status');
    for (const row of response.data.data) eq(row.nim, '2470061110700', 'scope tetap milik sendiri');
  });

  await test('Access token kedaluwarsa ditolak', async () => {
    const expired = jwt.sign(
      {
        role: 'mahasiswa',
        username: 'mhs1',
        nim: '2470061110700',
        typ: 'access',
      },
      config.jwt.accessSecret,
      {
        algorithm: 'HS256',
        subject: String(mhs1.data.user.id),
        issuer: config.jwt.issuer,
        audience: config.jwt.accessAudience,
        expiresIn: -10,
      },
    );
    const response = await call(GATEWAY, 'GET', '/nilai', {
      token: expired,
      device: 'dev-mhs1-01',
    });
    expectError(response, 401, 'TOKEN_EXPIRED', 'token kedaluwarsa');
  });

  // ── 10. Refresh rotation, device binding, logout ──────────
  await test('Refresh token terikat pada device', async () => {
    const session = await login('mhs3', 'Mhs#123', 'dev-mhs3-01');
    const response = await call(GATEWAY, 'POST', '/auth/refresh', {
      device: 'dev-mhs2-01',
      body: { refresh_token: session.data.refresh_token },
    });
    expectError(response, 401, 'DEVICE_MISMATCH', 'refresh device lain');
  });

  await test('Refresh merotasi token dan token lama tidak bisa dipakai ulang', async () => {
    const session = await login('mhs3', 'Mhs#123', 'dev-mhs3-01');
    const oldRefresh = session.data.refresh_token;

    const rotated = await call(GATEWAY, 'POST', '/auth/refresh', {
      device: 'dev-mhs3-01',
      body: { refresh_token: oldRefresh },
    });
    eq(rotated.status, 200, 'refresh pertama');
    ok(rotated.data.refresh_token !== oldRefresh, 'refresh token baru berbeda');

    const reuse = await call(GATEWAY, 'POST', '/auth/refresh', {
      device: 'dev-mhs3-01',
      body: { refresh_token: oldRefresh },
    });
    expectError(reuse, 401, 'REFRESH_REVOKED', 'reuse token lama');

    const afterBreach = await call(GATEWAY, 'POST', '/auth/refresh', {
      device: 'dev-mhs3-01',
      body: { refresh_token: rotated.data.refresh_token },
    });
    expectError(
      afterBreach,
      401,
      'REFRESH_REVOKED',
      'reuse terdeteksi: seluruh sesi user dicabut',
    );

    const logout = await call(GATEWAY, 'POST', '/auth/logout', {
      body: { refresh_token: rotated.data.refresh_token },
    });
    eq(logout.status, 204, 'logout idempotent');
  });

  // ── 11. Finalisasi kelas kedua & transkrip lintas kelas ───
  await test('Dosen 2 memfinalisasi kelasnya dan transkrip mhs2 lengkap', async () => {
    const finalize = await call(GATEWAY, 'POST', `/kelas/${kelas2Id}/finalisasi`, {
      token: dosen2.data.access_token,
      device: 'dev-dosen2-01',
    });
    eq(finalize.status, 200, 'finalisasi');
    eq(finalize.data.sync.synced, 2, 'dua nilai');

    const transkrip = await call(GATEWAY, 'GET', '/transkrip/2470061110701', {
      token: admin.data.access_token,
      device: 'dev-admin-01',
    });
    eq(transkrip.status, 200, 'transkrip mhs2');
    eq(transkrip.data.data.length, 2, 'dua mata kuliah');
    eq(transkrip.data.data[0].kode_kelas, 'IF101', 'IF101');
    eq(transkrip.data.data[1].kode_kelas, 'IF201', 'IF201');
    eq(transkrip.data.total_sks, 6, 'total SKS');
  });

  await test('Sinkron ulang transkrip dapat dipanggil dosen pemilik', async () => {
    const response = await call(GATEWAY, 'POST', `/kelas/${kelas2Id}/sinkron`, {
      token: dosen2.data.access_token,
      device: 'dev-dosen2-01',
    });
    eq(response.status, 200, 'status');
    eq(response.data.sync.status, 'synced', 'sync');
    eq(response.data.sync.synced, 2, 'idempotent');
  });

  // ── 12. Audit log ─────────────────────────────────────────
  await test('Audit log mencatat allow/deny lengkap tanpa membocorkan token', async () => {
    checkAudit();
  });

  console.log(`\nHasil: ${pass} lulus, ${fail} gagal`);
  if (fail > 0) {
    console.log('\nDetail kegagalan:');
    for (const { name, error } of failures) {
      console.log(`- ${name}: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\n✗ Smoke test berhenti:', error.message);
  process.exitCode = 1;
});
