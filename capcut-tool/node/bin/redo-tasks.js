#!/usr/bin/env node
// redo-tasks CLI — Node port of lam_lai_nhiem_vu.py (step 3, DB-driven).
//
//     node bin/redo-tasks.js                     # PREVIEW only (default)
//     node bin/redo-tasks.js --chay              # actually run
//     node bin/redo-tasks.js --chay -t 3         # 3 workers
//     node bin/redo-tasks.js --chay --max 20     # only the first 20 targets
//     node bin/redo-tasks.js --chay --username uabc123def0   # one account
//
// Re-logs into registered accounts whose credit is below the full-task
// target (2060) and finishes their tasks. Targets come from accounts.db
// (listCapcutRedoTargets); the fresh count goes back via
// updateCapcutCredits AND rewrites the email-keyed line in ACCOUNTS_FILE
// when that export file exists.
//
// Ctrl+C to stop: workers close their browsers first, then the process exits.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, parseCli, ts } from '../src/util/util.js';
import {
  openAccountsDb, ensureCapcutColumns, capcutStats, listCapcutRedoTargets,
} from '../src/infra/db.js';
import {
  FULL_CREDIT_TARGET, runRedoBulk, sortRedoTargets,
} from '../src/core/redo-tasks.js';

// node/ package root (config file values are relative to it).
const NODE_ROOT = path.dirname(fileURLToPath(new URL('../', import.meta.url)));

const USAGE = `Usage: node bin/redo-tasks.js [flags]

Re-run credit tasks for registered accounts below the full-credit target.

  --chay                actually run (default is a PREVIEW only)
  -t, --threads <n>     how many workers run in parallel (default 2)
  --username <name>     single-account mode: one named registered row
                        (credit filter ignored)
  --max-credits <n>     redo accounts at/below this credit
                        (default ${FULL_CREDIT_TARGET} = all 11 tasks done)
  --max <n>             only redo the first <n> targets
  --file <path>         export file whose credit column gets rewritten
                        (default ACCOUNTS_FILE from config; lines are
                        email|password|credits|plan)
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
// object (port of python main()'s SimpleNamespace(**vars(config))). DO_CLAIM_PRO
// is FORCED off — this pass only does tasks and never touches payment.
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
  s.DO_CLAIM_PRO = false; // tasks only, no payment (python parity)
  if (flags.threads !== undefined) s.THREAD_COUNT = flags.threads;
  return s;
}

// Resolve a config/flag file value against node/ (python resolved --file
// against its own script dir). Absolute paths pass through untouched.
function resolveDataFile(name) {
  return path.isAbsolute(name) ? name : path.join(NODE_ROOT, name);
}

// CLI entry: flags -> settings -> DB targets -> preview -> (with --chay)
// worker pool -> summary. Exits 2 on bad flags/config, 0 otherwise (python
// returned 0 even when some accounts failed — failures are logged, the rows
// stay 'registered' for a later re-run).
async function main() {
  const flags = parseCli({
    options: {
      chay: { type: 'boolean', default: false },
      threads: { type: 'string', short: 't' },
      username: { type: 'string' },
      'max-credits': { type: 'string' },
      max: { type: 'string' },
      file: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    usage: 'node bin/redo-tasks.js [--chay] [-t <threads>] [--username <name>] [flags]',
  });
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (flags.threads !== undefined) flags.threads = reqInt(flags.threads, '-t/--threads');
  if (flags['max-credits'] !== undefined) flags['max-credits'] = reqInt(flags['max-credits'], '--max-credits');
  if (flags.max !== undefined && flags.max !== '') flags.max = reqInt(flags.max, '--max');

  const s = await collectSettings(flags);

  // Credit threshold: CLI flag wins, else the 2060 full-credit target
  // (python --nguong default DU_NHIEM_VU).
  const threshold = flags['max-credits'] !== undefined ? flags['max-credits'] : FULL_CREDIT_TARGET;

  // ---- targets from the DB (python doc_nick + credit filter) ----
  const db = openAccountsDb(s.ACCOUNTS_DB || '');
  ensureCapcutColumns(db);
  const stats = capcutStats(db);
  log(`[db] capcut.com queue: ${stats.unregistered} unregistered / ${stats.inFlight} in-flight`
    + ` / ${stats.registered} registered / ${stats.poisoned} poisoned (${stats.total} total)`);

  let targets;
  if (flags.username) {
    targets = listCapcutRedoTargets(db, { username: flags.username });
    if (!targets.length) {
      log(`[!] No REGISTERED capcut.com row with username '${flags.username}' in the DB.`);
      db.close();
      return 2;
    }
  } else {
    targets = listCapcutRedoTargets(db, { maxCredits: threshold });
    // The landed helper pre-filters at/below (<=); python's own filter was
    // STRICTLY below (`credit < nguong`) — an account already at the target
    // has nothing left to claim, so drop it here for exact parity.
    targets = targets.filter((t) => !Number.isInteger(t.capcut_credits) || t.capcut_credits < threshold);
  }

  // 0-credit accounts last, higher credit first (python sort rationale: a
  // 0-credit account is usually blocked from the start — try the safer
  // 520/1540 ones first).
  targets = sortRedoTargets(targets);
  if (flags.max) targets = targets.slice(0, flags.max);

  if (!targets.length) {
    log(`No accounts below ${threshold} credits.`);
    db.close();
    return 0;
  }

  // ---- preview (python parity: first 12 lines, then the remainder count) —-
  const cred = (t) => (Number.isInteger(t.capcut_credits) ? t.capcut_credits : 0);
  const missingTotal = targets.reduce((sum, t) => sum + (threshold - cred(t)), 0);
  log(`${targets.length} account(s) below ${threshold} credits (${missingTotal} credits missing in total):`);
  for (const t of targets.slice(0, 12)) {
    log(`    ${String(t.email).padEnd(42)} ${String(cred(t)).padStart(5)}`);
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

  // Export-file rewrite target: --file wins, else ACCOUNTS_FILE from config;
  // when the file does not exist the DB stays the only record (python
  // ghi_credit silently returned False for a missing file too).
  const accountsFile = flags.file
    ? resolveDataFile(flags.file)
    : (s.ACCOUNTS_FILE ? resolveDataFile(s.ACCOUNTS_FILE) : null);
  if (accountsFile && fs.existsSync(accountsFile)) {
    log(`[i] Credit export file (lines rewritten in place): ${accountsFile}`);
  } else {
    log(`[i] No export file at ${accountsFile || '(ACCOUNTS_FILE not set)'} — the DB is the only record.`);
  }

  const results = await runRedoBulk(s, {
    targets,
    db,
    concurrency,
    proxyList: proxies,
    accountsFile: accountsFile && fs.existsSync(accountsFile) ? accountsFile : null,
    log,
    shouldStop,
  });

  db.close();
  log('='.repeat(60));
  log(`Redo finished: ${results.length}/${targets.length} account(s) got new credit.`);
  return 0;
}

// Stop flag for the whole CLI: set by SIGINT, polled by the pool through the
// shouldStop seam. Module-scoped so the handler and main() share it.
let stopping = false;

// The stop check handed to runRedoBulk (python: threading.Event.is_set).
function shouldStop() {
  return stopping;
}

// Run only when executed directly (node bin/redo-tasks.js ...); importing
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
