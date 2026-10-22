'use strict';

/**
 * Membuat .env dari .env.example dengan secret acak.
 *   npm run setup
 *   npm run setup -- --force   (timpa .env yang sudah ada)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const examplePath = path.join(ROOT, '.env.example');
const envPath = path.join(ROOT, '.env');
const force = process.argv.includes('--force');

if (!fs.existsSync(examplePath)) {
  console.error('✗ .env.example tidak ditemukan');
  process.exit(1);
}

if (fs.existsSync(envPath) && !force) {
  console.log('✓ .env sudah ada; tidak ditimpa.');
  console.log('  Gunakan "npm run setup -- --force" jika ingin membuat ulang.');
  process.exit(0);
}

const randomSecret = () => crypto.randomBytes(32).toString('hex');

let content = fs.readFileSync(examplePath, 'utf8');
content = content
  .replace(/^JWT_ACCESS_SECRET=.*$/m, `JWT_ACCESS_SECRET=${randomSecret()}`)
  .replace(/^JWT_SERVICE_SECRET=.*$/m, `JWT_SERVICE_SECRET=${randomSecret()}`)
  .replace(/^GATEWAY_SECRET=.*$/m, `GATEWAY_SECRET=${randomSecret()}`);

fs.writeFileSync(envPath, content, { mode: 0o600 });

console.log('✓ .env dibuat dengan secret acak.');
console.log('  Service client: nilai-service / svc-nilai-secret-2026');
console.log('\nLangkah berikutnya:');
console.log('  npm install');
console.log('  npm run seed');
console.log('  npm run dev');
