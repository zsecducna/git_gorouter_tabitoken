// bin/verify.js — reconcile ACTUAL server-side credits against the DB.
//
//   node bin/verify.js                 # all registered capcut accounts
//   node bin/verify.js --username X    # one account
//
// Why a browser: the user_credit API needs the page SDK's signature — from
// Node it serves a decoy "login error" 0-credit envelope (measured
// 2026-09-02). In a real page the signed read returns the truth (this exact
// read proved the first 1540). ~15-20s per account; the grant-sum ledger
// stays the fast path, this is the reconciliation pass.

import { loadEnv } from '../src/util/util.js';
import { openAccountsDb, capcutStats, updateCapcutCredits } from '../src/infra/db.js';
import { openBrowser, closeBrowser } from '../src/browser/browser.js';
import { login } from '../src/core/capcut-login.js';
import { warmUp } from '../src/core/capcut-api.js';
import { getCredit, creditTotal } from '../src/core/capcut-tasks.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
loadEnv();
const cfg = await import('../config.js');
const settings = {};
for (const k of Object.keys(cfg)) if (/^[A-Z][A-Z0-9_]*$/.test(k)) settings[k] = cfg[k];

const args = process.argv.slice(2);
const oneIdx = args.indexOf('--username');
const one = oneIdx !== -1 ? args[oneIdx + 1] : null;

const db = openAccountsDb('');
const rows = one
  ? db.prepare("SELECT username,email,password,capcut_credits FROM accounts WHERE site='capcut.com' AND username=? AND status='registered'").all(one)
  : db.prepare("SELECT username,email,password,capcut_credits FROM accounts WHERE site='capcut.com' AND status='registered' ORDER BY created").all();
if (!rows.length) { log('no registered accounts'); db.close(); process.exit(one ? 2 : 0); }
log(`verifying ${rows.length} account(s) against the server ledger ...`);

const handle = await openBrowser(settings, { name: 'verify', rawProxy: null, log: () => {} });
const results = [];
try {
  for (const r of rows) {
    let total = null;
    for (let attempt = 0; attempt < 2 && total === null; attempt++) {
      try {
        await warmUp(handle.page, { localePath: 'vi-vn', log: () => {} });
        await login(handle.page, null, r.email, r.password, { log: () => {} });
        await handle.page.goto('https://www.capcut.com/my-edit', { timeout: 90000 });
        await new Promise((res) => setTimeout(res, 2500));
        total = creditTotal(await getCredit(handle.page));
      } catch (e) {
        if (attempt) log(`  [!] ${r.username}: read failed (${String(e.message).split('\n')[0].slice(0, 60)})`);
        else await new Promise((res) => setTimeout(res, 2000));
      }
    }
    if (total === null) { results.push({ ...r, actual: null }); continue; }
    const known = r.capcut_credits ?? 0;
    const drift = total - known;
    updateCapcutCredits(db, r.username, total, null);
    results.push({ ...r, actual: total, drift });
    log(`  ${r.username.padEnd(14)} ${r.email.padEnd(34)} ledger=${String(known).padStart(5)} actual=${String(total).padStart(5)} ${drift ? `Δ${drift > 0 ? '+' : ''}${drift}` : '✓'}`);
  }
} finally {
  await closeBrowser(handle, { settings });
}
db.close();

// regenerate exports with verified numbers
const all = results.filter((x) => x.actual !== null);
if (all.length) {
  const db2 = openAccountsDb('');
  const rows2 = db2.prepare("SELECT email,password,capcut_credits,capcut,created FROM accounts WHERE site='capcut.com' AND status='registered' ORDER BY created").all();
  db2.close();
  const line = (r) => `${r.email}|${r.password}|${r.capcut_credits ?? 0}|${r.capcut === 'pro' ? 'pro' : 'free'}|${(r.created || '').slice(0, 16)}`;
  fs.mkdirSync(path.join(PKG_ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(PKG_ROOT, 'data', 'capcut_accounts.txt'), rows2.map(line).join('\n') + '\n');
  fs.writeFileSync(path.join(PKG_ROOT, 'data', 'capcut_free.txt'), rows2.filter((r) => (r.capcut || 'free') !== 'pro').map(line).join('\n') + '\n');
}
const failed = results.filter((x) => x.actual === null).length;
const totalActual = results.reduce((s, x) => s + (x.actual || 0), 0);
log(`verify done: ${results.length - failed}/${results.length} read — total actual credit across fleet: ${totalActual}${failed ? ` (${failed} unreadable)` : ''}`);
process.exit(failed ? 1 : 0);
