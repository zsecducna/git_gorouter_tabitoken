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
import { openAccountsDb, ensureCapcutColumns, claimNextCapcut, setCapcutEmail, markCapcutRegistered, markCapcutPoisoned, capcutStats } from '../src/infra/db.js';
import { OkotpClient, makeOrderMailbox } from '../src/infra/okotp.js';
import { ensureEmailPool, poolClaim } from '../src/infra/email-pool.js';
import { signupAndClaim } from '../src/core/node-signup.js';

const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
loadEnv();
const cfg = await import('../config.js');
const settings = {};
for (const k of Object.keys(cfg)) if (/^[A-Z][A-Z0-9_]*$/.test(k)) settings[k] = cfg[k];

const N = Number(process.argv[2] || 1);
if (!Number.isFinite(N) || N < 1) { log('usage: node bin/make-account.js <count>'); process.exit(2); }
if (settings.MAIL_PROVIDER !== 'okotp' || !(settings.OTP_API_KEY || process.env.OTP_API_KEY)) {
  log('[!] browserless mode needs MAIL_PROVIDER=okotp + OTP_API_KEY (config.js or .env)');
  process.exit(2);
}

const db = openAccountsDb('');
ensureCapcutColumns(db);
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
    });
    if (!res) throw new Error('signup failed (see log)');
    markCapcutRegistered(db, row.username, { credits: res.total, plan: 'free' });
    made++;
    log(`    ✔ ${email} — user_id=${res.uid} credits=${res.total} in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    log(`    ✖ ${e.message} — row released for retry`);
    db.prepare("UPDATE accounts SET status='unregistered' WHERE username=?").run(row.username);
  } finally {
    await mailbox.release?.().catch(() => {});
  }
}
log(`done: ${made}/${N} created — ${JSON.stringify(capcutStats(db))}`);
db.close();
process.exit(made ? 0 : 1);
