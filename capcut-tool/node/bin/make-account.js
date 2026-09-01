// bin/make-account.js — browserless account factory: rent gmail → signup →
// claim credits, NO CloakBrowser, ~1 min/account (OTP-bound).
//
//   node bin/make-account.js 1        # one account (okotp rental)
//   node bin/make-account.js 5        # five, sequential
//
// Requires MAIL_PROVIDER='okotp' + OTP_API_KEY (config.js or .env).
// DB rows: claims the oldest 'unregistered' row per account, swaps in the
// rented gmail, marks registered with the grant-sum credit total.

import { loadEnv } from '../src/util/util.js';
import { openAccountsDb, ensureCapcutColumns, claimNextCapcut, setCapcutEmail, markCapcutRegistered, markCapcutPoisoned, capcutStats, ensureCreditGrants, grantsToday, recordGrant } from '../src/infra/db.js';
import { OkotpClient, makeOrderMailbox } from '../src/infra/okotp.js';
import { ensureEmailPool, poolClaim } from '../src/infra/email-pool.js';
import { signupAndClaim } from '../src/core/node-signup.js';
import { openBrowser, closeBrowser } from '../src/browser/browser.js';
import { login } from '../src/core/capcut-login.js';
import { warmUp } from '../src/core/capcut-api.js';
import { getCredit, creditTotal } from '../src/core/capcut-tasks.js';

const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
loadEnv();
const cfg = await import('../config.js');
const settings = {};
for (const k of Object.keys(cfg)) if (/^[A-Z][A-Z0-9_]*$/.test(k)) settings[k] = cfg[k];

const N = Number(process.argv[2] || 1);
const NO_VERIFY = process.argv.includes('--no-verify'); // batch mode: creation only, rows stay pending
if (!Number.isFinite(N) || N < 1) { log('usage: node bin/make-account.js <count>'); process.exit(2); }
if (settings.MAIL_PROVIDER !== 'okotp' || !(settings.OTP_API_KEY || process.env.OTP_API_KEY)) {
  log('[!] browserless mode needs MAIL_PROVIDER=okotp + OTP_API_KEY (config.js or .env)');
  process.exit(2);
}

const db = openAccountsDb('');
ensureCapcutColumns(db);
ensureCreditGrants(db);
const okotp = new OkotpClient(settings.OTP_API_KEY || process.env.OTP_API_KEY, {
  baseUrl: settings.OTP_BASE || 'https://api.okotp.com', log: () => {},
});

let made = 0;
for (let i = 0; i < N; i++) {
  const row = claimNextCapcut(db);
  if (!row) { log('queue empty — run bin/provision.js first'); break; }
  log(`[#${i + 1}] ${row.username} — acquiring gmail ...`);
  // Pool first (pre-warmed by bin/prewarm.js — zero rental wait in the
  // pipeline), direct rental as fallback when the pool is dry.
  let got = null;
  try { got = poolClaim(db); } catch { /* pool table missing — create it */ ensureEmailPool(db); }
  if (!got) {
    try {
      const order = await okotp.createOrder({ serviceId: settings.OTP_SERVICE_ID, emailTypeId: settings.OTP_EMAIL_TYPE_ID });
      const email = order?.email || order?.data?.email;
      if (email) got = { email, order };
    } catch (e) {
      log(`[!] rental failed: ${e.message}`);
      markCapcutPoisoned(db, row.username, 'poison: okotp rental failed: ' + e.message.slice(0, 60));
      continue;
    }
  } else {
    log('    using pre-warmed rental (0s wait)');
  }
  if (!got?.email) { log('[!] no email available (pool dry + rental failed)'); markCapcutPoisoned(db, row.username, 'poison: no email'); continue; }
  const { email, order } = got;
  setCapcutEmail(db, row.username, email);
  log(`    ${email}`);

  const mailbox = makeOrderMailbox(okotp, order, { log: () => {} });
  const t0 = Date.now();
  try {
    const res = await signupAndClaim(email, row.password, mailbox, {
      log: (m) => log(m),
      codeTimeout: Number(settings.OTP_CODE_TIMEOUT) || 300,
      grantedToday: grantsToday(db, row.username),
      recordGrant: (taskId, reward) => recordGrant(db, row.username, taskId, reward),
    });
    if (!res) throw new Error('signup failed (see log)');
    // PENDING, not registered: the row only becomes 'registered' with a
    // VERIFIED server-side credit number (user requirement 2026-09-02) —
    // task instances ripen for minutes, so the number is unreadable now.
    db.prepare("UPDATE accounts SET status='pending' WHERE username=?").run(row.username);
    made++;
    log(`    ✔ ${email} — user_id=${res.uid} (pending verification, grants so far ${res.total}) in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    log(`    ✖ ${e.message} — row released for retry`);
    db.prepare("UPDATE accounts SET status='unregistered' WHERE username=?").run(row.username);
  } finally {
    await mailbox.release?.().catch(() => {});
  }
}
log(`created ${made}/${N} — verifying actual credits before completing rows ...`);

// Signed browser read of the REAL ledger (the only truth; Node gets a decoy
// envelope). Round-robin: first accounts ripen while later ones are still
// being created, so early rounds complete most rows and retries only wait
// out the slowest instances.
async function readActual(page, email, password) {
  try {
    await warmUp(page, { localePath: 'vi-vn', log: () => {} });
    await login(page, null, email, password, { log: () => {} });
    await page.goto('https://www.capcut.com/my-edit', { timeout: 90000 });
    await new Promise((r) => setTimeout(r, 2500));
    return creditTotal(await getCredit(page));
  } catch {
    return null;
  }
}
const MAX_WAIT_MIN = Number(process.env.CAPCUT_VERIFY_WAIT_MIN || 20);
const deadline = Date.now() + MAX_WAIT_MIN * 60 * 1000;
let completed = 0;
if (NO_VERIFY || N <= 0) {
  if (NO_VERIFY) log('(verification phase skipped — run bin/verify.js or bin/batch.js later)');
  // N<=0 with verification enabled = verify-only mode (used by bin/batch.js)
}
const handle = (NO_VERIFY) ? null : await openBrowser(settings, { name: 'make-verify', rawProxy: null, log: () => {} });
try {
  while (handle && Date.now() < deadline) {
    const pending = db.prepare("SELECT username,email,password FROM accounts WHERE site='capcut.com' AND status='pending' ORDER BY created").all();
    if (!pending.length) break;
    for (const p of pending) {
      const actual = await readActual(handle.page, p.email, p.password);
      if (actual != null && actual > 0) {
        markCapcutRegistered(db, p.username, { credits: actual, plan: 'free' });
        completed++;
        log(`  ✓ ${p.username} — verified ${actual} credits — registered`);
      } else {
        log(`  . ${p.username} — not ripe yet (reads ${actual ?? 'error'}), retrying ...`);
      }
      if (Date.now() >= deadline) break;
    }
    if (db.prepare("SELECT 1 FROM accounts WHERE site='capcut.com' AND status='pending' LIMIT 1").get()) {
      await new Promise((r) => setTimeout(r, 45000));
    }
  }
} finally {
  if (handle) await closeBrowser(handle, { settings });
}
const stillPending = db.prepare("SELECT COUNT(*) c FROM accounts WHERE site='capcut.com' AND status='pending'").get().c;
log(`done: ${completed} verified+registered${stillPending ? `, ${stillPending} still pending (run bin/verify.js later)` : ''} — ${JSON.stringify(capcutStats(db))}`);
db.close();
process.exit(made ? 0 : 1);
