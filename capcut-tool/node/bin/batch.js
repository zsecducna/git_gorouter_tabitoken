// bin/batch.js — production orchestrator: N accounts, 3 concurrent creation
// workers, least-used-first proxies (statics + kiot keys), okotp balance
// guard (<1 stops NEW rentals), then a verify phase and a stock sync.
//
//   node bin/batch.js 380            # 380 accounts, default 3 workers
//   node bin/batch.js 380 -t 3
//
// Child process per account (node bin/make-account.js 1 --no-verify) with
// NODE_USE_ENV_PROXY=1 + HTTPS_PROXY — per-worker egress that Node's env
// proxy can only do process-wide. Creation ~30s/worker/account; verification
// and stocking run once at the end for the whole batch.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/util/util.js';
import { openAccountsDb, ensureCapcutColumns, ensureCreditGrants, provisionCapcutAccounts, capcutStats } from '../src/infra/db.js';
import { ensureEmailPool, poolClaim, poolAdd, poolFreshCount } from '../src/infra/email-pool.js';
import { ensureProxyPool, takeProxy, poolStats } from '../src/infra/proxy-pool.js';
import { OkotpClient } from '../src/infra/okotp.js';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
loadEnv();
const cfg = await import('../config.js');
const settings = {};
for (const k of Object.keys(cfg)) if (/^[A-Z][A-Z0-9_]*$/.test(k)) settings[k] = cfg[k];

const argv = process.argv.slice(2);
const TOTAL = Number(argv.find((a) => /^\d+$/.test(a)) || 0);
const tIdx = argv.indexOf('-t');
const WORKERS = tIdx !== -1 ? Math.max(1, Number(argv[tIdx + 1]) || 3) : 3;
if (!TOTAL) { console.error('usage: node bin/batch.js <total> [-t workers]'); process.exit(2); }

const db = openAccountsDb('');
ensureCapcutColumns(db);
ensureCreditGrants(db);
ensureEmailPool(db);
ensureProxyPool(db, fs.readFileSync(path.join(PKG_ROOT, 'data', 'proxies.txt'), 'utf8').split('\n'));
const okotp = new OkotpClient(settings.OTP_API_KEY || process.env.OTP_API_KEY, { baseUrl: settings.OTP_BASE || 'https://api.okotp.com', log: () => {} });

const startPending = capcutStats(db).registered + capcutStats(db).pending;
const target = startPending + TOTAL;
// Provision THIS batch's rows up front (placeholder emails; the rented gmail
// replaces each at claim time).
// Restart-safe: earlier batch runs may have left queued rows — only top up
// to what this run still needs (accumulated 921 spare rows at one point).
const queueHave = capcutStats(db).unregistered;
const prov = provisionCapcutAccounts(db, Math.max(0, TOTAL - queueHave), { emailDomain: settings.EMAIL_DOMAIN || 'pending.invalid' });
log(`provisioned ${prov.added} rows (queue: ${capcutStats(db).unregistered}, reused ${Math.min(queueHave, TOTAL)})`);
log(`batch: create ${TOTAL} accounts (${WORKERS} workers) — target fleet size ${target}`);

// ---- balance-guarded prewarmer: keep ~2×workers fresh rentals in the pool
let stopRentals = false;
const readBalance = async () => {
  const b = await okotp.balance();
  return Number(b?.data?.balance ?? b?.data ?? b?.balance ?? b);
};
// Never throws; null = unknown (429/network) — a confirmed <1 is the ONLY
// thing that stops rentals (an unhandled 429 crashed the whole batch,
// 02:53 — okotp rate-limits aggressive polling).
const readBalanceSafe = async () => {
  try { return await readBalance(); } catch { return null; }
};
const prewarmLoop = (async () => {
  while (!stopRentals) {
    try {
      const balance = await readBalanceSafe();
      if (balance != null && !(balance >= 1)) {
        if (!stopRentals) log(`[prewarm] okotp balance ${balance} < 1 — no more rentals`);
        stopRentals = true;
        break;
      }
      const fresh = poolFreshCount(db);
      if (fresh < WORKERS * 2) {
        const order = await okotp.createOrder({ serviceId: settings.OTP_SERVICE_ID, emailTypeId: settings.OTP_EMAIL_TYPE_ID });
        const email = order?.email || order?.data?.email;
        if (email) { poolAdd(db, email, order); log(`[prewarm] + ${email} (pool ${poolFreshCount(db)})`); }
      }
    } catch (e) {
      const s = String(e.message);
      log(`[prewarm] rental hiccup: ${s.slice(0, 60)}`);
      if (/too many|429/i.test(s)) await new Promise((r) => setTimeout(r, 30000)); // okotp 429: breathe
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
})();

// ---- creation workers: child per account with its own proxy egress
const child = (proxyUrl) => new Promise((resolve) => {
  // NO_PROXY: the okotp rental goes DIRECT — it must not depend on the
  // assigned exit being able to reach api.okotp.com (two instant child
  // deaths in the first batch attempt traced to exactly that).
  const env = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: 'api.okotp.com' };
  const p = spawn(process.execPath, ['bin/make-account.js', '1', '--no-verify'], { cwd: PKG_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => resolve({ code, out }));
});

const fleetSize = () => {
  const s = capcutStats(db);
  return s.registered + s.pending;
};

let created = 0;
let stopAll = false;
const workerLoop = async (wid) => {
  while (!stopAll) {
    if (fleetSize() >= target) break;
    const s = capcutStats(db);
    if (s.unregistered === 0) { log(`[w${wid}] queue empty`); break; }
    if (stopRentals && poolFreshCount(db) === 0) { log(`[w${wid}] rentals stopped + pool dry`); break; }

    const proxyUrl = await takeProxy(db, { log: (m) => log(`[w${wid}] ${m}`) });
    if (!proxyUrl) { log(`[w${wid}] no proxy source available — pausing 30s`); await new Promise((r) => setTimeout(r, 30000)); continue; }

    const before = fleetSize();
    const t0 = Date.now();
    const { code, out } = await child(proxyUrl);
    const grew = fleetSize() - before;
    if (grew > 0) {
      created += grew;
      const email = (out.match(/([\w.]+@gmail\.com)/) || [])[1] || '?';
      log(`[w${wid}] ✓ ${email} via ${proxyUrl.split('@').pop()} (${Math.round((Date.now() - t0) / 1000)}s) — ${created}/${TOTAL}`);
    } else {
      const tail = out.trim().split('\n').slice(-3).join(' ⏎ ').slice(0, 220);
      log(`[w${wid}] ✖ attempt failed via ${proxyUrl.split('@').pop()}: ${tail || `exit ${code}`}`);
      await new Promise((r) => setTimeout(r, 5000)); // brief cooldown before reclaiming the row
    }
  }
};
// Fill the pool before any worker starts — at t=0 the pool is empty and
// children would rent THROUGH their assigned proxy (fine only when that
// proxy can reach api.okotp.com; several could not, first batch attempt).
log('[prewarm] initial pool fill ...');
for (let i = 0; i < WORKERS * 2 && !stopRentals; i++) {
  if (poolFreshCount(db) >= WORKERS * 2) break;
  try {
    const order = await okotp.createOrder({ serviceId: settings.OTP_SERVICE_ID, emailTypeId: settings.OTP_EMAIL_TYPE_ID });
    const email = order?.email || order?.data?.email;
    if (email) poolAdd(db, email, order);
    await new Promise((r) => setTimeout(r, 1500));
  } catch (e) {
    log(`[prewarm] initial rental failed: ${String(e.message).slice(0, 60)}`);
    if (/too many|429/i.test(String(e.message))) await new Promise((r) => setTimeout(r, 30000));
  }
}
log(`[prewarm] pool: ${poolFreshCount(db)} fresh, balance ${await readBalanceSafe()}`);
// Verifier lane: while creation runs, repeatedly complete pending rows
// (signed browser read -> registered) and ship whatever is fresh to the shop.
// Exits when creation is done AND no pending rows remain.
const spawnPhase = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { cwd: PKG_ROOT, stdio: 'inherit' });
  p.on('exit', resolve);
});
const verifyLoop = (async () => {
  let idle = 0;
  // Ship to the shop in batches of 10 newly-verified accounts (user spec):
  // DB rows flip to registered per-account during verify; the ssh sync +
  // export regeneration fire every 10, plus one final flush.
  let lastStocked = capcutStats(db).registered;
  while (true) {
    const s = capcutStats(db);
    const creating = s.unregistered > 0 && !(stopRentals && poolFreshCount(db) === 0) && fleetSize() < target;
    if (s.pending > 0) {
      await spawnPhase(['bin/make-account.js', '0']);       // completes pending rows (DB updates per account)
      idle = 0;
    } else if (!creating) {
      if (++idle > 2) break;                                 // done: nothing pending, nothing creating
    } else {
      idle = 0;
    }
    if (capcutStats(db).registered - lastStocked >= 10) {
      log(`[stock] ${capcutStats(db).registered - lastStocked} newly verified — syncing shop ...`);
      await spawnPhase(['bin/stock.js']);
      lastStocked = capcutStats(db).registered;
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  await spawnPhase(['bin/stock.js']);                        // final flush
})();
const workersDone = Promise.all(Array.from({ length: WORKERS }, (_, i) => workerLoop(i + 1)));
await Promise.all([workersDone, verifyLoop]);
stopRentals = true;
await Promise.race([prewarmLoop, new Promise((r) => setTimeout(r, 5000))]);

const s1 = capcutStats(db);
log(`creation phase done: created ${created}/${TOTAL} (fleet ${fleetSize()}) — ${JSON.stringify(s1)}`);
log('proxy usage: ' + poolStats(db).slice(0, 5).map((p) => `${p.id.slice(0, 18)}…×${p.uses}`).join(', ') + (poolStats(db).length > 5 ? ' …' : ''));

// ---- verify phase: complete pending rows with the signed browser read
if (s1.pending > 0) {
  log(`verification phase: ${s1.pending} pending rows — running make-account verify-only ...`);
  await new Promise((resolve) => {
    const p = spawn(process.execPath, ['bin/make-account.js', '0'], { cwd: PKG_ROOT, stdio: 'inherit' });
    p.on('exit', resolve);
  });
}

// ---- stock phase: batch-sync verified accounts to the shop server
log('stock phase: syncing completed accounts ...');
await new Promise((resolve) => {
  const p = spawn(process.execPath, ['bin/stock.js'], { cwd: PKG_ROOT, stdio: 'inherit' });
  p.on('exit', resolve);
});

const s2 = capcutStats(db);
log(`BATCH COMPLETE — ${JSON.stringify(s2)}`);
db.close();
process.exit(0);
