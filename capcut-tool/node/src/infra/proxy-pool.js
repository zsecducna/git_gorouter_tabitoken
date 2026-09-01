// Least-used-first proxy pool (persisted in accounts.db).
//
// Sources: static entries ('ip:port:user:pass' — ready to use, usage counted)
// and kiotproxy KEYS ('kiot:K...') — each take calls the classic API for a
// FRESH IP-authenticated proxy (allocation can be out of stock; the caller
// falls back to the next pool entry). Strategy per user spec: least used
// first, ties broken by oldest last-use.

import { newProxy } from './kiotproxy.js';

// Idempotent table + seed. `entries` = raw lines from data/proxies.txt.
export function ensureProxyPool(db, entries = []) {
  db.exec(`CREATE TABLE IF NOT EXISTS proxy_pool (
    id TEXT PRIMARY KEY, kind TEXT, uses INTEGER DEFAULT 0, last_used INTEGER DEFAULT 0
  )`);
  const ins = db.prepare('INSERT OR IGNORE INTO proxy_pool (id, kind) VALUES (?, ?)');
  for (const raw of entries) {
    const line = String(raw || '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('kiot:')) ins.run(line, 'kiot');
    else ins.run(line, 'static');
  }
}

// Take the least-used entry and resolve it to an env-proxy URL. Kiot entries
// allocate on take (failure = null, caller retries for the next entry).
// Usage is counted on TAKE (resolution), not on child success — simpler and
// still spreads load evenly.
export async function takeProxy(db, { log = () => {} } = {}) {
  const rows = db.prepare('SELECT id, kind FROM proxy_pool ORDER BY uses ASC, last_used ASC').all();
  for (const r of rows) {
    if (r.kind === 'static') {
      const [host, port, user, pass] = r.id.split(':');
      db.prepare('UPDATE proxy_pool SET uses=uses+1, last_used=? WHERE id=?').run(Date.now(), r.id);
      return `http://${user}:${pass}@${host}:${port}`;
    }
    try {
      const proxy = await newProxy(r.id.slice(5)); // strip 'kiot:'
      db.prepare('UPDATE proxy_pool SET uses=uses+1, last_used=? WHERE id=?').run(Date.now(), r.id);
      return `http://${proxy}`;
    } catch (e) {
      log(`[pool] kiot ${r.id.slice(5, 13)}... unavailable: ${String(e.message).slice(0, 60)}`);
    }
  }
  return null;
}

// Snapshot for logs: {total, per-entry uses}.
export function poolStats(db) {
  return db.prepare('SELECT id, kind, uses FROM proxy_pool ORDER BY uses DESC').all();
}
