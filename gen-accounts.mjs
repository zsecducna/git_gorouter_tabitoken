// gen-accounts.mjs — provision N account rows into accounts.db.
// Rows are status='unregistered' with random Vt-hex passwords; pipelines pick
// them up in username order.
//
// Usage:
//   node gen-accounts.mjs <N> [startIndex] [domain]
//   node gen-accounts.mjs 1000            # user0001..user1000 @ listing-studio.uk
//   node gen-accounts.mjs 500 1001        # user1001..user1500
//   node gen-accounts.mjs 10 1 mydomain.com
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
const start = Number(process.argv[3] ?? 1);
const domain = process.argv[4] ?? 'listing-studio.uk';
if (!N || N < 1) {
  console.error('usage: node gen-accounts.mjs <N> [startIndex] [domain]');
  process.exit(1);
}

const ins = db.prepare('INSERT INTO accounts (site,email,username,password,region,created,status) VALUES (?,?,?,?,?,?,?)');
let added = 0, skipped = 0;
for (let i = start; i < start + N; i++) {
  const username = 'user' + String(i).padStart(4, '0');
  const suffix = domain.split('.')[0].replace(/-/g, ''); // listing-studio.uk → listingstudio
  const full = username + suffix;
  if (db.prepare('SELECT 1 FROM accounts WHERE username=? OR email=?').get(full, `${username}@${domain}`)) { skipped++; continue; }
  ins.run('github.com', `${username}@${domain}`, full,
    'Vt-' + crypto.randomBytes(6).toString('hex') + '-9x!K',
    'Vietnam', new Date().toISOString(), 'unregistered');
  added++;
}
console.log(`provisioned ${added} rows (${skipped} existed) — ${db.prepare('SELECT COUNT(*) c FROM accounts').get().c} total${NEW ? ' (db created)' : ''}`);
console.log('next up:', db.prepare("SELECT username FROM accounts WHERE status='unregistered' ORDER BY username LIMIT 1").get()?.username);
