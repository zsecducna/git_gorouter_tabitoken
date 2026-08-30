// verify-poisoned.mjs — safety: any 'poisoned' row with a live profile goes back to registered
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/Users/z/Desktop/gorouter-auto/accounts.db');
const rows = db.prepare("SELECT username FROM accounts WHERE status='poisoned'").all();
for (const r of rows) {
  const code = await fetch('https://github.com/' + r.username).then((x) => x.status).catch(() => 0);
  if (code === 200) {
    db.prepare("UPDATE accounts SET status='registered' WHERE username=?").run(r.username);
    console.log(r.username, 'EXISTS → restored registered');
  } else {
    console.log(r.username, code, '→ stays poisoned');
  }
}
console.log('next 3 unregistered:', db.prepare("SELECT username FROM accounts WHERE status='unregistered' ORDER BY username LIMIT 3").all().map((r) => r.username).join(' '));
