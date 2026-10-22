'use strict';

const { getDb } = require('../shared/db');
const { accessWindowStatus } = require('../shared/http');
const { REASONS, ROLES } = require('../shared/constants');

function allow(message, extra = {}) {
  return {
    allow: true,
    status: 200,
    code: REASONS.ALLOWED,
    message,
    ...extra,
  };
}

function deny(status, code, message) {
  return { allow: false, status, code, message };
}

function normalizePath(path) {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function notFound(what) {
  return deny(404, REASONS.RESOURCE_NOT_FOUND, `${what} tidak ditemukan`);
}

function outsideHours() {
  const window = accessWindowStatus();
  return deny(403, REASONS.OUTSIDE_ACCESS_HOURS, window.reason);
}

/**
 * Policy Decision Point.
 *
 * Keputusan kepemilikan data TIDAK diambil dari isi token, melainkan dari
 * database (kelas.dosen_id, users.nim, nilai.kelas_id). Inilah bagian yang
 * membuat gateway berperan sebagai Policy Engine, bukan sekadar cek role.
 *
 * @returns {{allow: boolean, status: number, code: string, message: string,
 *            target?: 'nilai'|'transkrip', scope?: string, kelasId?: number}}
 */
function decide({ subject, method, path }) {
  const route = normalizePath(path);

  // ── GET /nilai ──────────────────────────────────────────────
  if (method === 'GET' && route === '/nilai') {
    if (subject.type !== 'user') {
      return deny(403, REASONS.ROLE_NOT_ALLOWED, 'Endpoint ini hanya untuk user');
    }
    if (subject.role === ROLES.MAHASISWA) {
      return allow('Mahasiswa hanya dapat melihat nilai miliknya sendiri', {
        target: 'nilai',
        scope: 'self',
      });
    }
    if (subject.role === ROLES.DOSEN) {
      return allow('Dosen hanya dapat melihat nilai pada kelas yang diampu', {
        target: 'nilai',
        scope: 'dosen',
      });
    }
    return deny(
      403,
      REASONS.ROLE_NOT_ALLOWED,
      `Role ${subject.role} tidak berhak mengakses daftar nilai`,
    );
  }

  // ── PUT /nilai/:id ─────────────────────────────────────────
  const updateMatch = /^\/nilai\/(\d+)$/.exec(route);
  if (method === 'PUT' && updateMatch) {
    if (subject.type !== 'user' || subject.role !== ROLES.DOSEN) {
      return deny(
        403,
        REASONS.ROLE_NOT_ALLOWED,
        'Hanya dosen yang boleh mengubah nilai',
      );
    }

    const nilaiId = Number(updateMatch[1]);
    const row = getDb()
      .prepare(
        `SELECT n.id, n.kelas_id, k.kode_kelas, k.dosen_id, k.is_final
         FROM nilai n JOIN kelas k ON k.id = n.kelas_id
         WHERE n.id = ?`,
      )
      .get(nilaiId);

    if (!row) return notFound('Nilai');

    if (row.dosen_id !== subject.id) {
      return deny(
        403,
        REASONS.NOT_OWNER,
        `Kelas ${row.kode_kelas} bukan kelas yang diampu ${subject.username}`,
      );
    }

    if (row.is_final === 1) {
      return deny(
        409,
        REASONS.ALREADY_FINAL,
        `Nilai kelas ${row.kode_kelas} sudah difinalisasi dan tidak dapat diubah`,
      );
    }

    const window = accessWindowStatus();
    if (!window.allowed) {
      return deny(403, REASONS.OUTSIDE_ACCESS_HOURS, window.reason);
    }

    return allow(
      `Dosen pemilik kelas ${row.kode_kelas}, nilai belum final, ${window.reason}`,
      { target: 'nilai', kelasId: row.kelas_id },
    );
  }

  // ── POST /kelas/:id/finalisasi ─────────────────────────────
  const finalizeMatch = /^\/kelas\/(\d+)\/finalisasi$/.exec(route);
  if (method === 'POST' && finalizeMatch) {
    if (subject.type !== 'user' || subject.role !== ROLES.DOSEN) {
      return deny(
        403,
        REASONS.ROLE_NOT_ALLOWED,
        'Hanya dosen yang boleh memfinalisasi nilai',
      );
    }

    const row = getDb()
      .prepare('SELECT id, kode_kelas, dosen_id, is_final FROM kelas WHERE id = ?')
      .get(Number(finalizeMatch[1]));

    if (!row) return notFound('Kelas');

    if (row.dosen_id !== subject.id) {
      return deny(
        403,
        REASONS.NOT_OWNER,
        `Kelas ${row.kode_kelas} bukan kelas yang diampu ${subject.username}`,
      );
    }

    if (row.is_final === 1) {
      return deny(
        409,
        REASONS.ALREADY_FINAL,
        `Kelas ${row.kode_kelas} sudah difinalisasi`,
      );
    }

    const window = accessWindowStatus();
    if (!window.allowed) {
      return deny(403, REASONS.OUTSIDE_ACCESS_HOURS, window.reason);
    }

    return allow(
      `Dosen pemilik kelas ${row.kode_kelas}, ${window.reason}`,
      { target: 'nilai', kelasId: row.id },
    );
  }

  // ── POST /kelas/:id/sinkron (tambahan: retry sinkron transkrip) ──
  const resyncMatch = /^\/kelas\/(\d+)\/sinkron$/.exec(route);
  if (method === 'POST' && resyncMatch) {
    if (subject.type !== 'user' || subject.role !== ROLES.DOSEN) {
      return deny(
        403,
        REASONS.ROLE_NOT_ALLOWED,
        'Hanya dosen yang boleh menyinkronkan transkrip kelas',
      );
    }

    const row = getDb()
      .prepare('SELECT id, kode_kelas, dosen_id, is_final FROM kelas WHERE id = ?')
      .get(Number(resyncMatch[1]));

    if (!row) return notFound('Kelas');

    if (row.dosen_id !== subject.id) {
      return deny(
        403,
        REASONS.NOT_OWNER,
        `Kelas ${row.kode_kelas} bukan kelas yang diampu ${subject.username}`,
      );
    }

    if (row.is_final !== 1) {
      return deny(
        409,
        REASONS.NOT_FINAL,
        `Kelas ${row.kode_kelas} belum difinalisasi`,
      );
    }

    return allow(`Sinkron ulang transkrip kelas ${row.kode_kelas}`, {
      target: 'nilai',
      kelasId: row.id,
    });
  }

  // ── GET /transkrip/:nim ────────────────────────────────────
  const transkripMatch = /^\/transkrip\/([^/]+)$/.exec(route);
  if (method === 'GET' && transkripMatch) {
    if (subject.type !== 'user') {
      return deny(403, REASONS.ROLE_NOT_ALLOWED, 'Endpoint ini hanya untuk user');
    }

    let nim;
    try {
      nim = decodeURIComponent(transkripMatch[1]);
    } catch {
      nim = transkripMatch[1];
    }

    if (subject.role === ROLES.ADMIN) {
      return allow(`Admin melihat transkrip NIM ${nim}`, {
        target: 'transkrip',
      });
    }

    if (subject.role === ROLES.MAHASISWA) {
      if (subject.nim !== nim) {
        return deny(
          403,
          REASONS.NOT_OWNER,
          `Mahasiswa ${subject.nim} hanya boleh melihat transkrip NIM sendiri`,
        );
      }
      return allow(`Mahasiswa melihat transkrip miliknya (${nim})`, {
        target: 'transkrip',
      });
    }

    return deny(
      403,
      REASONS.ROLE_NOT_ALLOWED,
      `Role ${subject.role} tidak berhak mengakses transkrip`,
    );
  }

  // ── POST /transkrip/sinkron ────────────────────────────────
  if (method === 'POST' && route === '/transkrip/sinkron') {
    if (subject.type !== 'service' || subject.role !== ROLES.SERVICE) {
      return deny(
        403,
        REASONS.SERVICE_TOKEN_REQUIRED,
        'Sinkron transkrip hanya boleh dipanggil Service Nilai dengan token service',
      );
    }
    return allow(`Panggilan service ${subject.id} ke sinkron transkrip`, {
      target: 'transkrip',
    });
  }

  return deny(
    404,
    REASONS.ROUTE_NOT_FOUND,
    `Route ${method} ${route} tidak dikenal`,
  );
}

module.exports = { decide };
