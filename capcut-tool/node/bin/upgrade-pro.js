#!/usr/bin/env node
// upgrade-pro CLI — Node port of len_pro.py (step 2 final wiring, DB-driven).
//
//     node bin/upgrade-pro.js                     # PREVIEW only (default)
//     node bin/upgrade-pro.js --chay              # actually run
//     node bin/upgrade-pro.js --chay -t 3         # 3 workers = 3 codes awaiting a scan
//     node bin/upgrade-pro.js --chay --max 10     # only the first 10 targets
//     node bin/upgrade-pro.js --chay --username uabc123def0   # one account
//     node bin/upgrade-pro.js --chay --file my-accounts.txt   # export override
//
// Logs back into registered FREE capcut.com accounts (plan column not 'pro')
// and claims the 7-day Pro trial on each. Targets come from accounts.db
// (listCapcutUpgradeTargets); success writes capcut='pro' via
// updateCapcutCredits AND rewrites the email-keyed line in ACCOUNTS_FILE
// when that export file exists.
//
// EVERY ACCOUNT NEEDS ONE SCAN (QR wallets): open the scan board BEFORE
// running; the worker count is how many codes wait for a scan at once.
//
// Ctrl+C to stop: workers close their browsers first, then the process exits.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, parseCli, ts } from '../src/util/util.js';
import {
  openAccountsDb, ensureCapcutColumns, capcutStats, listCapcutUpgradeTargets,
} from '../src/infra/db.js';
import {
  FULL_CREDIT_TARGET, filterUpgradeTargets, sortUpgradeTargets, runUpgradeBulk,
} from '../src/core/upgrade-pro.js';
import { walletList } from '../src/core/capcut-zalopay.js';

// node/ package root (config file values are relative to it).
const NODE_ROOT = path.dirname(fileURLToPath(new URL('../', import.meta.url)));

const USAGE = `Usage: node bin/upgrade-pro.js [flags]

Log back into registered FREE accounts and claim the 7-day Pro trial.

  --chay                 actually run (default is a PREVIEW only)
  -t, --threads <n>      how many workers run in parallel (default 2)
  --username <name>      single-account mode: one named registered row
                         (credit filter ignored)
  --min-credits <n>      only take accounts at/above this credit
                         (default ${FULL_CREDIT_TARGET} = all 11 tasks done;
                         0 = take everything)
  --max <n>              only upgrade the first <n> targets
  --file <path>          export file whose credit/plan columns get rewritten
                         (default ACCOUNTS_FILE from config; lines are
                         email|password|credits|plan)
  --wait <seconds>       per-account scan wait (default ZALOQR_WAIT, 900)
  --keep-netlog          keep the netlog even after a successful claim
                         (default: delete it, ~5MB/account)
  --help                 show this help

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
// object (port of python main()'s SimpleNamespace(**vars(config))).
// DO_CLAIM_PRO is FORCED on and DO_TASKS off — this pass only upgrades
// (tasks have their own tool, redo-tasks; python set both the same way).
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
  s.DO_CLAIM_PRO = true;  // python: s.DO_CLAIM_PRO = True
  s.DO_TASKS = false;     // python: s.DO_TASKS = False
  if (flags.threads !== undefined) s.THREAD_COUNT = flags.threads;
  if (flags.wait !== undefined && flags.wait !== '') s.ZALOQR_WAIT = flags.wait; // python --cho
  return s;
}

// Resolve a config/flag file value against node/ (python resolved --file
// against its own script dir). Absolute paths pass through untouched.
function resolveDataFile(name) {
  return path.isAbsolute(name) ? name : path.join(NODE_ROOT, name);
}

// CLI entry: flags -> settings -> DB targets -> preview -> (with --chay)
// worker pool -> summary. Exits 2 on bad flags/config, 0 otherwise (python
// returned 0 even when some accounts missed — failures are logged, the rows
// stay registered/free for a later re-run).
async function main() {
  const flags = parseCli({
    options: {
      chay: { type: 'boolean', default: false },
      threads: { type: 'string', short: 't' },
      username: { type: 'string' },
      'min-credits': { type: 'string' },
      max: { type: 'string' },
      file: { type: 'string' },
      wait: { type: 'string' },
      'keep-netlog': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    usage: 'node bin/upgrade-pro.js [--chay] [-t <threads>] [--username <name>] [flags]',
  });
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (flags.threads !== undefined) flags.threads = reqInt(flags.threads, '-t/--threads');
  if (flags['min-credits'] !== undefined) flags['min-credits'] = reqInt(flags['min-credits'], '--min-credits');
  if (flags.max !== undefined && flags.max !== '') flags.max = reqInt(flags.max, '--max');
  if (flags.wait !== undefined && flags.wait !== '') flags.wait = reqInt(flags.wait, '--wait');

  const s = await collectSettings(flags);

  // Credit threshold: CLI flag wins, else the 2060 full-task target (python
  // --nguong default DU_NHIEM_VU).
  const threshold = flags['min-credits'] !== undefined ? flags['min-credits'] : FULL_CREDIT_TARGET;

  // ---- targets from the DB (python doc_nick + plan/credit filters) ----
  const db = openAccountsDb(s.ACCOUNTS_DB || '');
  ensureCapcutColumns(db);
  const stats = capcutStats(db);
  log(`[db] capcut.com queue: ${stats.unregistered} unregistered / ${stats.inFlight} in-flight`
    + ` / ${stats.registered} registered / ${stats.poisoned} poisoned (${stats.total} total)`);

  let targets;
  let freeCount = 0;
  if (flags.username) {
    // Single named row regardless of plan/credit (python --email picked one
    // nick out of the file, keeping the user's order — one row, same thing).
    targets = listCapcutUpgradeTargets(db, { username: flags.username });
    if (!targets.length) {
      log(`[!] No REGISTERED capcut.com row with username '${flags.username}' in the DB.`);
      db.close();
      return 2;
    }
  } else {
    const all = listCapcutUpgradeTargets(db, {});
    freeCount = all.length;
    targets = filterUpgradeTargets(all, threshold);
    // Newest first (python sorted bottom-of-file-up: newest nicks get far
    // better offers). A hand-picked --username keeps user order, like python.
    targets = sortUpgradeTargets(targets);
  }
  if (flags.max) targets = targets.slice(0, flags.max);

  if (!targets.length) {
    log(`No free account has >= ${threshold} credits`
      + (flags.username ? '' : ` (${freeCount} free account(s) below the task threshold)`)
      + '. Add --min-credits 0 to run them anyway.');
    db.close();
    return 0;
  }

  // ---- preview (python parity: counts, first 12 lines, remainder count) ----
  const cred = (t) => (Number.isInteger(t.capcut_credits) ? t.capcut_credits : 0);
  log(`${flags.username ? targets.length : `${stats.registered} registered | ${freeCount} not Pro | ${targets.length}`}`
    + ` eligible (credit >= ${threshold}) -> will run:`);
  for (const t of targets.slice(0, 12)) {
    log(`    ${String(t.email).padEnd(42)} ${String(cred(t)).padStart(5)} ${t.capcut || 'free'}`);
  }
  if (targets.length > 12) {
    log(`    ... and ${targets.length - 12} more`);
  }

  if (!flags.chay) {
    log('This is a PREVIEW only. Add --chay to actually run.');
    db.close();
    return 0;
  }

  // ---- execute ----
  const concurrency = Math.max(1, Math.trunc(Number(flags.threads ?? 2)) || 1);
  const proxies = Array.isArray(s.PROXY_LIST) ? [...s.PROXY_LIST] : [];
  // CAPCUT_DIRECT=1 — force the machine IP (zingproxy gateways kill new
  // cross-origin CONNECT tunnels after the page burst; see bin/signup.js note).
  if (process.env.CAPCUT_DIRECT === '1') proxies.length = 0;
  if (!proxies.length) {
    log('[!] No proxies — every account shares the machine IP (easily blocked).');
  }

  // Wallet/scan briefing (python main()'s banner). walletList maps any
  // CLAIM_METHOD to its wallet labels; 'card' is not a wallet — show the
  // card stock instead and skip the scan-board reminder.
  const method = String(s.CLAIM_METHOD || 'zalopay').toLowerCase();
  if (method === 'card') {
    const cards = Array.isArray(s.PRO_CARDS) ? s.PRO_CARDS.length : 0;
    log(`Payment: card | card stock: ${cards || (s.PRO_CARD ? 1 : 0)} card(s) from the config`);
  } else {
    const wallets = walletList(method).map((w) => w.label).join(' or ');
    const minutes = Math.max(1, Math.floor((Math.trunc(Number(s.ZALOQR_WAIT) || 900)) / 60));
    log(`Wallets: ${wallets} | queue: ${s.ZALOQR_HOST || '(default)'}`);
    log(`Each account waits up to ${minutes} minutes for a scan; ${concurrency} worker(s)`
      + ` = ${concurrency} code(s) waiting at once. Open the scan board BEFORE running.`);
  }

  // Export-file rewrite target: --file wins, else ACCOUNTS_FILE from config;
  // when the file does not exist the DB stays the only record (python's
  // ghi_ket_qua silently returned False for a missing file too).
  const accountsFile = flags.file
    ? resolveDataFile(flags.file)
    : (s.ACCOUNTS_FILE ? resolveDataFile(s.ACCOUNTS_FILE) : null);
  if (accountsFile && fs.existsSync(accountsFile)) {
    log(`[i] Export file (lines rewritten in place): ${accountsFile}`);
  } else {
    log(`[i] No export file at ${accountsFile || '(ACCOUNTS_FILE not set)'} — the DB is the only record.`);
  }

  const results = await runUpgradeBulk(s, {
    targets,
    db,
    concurrency,
    proxyList: proxies,
    accountsFile: accountsFile && fs.existsSync(accountsFile) ? accountsFile : null,
    keepNetlog: Boolean(flags['keep-netlog']),
    log,
    shouldStop,
  });

  db.close();
  // Summary (python parity): how many went Pro, one line each.
  const wentPro = results.filter((r) => r.pro);
  log('='.repeat(60));
  log(`Went Pro: ${wentPro.length}/${targets.length} account(s).`);
  for (const r of wentPro) {
    log(`    ${String(r.email).padEnd(42)} ${r.credits}`);
  }
  return 0;
}

// Stop flag for the whole CLI: set by SIGINT, polled by the pool through the
// shouldStop seam. Module-scoped so the handler and main() share it.
let stopping = false;

// The stop check handed to runUpgradeBulk (python: threading.Event.is_set).
function shouldStop() {
  return stopping;
}

// Run only when executed directly (node bin/upgrade-pro.js ...); importing
// this module must stay side-effect free. loadEnv() runs FIRST so the
// repo-root .env is present before anything else happens.
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
