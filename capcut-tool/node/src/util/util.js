// src/util/util.js — shared helpers for the CapCut signup tool (Node.js port).
// Zero dependencies beyond node builtins. Everything here is import-safe:
// no top-level side effects, no I/O at import time.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

// Repo-root .env — this file lives at <repo>/capcut-tool/node/src/util/util.js,
// so the repo root is FOUR levels up (QA-verified 2026-09-01: three levels
// resolves to capcut-tool/.env, which does not exist — MAIL_PASS would never load).
const DEFAULT_ENV_PATH = fileURLToPath(new URL('../../../../.env', import.meta.url));

/**
 * Sleep for `ms` milliseconds. Plain promise wrapper — every retry/poll loop
 * in the tool waits through this so timeouts stay cancelable via shouldStop.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Random integer in [a, b] INCLUSIVE. Mirrors Python random.randint(a, b),
 * which the original tool uses for every numeric range (delays, birth years).
 */
export function randInt(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

/**
 * Random float in [a, b). Used for humanized task delays (TASK_DELAY_MIN..MAX).
 */
export function randFloat(a, b) {
  return Math.random() * (b - a) + a;
}

/**
 * Uniform random element of `arr`. Port of Python random.choice — crashes on
 * empty arrays by design (same as Python IndexError) so callers notice bad data.
 */
export function choice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Two-digit zero pad — shared by the timestamp formatters below. */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Current local time as 'HH:MM:SS'. Console log prefix, same shape as the
 * Python tool's per-line timestamps.
 */
export function ts() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Current local time as 'YYYY-MM-DD HH:MM:SS'. Used for result-file records
 * where a full but human-readable timestamp is needed (no timezone suffix —
 * the Python tool logged local wall time too).
 */
export function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Current local date as 'YYYY-MM-DD'. Day-granularity key for task ops /
 * per-day records.
 */
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Promise-chain mutex: `{ run(fn) }` serializes async fns in call order.
 * Replacement for Python `threading.Lock` (contract rule 6). `run` returns
 * fn's own promise (caller sees its result/error); the internal chain swallows
 * errors so one failed critical section never blocks the next waiter.
 */
export function makeMutex() {
  let chain = Promise.resolve();
  const run = (fn) => {
    const result = chain.then(() => fn());
    chain = result.then(() => undefined, () => undefined);
    return result;
  };
  return { run };
}

/**
 * Load KEY=VALUE lines from a .env file into process.env WITHOUT overriding
 * variables that already exist (real environment wins, so CLI/env overrides
 * keep working). Zero-dep dotenv replacement; call once from CLIs. Idempotent:
 * a second call re-reads the file but re-applies nothing that was already set.
 * Handles comments (#), blank lines, CRLF, an optional `export ` prefix, and
 * strips matching surrounding single/double quotes. Returns count applied.
 * Missing file is NOT an error (returns 0) — .env is optional except for
 * MAIL_PASS consumers.
 */
export function loadEnv(filePath = DEFAULT_ENV_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return 0;
  }
  let applied = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith('export ') || key.startsWith('export\t')) {
      key = key.slice('export'.length).trim();
    }
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (!key || key in process.env) continue; // never override existing env
    process.env[key] = value;
    applied++;
  }
  return applied;
}

/**
 * Thin wrapper over node:util parseArgs: positional-friendly and fatal on
 * bad flags. Returns `{ ...parsedValues, _: positionals }`. On a parse error
 * prints the error plus `usage` (if given) to stderr and exits code 2 — same
 * fail-fast UX as the Python argparse CLIs.
 */
export function parseCli({ options = {}, usage = '' } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ options, allowPositionals: true });
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    if (usage) console.error(`\nusage: ${usage}`);
    process.exit(2);
  }
  return { ...parsed.values, _: parsed.positionals };
}

/**
 * Read a utf-8 text file into lines. Trailing-newline-safe (a file ending in
 * \n yields no phantom empty last line); CRLF tolerated. Missing file returns
 * [] — result files legitimately may not exist yet on a fresh run.
 */
export function readLines(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Append one line (utf-8, '\n'-terminated) to a file, creating the parent
 * directory if needed. Result-file writer (ACCOUNTS_FILE/PRO_FILE/FREE_FILE)
 * must never crash on a missing dir on a fresh checkout.
 */
export function appendLine(filePath, line) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line + '\n', 'utf8');
}

/**
 * Subset of `obj` limited to own properties named in `keys`. Used by the
 * engine to build per-account record objects without dragging extra fields.
 */
export function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

/**
 * Clamp `n` into [min, max]. Guards numeric settings (timeouts, delays)
 * against absurd config values.
 */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
