#!/usr/bin/env node
// signup CLI — Node port of capcut_signup.py (DB-queue driven).
//
//     node bin/signup.js                    # per config.js (ACCOUNT_COUNT/THREAD_COUNT)
//     node bin/signup.js -n 10 -t 3         # 10 accounts, 3 workers
//     node bin/signup.js --one uabc123def0  # exactly one named unregistered row, no pool
//     node bin/signup.js --netlog netdir    # bulk: netlog DIRECTORY (net-<n>.jsonl each)
//     node bin/signup.js --one u1 --netlog net.jsonl   # one: netlog FILE
//     node bin/signup.js --keep-profile     # keep the browser profile after each account
//
// Ctrl+C to stop: workers close their browsers first, then the process exits.
// GPMLogin is gone — there is no GPM ping anymore; the preflight checks the
// mail config and prints the DB queue stats instead.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, parseCli, ts } from '../src/util/util.js';
import { StopRequested } from '../src/browser/browser.js';
import { runBulk, signupOne, validate } from '../src/core/capcut-engine.js';
import {
  openAccountsDb, ensureCapcutColumns, capcutStats, markCapcutRegistered, releaseCapcut,
} from '../src/infra/db.js';

// node/ package root (config file values are relative to it).
const NODE_ROOT = path.dirname(fileURLToPath(new URL('../', import.meta.url)));

const USAGE = `Usage: node bin/signup.js [flags]

Bulk-create CapCut accounts from the accounts.db queue.

  -n, --count <n>       how many accounts to create this run (ACCOUNT_COUNT)
  --total <n>           TOTAL accounts wanted (overrides count, python TONG_TAI_KHOAN)
  --no-claim            do not claim Pro, free accounts only
  -t, --threads <n>     how many workers run in parallel (THREAD_COUNT)
  --one <username>      run exactly ONE named unregistered row (no worker pool)
  --netlog <file|dir>   record network requests: --one = FILE, bulk = DIRECTORY
  --keep-profile        keep the browser profile after each account
  --no-rotate           disable proxy IP rotation even when config enables it
  --no-tasks            do not auto-complete credit tasks after signup
  --help                show this help

Ctrl+C stops the run: workers close their browsers first, then exit.
`;

// Timestamped console line, same shape as the python CLI's log().
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// Parse an int CLI value; exits 2 with a message when malformed (python
// argparse type=int parity).
function reqInt(value, flag) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n)) {
    console.error(`${flag} must be an integer, got: ${value}`);
    process.exit(2);
  }
  return n;
}

// Merge config.js UPPER_SNAKE exports with the CLI flags into one settings
// object (port of python collect_settings — same precedence: flags win).
async function collectSettings(flags) {
  let cfg;
  try {
    cfg = await import('../config.js');
  } catch {
    console.error('config.js not found — copy config.example.js to node/config.js first.');
    process.exit(2);
  }
  const s = {};
  for (const k of Object.keys(cfg)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(k)) s[k] = cfg[k];
  }
  if (flags.count !== undefined) s.ACCOUNT_COUNT = flags.count;
  if (flags.threads !== undefined) s.THREAD_COUNT = flags.threads;
  if (flags.total) s.TONG_TAI_KHOAN = flags.total;
  if (flags['no-claim']) s.DO_CLAIM_PRO = false;
  if (flags['keep-profile']) s.DELETE_PROFILE_AFTER = false;
  if (flags['no-rotate']) s.ROTATE_PROXY = false;
  if (flags['no-tasks']) s.DO_TASKS = false;
  return s;
}

// CLI entry: flags -> settings -> validate -> preflight -> one-account or bulk
// run. Exits 2 on bad flags/config (argparse parity), 1 on a failed run, 0 ok.
async function main() {
  const flags = parseCli({
    options: {
      count: { type: 'string', short: 'n' },
      total: { type: 'string' },
      'no-claim': { type: 'boolean', default: false },
      threads: { type: 'string', short: 't' },
      one: { type: 'string' },
      netlog: { type: 'string' },
      'keep-profile': { type: 'boolean', default: false },
      'no-rotate': { type: 'boolean', default: false },
      'no-tasks': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    usage: 'node bin/signup.js [-n <count>] [-t <threads>] [--one <username>] [flags]',
  });
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (flags.count !== undefined) flags.count = reqInt(flags.count, '-n/--count');
  if (flags.threads !== undefined) flags.threads = reqInt(flags.threads, '-t/--threads');
  if (flags.total !== undefined && flags.total !== '') flags.total = reqInt(flags.total, '--total');

  const s = await collectSettings(flags);

  const errs = validate(s);
  if (errs.length) {
    log('[!] Configuration invalid:');
    for (const e of errs) log(`    • ${e}`);
    return 2;
  }

  const proxies = Array.isArray(s.PROXY_LIST) ? [...s.PROXY_LIST] : [];
  // CAPCUT_DIRECT=1 — force the machine IP for this run (validation, or when
  // the proxy gateway refuses new CONNECT tunnels: measured 2026-09-01, the
  // static zingproxy pool kills fresh cross-origin tunnels seconds after the
  // page's connection burst — same-origin keeps working, cross-origin dies).
  if (process.env.CAPCUT_DIRECT === '1') proxies.length = 0;
  // CAPCUT_FAST=1 — single-account speed mode (~3 min cycle):
  // skip the always-failing post-steps (~20s), snappier task delays, and cap
  // the ripening wait at 45s after the task list appears (~110s saved — the
  // credit>0 gate can't fire before grants anyway).
  if (process.env.CAPCUT_FAST === '1') {
    s.CAPCUT_FAST = true;
    s.API_DO_POST_STEPS = false;
    s.TASK_DELAY_MIN = 0.4;
    s.TASK_DELAY_MAX = 0.8;
    s.TASKS_READY_AFTER_SECONDS = 45;
    log('[i] CAPCUT_FAST: post-steps off, task delays 0.4-0.8s, ripening capped 45s.');
  }
  if (!proxies.length) {
    log('[!] No proxies — every account shares the machine IP (easily blocked).');
  }

  // Preflight (the GPM ping is gone with GPM): DB stats + queue warning, so a
  // run never starts spending time on an empty queue.
  const db = openAccountsDb(s.ACCOUNTS_DB || '');
  ensureCapcutColumns(db);
  const stats = capcutStats(db);
  log(`[db] capcut.com queue: ${stats.unregistered} unregistered / ${stats.inFlight} in-flight`
    + ` / ${stats.registered} registered / ${stats.poisoned} poisoned (${stats.total} total)`);
  if (!stats.unregistered && !flags.one) {
    log('[!] Queue is EMPTY — run `node bin/provision.js <N>` first.');
  }

  // ---- single-account mode: one named unregistered row, no worker pool ----
  if (flags.one) {
    const row = db.prepare("SELECT * FROM accounts WHERE site='capcut.com' AND username=?")
      .get(flags.one);
    if (!row) {
      log(`[!] No capcut.com row with username '${flags.one}' in the queue.`);
      db.close();
      return 2;
    }
    if (row.status !== 'unregistered') {
      log(`[!] Row '${flags.one}' has status '${row.status}' — only 'unregistered' rows can run.`);
      db.close();
      return 2;
    }
    // Claim it (same status flip the pool claim does) so a parallel run can
    // never pick the same row.
    db.prepare("UPDATE accounts SET status='in-flight' WHERE site='capcut.com' AND username=? AND status='unregistered'")
      .run(flags.one);
    const proxy = proxies[0] ?? null;
    const s1 = { ...s, RAW_PROXY: proxy };

    log('='.repeat(64));
    log(' CapCut: single-account run');
    log(` Account: ${row.email} | proxy: ${proxy || 'none'}`);
    log('='.repeat(64));
    let acc = null;
    try {
      acc = await signupOne(s1, { account: row, log, shouldStop, netlogPath: flags.netlog || null });
    } catch (e) {
      if (e instanceof StopRequested) log('[!] Stopped.');
      else log(`[!] Error: ${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`);
    }
    try {
      if (acc) {
        markCapcutRegistered(db, flags.one, {
          credits: Number.isInteger(acc.credits) ? acc.credits : null,
          plan: acc.pro ? 'pro' : 'free',
        });
      } else {
        releaseCapcut(db, flags.one); // transient failure -> back on the queue
      }
    } catch (e) {
      log(`[!] DB mark error: ${e && e.message ? e.message : e}`);
    }
    db.close();
    if (acc) {
      const plan = acc.pro ? 'Pro' : 'free';
      log(`✔ Done — ${acc.email}|${acc.password}|${acc.credits ?? 0}|${plan}`);
      return 0;
    }
    log('✖ Failed — see the log above for the failing step.');
    return 1;
  }

  // ---- bulk mode ----
  const total = Math.trunc(Number(s.ACCOUNT_COUNT) || 5);
  const conc = Math.trunc(Number(s.THREAD_COUNT) || 2);
  const netlogDir = flags.netlog || null;
  if (netlogDir) fs.mkdirSync(netlogDir, { recursive: true });

  // runBulk opens its own DB handle (claims + marks live there).
  db.close();

  const results = await runBulk(s, {
    total,
    concurrency: conc,
    proxyList: proxies,
    log,
    shouldStop,
    deleteProfile: s.DELETE_PROFILE_AFTER !== false,
    netlogDir,
  });

  const ok = results.filter(Boolean).length;
  if (ok) {
    const fname = s.ACCOUNTS_FILE || 'capcut_accounts.txt';
    const fpath = path.isAbsolute(fname) ? fname : path.join(NODE_ROOT, fname);
    if (fs.existsSync(fpath)) log(`[i] Accounts saved at: ${fpath}`);
  }
  return ok ? 0 : 1;
}

// Stop flag for the whole CLI: set by SIGINT, polled by the engine through
// the shouldStop seam. Module-scoped so the handler and main() share it.
let stopping = false;

// The stop check handed to signupOne/runBulk (python: threading.Event.is_set).
function shouldStop() {
  return stopping;
}

// Run only when executed directly (node bin/signup.js ...); importing this
// module must stay side-effect free. loadEnv() runs FIRST so MAIL_PASS from
// the repo-root .env is present before anything else happens.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  // First Ctrl+C asks the workers to wind down (they close their browsers,
  // then the process exits); a second Ctrl+C force-exits.
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount += 1;
    if (sigintCount > 1) process.exit(130);
    stopping = true;
    log('[!] Ctrl+C — stopping: workers will close their browsers first ...');
  });
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err && err.stack ? err.stack : String(err));
      process.exit(1);
    },
  );
}
