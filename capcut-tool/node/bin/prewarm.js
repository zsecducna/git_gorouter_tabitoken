// bin/prewarm.js — pre-rent okotp gmails into the pool so the browserless
// pipeline never waits on rental.
//
//   node bin/prewarm.js 5           # top the pool up to 5 fresh rentals
//   node bin/prewarm.js 5 --force   # add 5 regardless of what's pooled
//
// Entries expire after ~110 min (okotp boxes live ~2h) — size the warm batch
// to what the pipeline will consume within that window; unconsumed rentals
// are dead money (no release API).

import { loadEnv } from '../src/util/util.js';
import { openAccountsDb, ensureCapcutColumns } from '../src/infra/db.js';
import { ensureEmailPool, poolAdd, poolFreshCount } from '../src/infra/email-pool.js';
import { OkotpClient } from '../src/infra/okotp.js';

const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
loadEnv();
const cfg = await import('../config.js');
const settings = {};
for (const k of Object.keys(cfg)) if (/^[A-Z][A-Z0-9_]*$/.test(k)) settings[k] = cfg[k];

const n = Number(process.argv[2] || 0);
const FORCE = process.argv.includes('--force');
if (!Number.isFinite(n) || n < 1) {
  console.error('usage: node bin/prewarm.js <count> [--force]');
  process.exit(2);
}
if (!(settings.OTP_API_KEY || process.env.OTP_API_KEY)) {
  log('[!] OTP_API_KEY missing (config.js or .env)');
  process.exit(2);
}

const db = openAccountsDb('');
ensureCapcutColumns(db);
ensureEmailPool(db);
const have = poolFreshCount(db);
const need = FORCE ? n : Math.max(0, n - have);
log(`pool: ${have} fresh — renting ${need}`);
const okotp = new OkotpClient(settings.OTP_API_KEY || process.env.OTP_API_KEY, {
  baseUrl: settings.OTP_BASE || 'https://api.okotp.com', log: () => {},
});
for (let i = 0; i < need; i++) {
  try {
    const order = await okotp.createOrder({ serviceId: settings.OTP_SERVICE_ID, emailTypeId: settings.OTP_EMAIL_TYPE_ID });
    const email = order?.email || order?.data?.email;
    if (!email) throw new Error('no email in order');
    poolAdd(db, email, order);
    log(`  + ${email} (expires in ~110 min)`);
  } catch (e) {
    log(`  [!] rental ${i + 1}/${need} failed: ${e.message}`);
  }
}
log(`pool now: ${poolFreshCount(db)} fresh — balance ${JSON.stringify(await okotp.balance().catch(() => '?'))}`);
db.close();
