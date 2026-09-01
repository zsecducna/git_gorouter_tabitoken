// bin/claim.js — headless daily credit claim (NO browser, ~10-15s/account).
//
//   node bin/claim.js                    # claim for all registered capcut accounts
//   node bin/claim.js --username <name>  # one named account
//   node bin/claim.js --dry              # show targets, claim nothing
//
// DB is the source of truth; credits + plan written back, and the export
// files (capcut_accounts.txt / capcut_free.txt) regenerated in the
// email|password|credit|plan|date format.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/util/util.js';
import { openAccountsDb, capcutStats, updateCapcutCredits, ensureCreditGrants, grantsToday, recordGrant } from '../src/infra/db.js';
import { claimAll } from '../src/core/claim.js';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const DRY = args.includes('--dry') || args.includes('--dry-run');
const oneIdx = args.indexOf('--username');
const one = oneIdx !== -1 ? args[oneIdx + 1] : null;

const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
loadEnv();

const db = openAccountsDb('');
ensureCreditGrants(db);
const stats = capcutStats(db);
log(`capcut.com queue: ${stats.registered} registered / ${stats.unregistered} unregistered / ${stats.poisoned} poisoned`);
const rows = one
  ? db.prepare("SELECT username,email,password FROM accounts WHERE site='capcut.com' AND username=? AND status IN ('registered','pending')").all(one)
  : db.prepare("SELECT username,email,password FROM accounts WHERE site='capcut.com' AND status IN ('registered','pending') ORDER BY created").all();
if (!rows.length) {
  log(one ? `no registered account '${one}'` : 'no registered accounts — provision + signup first');
  db.close();
  process.exit(one ? 2 : 0);
}
if (DRY) {
  for (const r of rows) log(`  would claim: ${r.username} (${r.email})`);
  db.close();
  process.exit(0);
}

let ok = 0;
for (const r of rows) {
  log(`[#] ${r.username} (${r.email})`);
  try {
    const prevGrants = grantsToday(db, r.username);
    const res = await claimAll(r.email, r.password, {
      log: (m) => log('    ' + m), rounds: 4, gapSeconds: 45,
      grantedToday: prevGrants, recordGrant: (taskId, reward) => recordGrant(db, r.username, taskId, reward),
    });
    // nothing to claim today -> keep the DB's existing balance; else write the
    // fresh claimed-sum (daily credits expire — yesterday's number is stale)
    const prev = db.prepare('SELECT capcut_credits c FROM accounts WHERE username=?').get(r.username)?.c ?? 0;
    const total = res.total > 0 ? prev + res.total : prev;
    updateCapcutCredits(db, r.username, total, null);
    if (total > 0) ok++;
    log(`    → total ${total}${res.sharkBlocked ? ` (${res.sharkBlocked} shark-blocked)` : ''}`);
  } catch (e) {
    log(`    [!] ${e.message}`);
  }
}

// Regenerate the export files from the (now updated) DB.
const all = db.prepare("SELECT email,password,capcut_credits,capcut,created FROM accounts WHERE site='capcut.com' AND status IN ('registered','pending') ORDER BY created").all();
db.close();
const line = (r) => `${r.email}|${r.password}|${r.capcut_credits ?? 0}|${r.capcut === 'pro' ? 'pro' : 'free'}|${(r.created || '').slice(0, 16)}`;
const dataDir = path.join(PKG_ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'capcut_accounts.txt'), all.map(line).join('\n') + '\n');
fs.writeFileSync(path.join(dataDir, 'capcut_free.txt'), all.filter((r) => (r.capcut || 'free') !== 'pro').map(line).join('\n') + '\n');
log(`claim pass done: ${ok}/${rows.length} accounts hold credit — exports regenerated`);
process.exit(0);
