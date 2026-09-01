// Pre-warmed okotp rental pool.
//
// okotp gmails: one CapCut account each, valid ~2h from rental. Pre-warming
// (user idea, 2026-09-02) rents a batch BEFORE the pipeline runs so account
// creation never waits on rental (and rides out okotp stock/rate hiccups).
// Entries carry the full order JSON (order_item_id + sign are needed to read
// the code later); stale (>2h) entries are skipped on claim and swept.

import { DatabaseSync } from 'node:sqlite';

// TTL: okotp boxes live ~2h — claim only younger entries.
const POOL_TTL_MS = 110 * 60 * 1000; // 110 min, conservative

// Idempotent table creation.
export function ensureEmailPool(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS email_pool (
    email TEXT, order_json TEXT, rented_at INTEGER, used INTEGER DEFAULT 0
  )`);
}

// Store one rented order.
export function poolAdd(db, email, order) {
  db.prepare('INSERT INTO email_pool (email, order_json, rented_at, used) VALUES (?,?,?,0)')
    .run(email, JSON.stringify(order), Date.now());
}

// Oldest fresh unused rental, marked used atomically; null when empty.
// Stale entries encountered along the way are marked used (dead money —
// okotp has no release API) so they never get served.
export function poolClaim(db) {
  const row = db.prepare('SELECT rowid, email, order_json, rented_at FROM email_pool WHERE used=0 ORDER BY rented_at LIMIT 1').get();
  if (!row) return null;
  const fresh = Date.now() - row.rented_at < POOL_TTL_MS;
  db.prepare('UPDATE email_pool SET used=1 WHERE rowid=?').run(row.rowid);
  if (!fresh) return null;
  return { email: row.email, order: JSON.parse(row.order_json) };
}

// How many fresh unused entries remain (for prewarm sizing).
export function poolFreshCount(db) {
  const rows = db.prepare('SELECT rented_at FROM email_pool WHERE used=0').all();
  return rows.filter((r) => Date.now() - r.rented_at < POOL_TTL_MS).length;
}
