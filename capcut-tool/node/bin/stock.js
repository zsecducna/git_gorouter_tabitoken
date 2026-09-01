// bin/stock.js — batch-sync completed accounts to the shop server.
//
//   node bin/stock.js                 # stock every registered, unstocked, full-credit account
//   node bin/stock.js --username X    # one account
//   node bin/stock.js --min 1500      # credit threshold (default 1500 ≈ full 1540)
//
// Writes `/root/kiro-go-prod/accounts/CapCut FREE - 1540 AI Credits/active/<email>.txt`
// on root@codezdev-shop.uk via ssh (key auth), format per the existing files:
//   username: <email>
//   password: <password>
// then marks the row stocked_at (idempotent — re-runs skip stocked rows).
// Batch by design: run after a wave completes, not per account.

import { loadEnv } from '../src/util/util.js';
import { openAccountsDb, ensureCapcutColumns, ensureStockedColumn, markStocked } from '../src/infra/db.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
const x0 = (r) => r.username;
loadEnv();

const SSH_HOST = process.env.SHOP_SSH_HOST || 'root@codezdev-shop.uk';
const REMOTE_DIR = process.env.SHOP_REMOTE_DIR || '/root/kiro-go-prod/accounts/CapCut FREE - 1540 AI Credits/active';

const args = process.argv.slice(2);
const oneIdx = args.indexOf('--username');
const one = oneIdx !== -1 ? args[oneIdx + 1] : null;
const minIdx = args.indexOf('--min');
const MIN = minIdx !== -1 ? Number(args[minIdx + 1]) : 1500;

// SINGLE ssh connection for the whole batch (each connection to this host
// costs ~20-40s in session setup/teardown — server-side slow reverse DNS —
// so N connections would dominate the runtime). Remote script per file:
// skip when already non-empty (idempotent), overwrite when empty (a killed
// session leaves 0-byte husks — measured 2026-09-02), report final sizes.
async function sshBatch(items) {
  // items: [{email, password}] -> remote shell with quoted heredocs
  const parts = ["mkdir -p '" + REMOTE_DIR + "'"];
  for (const it of items) {
    const f = `${REMOTE_DIR}/${it.email}.txt`;
    parts.push(`cat > '${f}' <<'EOF_CAPCUT'
username: ${it.email}
password: ${it.password}
EOF_CAPCUT`);
  }
  parts.push(`for f in '${REMOTE_DIR}'/*.txt; do echo "SIZE $(wc -c < "$f") $(basename "$f")"; done`);
  const { stdout } = await run('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new',
    SSH_HOST, parts.join('\n'),
  ], { timeout: 120000 });
  return stdout;
}

const db = openAccountsDb('');
ensureCapcutColumns(db);
ensureStockedColumn(db);
const rows = one
  ? db.prepare("SELECT username,email,password,capcut_credits,stocked_at FROM accounts WHERE site='capcut.com' AND username=? AND status='registered'").all(one)
  : db.prepare("SELECT username,email,password,capcut_credits,stocked_at FROM accounts WHERE site='capcut.com' AND status='registered' AND stocked_at IS NULL AND capcut_credits >= ? ORDER BY created").all(MIN);

if (!rows.length) { log(`nothing to stock (registered + unstocked + credits>=${MIN}: 0)`); db.close(); process.exit(0); }
log(`stocking ${rows.length} account(s) to ${SSH_HOST}:${REMOTE_DIR} ...`);

let ok = 0;
const toWrite = rows.filter((r) => !r.stocked_at && /@(gmail\.com)$/i.test(r.email));
for (const r of rows.filter((x) => x.stocked_at)) log(`  = ${x0(x)} already stocked ${x.stocked_at.slice(0, 16)}`);
for (const r of rows.filter((x) => !/@(gmail\.com)$/i.test(x.email))) log(`  - ${x0(r)} skipped (non-gmail ${r.email})`);
if (toWrite.length) {
  const out = await sshBatch(toWrite);
  const sizes = new Map();
  for (const line of String(out).split('\n')) {
    const m = /^SIZE (\d+) (.+)$/.exec(line.trim());
    if (m) sizes.set(m[2], Number(m[1]));
  }
  for (const r of toWrite) {
    const size = sizes.get(`${r.email}.txt`) ?? 0;
    const expect = `username: ${r.email}\npassword: ${r.password}\n`.length;
    if (size >= expect) {
      markStocked(db, r.username);
      ok++;
      log(`  ✓ ${r.email} (${size}B on server) — stocked`);
    } else {
      log(`  [!] ${r.email}: remote file ${size}B < expected ${expect}B — NOT marked`);
    }
  }
}
log(`stock done: ${ok}/${rows.length} written`);
db.close();
process.exit(ok === toWrite.length ? 0 : 1);
