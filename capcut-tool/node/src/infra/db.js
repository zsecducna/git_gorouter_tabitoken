// src/infra/db.js — SQLite account-queue layer over the repo-root accounts.db.
// node:sqlite DatabaseSync (needs Node >= 22.5; dev box runs Node 26).
// Import-safe: nothing opens at import time — every entry point takes the db
// handle from openAccountsDb(). Lifecycle per repo convention:
// unregistered -> claim (in-flight) -> registered | poisoned | back to
// unregistered on transient failure (proxy/OTP timeout).
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { randomPassword, randomUsername } from '../util/gen.js';

// Default DB path: the REPO-root accounts.db shared with gen-accounts.mjs.
// This file lives at <repo>/capcut-tool/node/src/infra/db.js, so the repo root
// is FOUR levels up (QA-verified 2026-09-01: three levels resolves to
// capcut-tool/accounts.db — wrong DB).
export const DEFAULT_ACCOUNTS_DB = fileURLToPath(new URL('../../../../accounts.db', import.meta.url));

// Baseline table, identical to gen-accounts.mjs. Runs as CREATE IF NOT EXISTS
// so existing DBs are untouched and fresh (test) DBs get the same shape.
const CREATE_ACCOUNTS = `CREATE TABLE IF NOT EXISTS accounts (
  site TEXT, email TEXT, username TEXT, password TEXT,
  region TEXT, created TEXT, status TEXT,
  gorouter TEXT, gorouter_api_key TEXT,
  tabitoken TEXT, tabitoken_api_key TEXT
)`;

/**
 * Open accounts.db (or an explicit path — tests pass a temp file) with the
 * same conventions as gen-accounts.mjs: WAL journal for safe concurrent
 * readers across processes. Returns the raw DatabaseSync handle; callers
 * pass it to every other function here. Not opened at import time.
 */
export function openAccountsDb(dbPath = '') {
  const db = new DatabaseSync(dbPath || DEFAULT_ACCOUNTS_DB);
  db.exec('PRAGMA journal_mode=WAL');
  return db;
}

/**
 * Idempotent schema setup: create the baseline accounts table if missing and
 * add the per-site capcut pair (capcut holds plan state 'free'/'pro'/
 * 'flagged'/'registered' or a 'poison:<reason>' marker, exactly like the
 * gorouter column convention; capcut_credits holds the credit balance).
 * Safe to call on every startup, old and new DBs alike.
 */
export function ensureCapcutColumns(db) {
  db.exec(CREATE_ACCOUNTS);
  const cols = new Set(db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name));
  if (!cols.has('capcut')) db.exec('ALTER TABLE accounts ADD COLUMN capcut TEXT');
  if (!cols.has('capcut_credits')) db.exec('ALTER TABLE accounts ADD COLUMN capcut_credits INTEGER');
}

/**
 * Provision `n` new capcut.com account rows: username/password from the repo
 * GitHub-account rule (src/util/gen.js), email = username@emailDomain, region
 * 'Vietnam', created ISO, status 'unregistered'. Dupe-checks username OR
 * email before insert and regenerates on collision (same loop shape as
 * gen-accounts.mjs). Returns { added, skipped } — skipped counts collisions
 * encountered along the way.
 */
export function provisionCapcutAccounts(db, n, { emailDomain, log = () => {} } = {}) {
  if (!emailDomain) throw new Error('emailDomain is required (config EMAIL_DOMAIN)');
  const findDupe = db.prepare('SELECT 1 AS one FROM accounts WHERE username=? OR email=?');
  const insert = db.prepare(
    'INSERT INTO accounts (site,email,username,password,region,created,status) VALUES (?,?,?,?,?,?,?)');
  let added = 0;
  let skipped = 0;
  while (added < n) {
    const username = randomUsername();
    if (findDupe.get(username, `${username}@${emailDomain}`)) {
      skipped++;
      continue;
    }
    insert.run('capcut.com', `${username}@${emailDomain}`, username,
      randomPassword(), 'Vietnam', new Date().toISOString(), 'unregistered');
    added++;
  }
  log(`[db] provisioned ${added} capcut.com rows @${emailDomain} (${skipped} dupes skipped)`);
  return { added, skipped };
}

/**
 * Atomically claim the oldest unregistered capcut.com row and flip it to
 * 'in-flight' — one UPDATE ... RETURNING so parallel workers can never claim
 * the same row (single statement = single SQLite write lock; DatabaseSync is
 * synchronous, so no in-process interleave either). Returns the full row or
 * null when the queue is empty. Fallback (ancient SQLite without RETURNING):
 * BEGIN IMMEDIATE / select / update / COMMIT.
 */
export function claimNextCapcut(db) {
  const claimSql = `UPDATE accounts SET status='in-flight'
    WHERE rowid = (SELECT rowid FROM accounts
                   WHERE site='capcut.com' AND status='unregistered'
                   ORDER BY created, rowid LIMIT 1)
    RETURNING *`;
  try {
    return db.prepare(claimSql).get() ?? null;
  } catch (err) {
    if (!/RETURNING/i.test(String(err && err.message ? err.message : err))) throw err;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`SELECT rowid AS _rid, * FROM accounts
        WHERE site='capcut.com' AND status='unregistered'
        ORDER BY created, rowid LIMIT 1`).get();
      if (!row) {
        db.exec('COMMIT');
        return null;
      }
      db.prepare("UPDATE accounts SET status='in-flight' WHERE rowid=?").run(row._rid);
      db.exec('COMMIT');
      delete row._rid;
      return row;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/**
 * Mark a claimed row as fully registered: status 'registered', capcut set to
 * the plan ('free'/'pro'), capcut_credits to the measured balance (null when
 * unknown — distinct from 0, which is a real measured balance).
 */
export function markCapcutRegistered(db, username, { credits = null, plan = 'free' } = {}) {
  db.prepare("UPDATE accounts SET status='registered', capcut=?, capcut_credits=? WHERE site='capcut.com' AND username=?")
    .run(plan, credits, username);
}

/**
 * Mark a claimed row as permanently failed (poisoned): the reason is kept in
 * the capcut column with a 'poison:' prefix, e.g. 'poison:email-taken', so
 * post-mortems need no second table.
 */
export function markCapcutPoisoned(db, username, reason) {
  db.prepare("UPDATE accounts SET status='poisoned', capcut=? WHERE site='capcut.com' AND username=?")
    .run('poison:' + String(reason ?? 'unknown'), username);
}

/**
 * Release a transient failure back to the queue (proxy/OTP timeout — worth
 * retrying later). Only touches rows still 'in-flight' for this username, so
 * a late release after a poison/register can never resurrect a finished row.
 */
export function releaseCapcut(db, username) {
  db.prepare("UPDATE accounts SET status='unregistered' WHERE site='capcut.com' AND username=? AND status='in-flight'")
    .run(username);
}

/**
 * Rewrite one capcut row's email address. Used ONLY by the okotp provider
 * (MAIL_PROVIDER='okotp'): the rented gmail REPLACES the row's pre-provisioned
 * placeholder so accounts.db stays the source of truth for which mailbox each
 * account actually lives at (signup, export files and later logins all read
 * the row, never the placeholder). Scoped to site+username so it can never
 * touch another site's rows.
 */
export function setCapcutEmail(db, username, email) {
  db.prepare("UPDATE accounts SET email=? WHERE site='capcut.com' AND username=?")
    .run(String(email), username);
}

/**
 * Queue snapshot for stats lines: { total, unregistered, inFlight,
 * registered, poisoned } over capcut.com rows only. Unknown statuses still
 * count toward total.
 */
export function capcutStats(db) {
  const stats = { total: 0, unregistered: 0, inFlight: 0, registered: 0, poisoned: 0 };
  for (const { status, c } of db.prepare("SELECT status, COUNT(*) AS c FROM accounts WHERE site='capcut.com' GROUP BY status").all()) {
    stats.total += c;
    if (status === 'unregistered') stats.unregistered = c;
    else if (status === 'in-flight') stats.inFlight = c;
    else if (status === 'registered') stats.registered = c;
    else if (status === 'poisoned') stats.poisoned = c;
  }
  return stats;
}

/**
 * List registered capcut accounts for the redo-tasks pass (step 3), oldest
 * first. Optional filters: `maxCredits` (only rows at/below this credit
 * count — the python tool redid tasks for nicks below the full 2060),
 * `username` (a single named row, ignoring the credit filter).
 */
export function listCapcutRedoTargets(db, { maxCredits = null, username = null } = {}) {
  if (username) {
    return db.prepare(
      "SELECT * FROM accounts WHERE site='capcut.com' AND username=? AND status='registered'"
    ).all(username);
  }
  if (maxCredits === null) {
    return db.prepare(
      "SELECT * FROM accounts WHERE site='capcut.com' AND status='registered' ORDER BY created"
    ).all();
  }
  return db.prepare(
    "SELECT * FROM accounts WHERE site='capcut.com' AND status='registered' " +
      "AND (capcut_credits IS NULL OR capcut_credits <= ?) ORDER BY created"
  ).all(maxCredits);
}

/**
 * Write back a fresh credit count for one registered capcut account (and the
 * plan column alongside — the redo pass may also be what first proves Pro).
 */
export function updateCapcutCredits(db, username, credits, plan = null) {
  if (plan !== null) {
    db.prepare("UPDATE accounts SET capcut_credits=?, capcut=? WHERE site='capcut.com' AND username=?")
      .run(credits, plan, username);
  } else {
    db.prepare("UPDATE accounts SET capcut_credits=? WHERE site='capcut.com' AND username=?")
      .run(credits, username);
  }
}

/**
 * List registered FREE capcut accounts for the Pro-upgrade pass (step 2):
 * plan column missing/'free' (NOT already 'pro'), oldest first. Optional
 * `username` picks one named row regardless of plan.
 */
export function listCapcutUpgradeTargets(db, { username = null } = {}) {
  if (username) {
    return db.prepare(
      "SELECT * FROM accounts WHERE site='capcut.com' AND username=? AND status='registered'"
    ).all(username);
  }
  return db.prepare(
    "SELECT * FROM accounts WHERE site='capcut.com' AND status='registered' " +
      "AND (capcut IS NULL OR capcut='' OR capcut='free' OR capcut NOT LIKE 'pro%') ORDER BY created"
  ).all();
}

/**
 * Daily grant ledger: which (account, task_id) already earned credit TODAY.
 * The server gives no claimed/unclaimed signal (task_status=4 + err_no=0 acks
 * repeat for already-granted rewards — the phantom +160s), so the local
 * ledger is what keeps grant rounds idempotent and totals honest. Rows are
 * day-scoped: daily task credits expire, tomorrow starts a fresh set.
 */
export function ensureCreditGrants(db) {
  db.exec('CREATE TABLE IF NOT EXISTS credit_grants (username TEXT, task_id INTEGER, day TEXT, reward INTEGER)');
}

// Today's already-granted task_ids for one account.
export function grantsToday(db, username, day = new Date().toISOString().slice(0, 10)) {
  return new Set(
    db.prepare('SELECT task_id FROM credit_grants WHERE username=? AND day=?').all(username, day).map((r) => r.task_id)
  );
}

// Record one grant (idempotent).
export function recordGrant(db, username, taskId, reward, day = new Date().toISOString().slice(0, 10)) {
  db.prepare('INSERT INTO credit_grants (username, task_id, day, reward) VALUES (?,?,?,?)')
    .run(username, taskId, day, reward);
}
