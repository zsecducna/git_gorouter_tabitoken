// reconcile.mjs — revert phantom 'registered' rows (no gorouter key + GitHub 404)
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/Users/z/Desktop/gorouter-auto/accounts.db');
const suspects = db.prepare("SELECT username FROM accounts WHERE status='registered' AND gorouter_api_key IS NULL").all();
console.log(`suspects (registered, no gorouter key): ${suspects.length}`);
const reverted = [];
for (const s of suspects) {
  const code = await fetch('https://github.com/' + s.username).then((r) => r.status).catch(() => 0);
  if (code === 404) {
    db.prepare("UPDATE accounts SET status='unregistered', gorouter=NULL, tabitoken=NULL WHERE username=?").run(s.username);
    reverted.push(s.username);
  }
}
console.log(`reverted (${reverted.length}): ${reverted.join(', ')}`);
