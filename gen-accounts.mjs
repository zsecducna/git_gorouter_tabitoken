// gen-accounts.mjs — provision N account rows into accounts.db.
// Rows are status='unregistered' with random Vt-hex passwords; pipelines pick
// them up in username order. Username suffix = domain with dots/dashes stripped
// (my-domain.io → user0001mydomainio).
//
// Usage:
//   node gen-accounts.mjs <N> <domain> [startIndex]
//   node gen-accounts.mjs 1000 listing-studio.uk        # user0001..user1000
//   node gen-accounts.mjs 500 mydomain.com 1001         # user1001..user1500
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const DB = fileURLToPath(new URL('./accounts.db', import.meta.url));
const NEW = !fs.existsSync(DB);
const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS accounts (
  site TEXT, email TEXT, username TEXT, password TEXT,
  region TEXT, created TEXT, status TEXT,
  gorouter TEXT, gorouter_api_key TEXT,
  tabitoken TEXT, tabitoken_api_key TEXT
)`);

const N = Number(process.argv[2] ?? 0);
const domain = process.argv[3];
const start = Number(process.argv.slice(4).find((a) => /^\d+$/.test(a)) ?? 1); // flags may occupy argv[4]
if (!N || N < 1 || !domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
  console.error('usage: node gen-accounts.mjs <N> <domain> [startIndex] [--random]');
  console.error('  e.g. node gen-accounts.mjs 1000 listing-studio.uk');
  console.error('       node gen-accounts.mjs 1000 duke-kr.win --random   # unpredictable usernames');
  process.exit(1);
}
const RANDOM = process.argv.includes('--random');
const randName = () => 'u' + crypto.randomBytes(5).toString('hex'); // u+10 hex

const suffix = domain.replace(/[.-]/g, '');
const ins = db.prepare('INSERT INTO accounts (site,email,username,password,region,created,status) VALUES (?,?,?,?,?,?,?)');
let added = 0, skipped = 0;
for (let i = start; i < start + N; i++) {
  // random mode: username IS the identity, email = username@domain (catch-all);
  // sequential mode keeps numbered scheme for range-sharded lanes
  let full;
  do { full = RANDOM ? randName() : 'user' + String(i).padStart(4, '0') + suffix; }
  while (db.prepare('SELECT 1 FROM accounts WHERE username=? OR email=?').get(full, `${full}@${domain}`));
  ins.run('github.com', `${full}@${domain}`, full,
    'Vt-' + crypto.randomBytes(6).toString('hex') + '-9x!K',
    'Vietnam', new Date().toISOString(), 'unregistered');
  added++;
}
console.log(`provisioned ${added} rows @${domain} (${skipped} existed) — ${db.prepare('SELECT COUNT(*) c FROM accounts').get().c} total${NEW ? ' (db created)' : ''}`);
console.log('next up (this batch):', db.prepare("SELECT username FROM accounts WHERE status='unregistered' AND email LIKE ? ORDER BY username LIMIT 1").get(`%@${domain}`)?.username);
