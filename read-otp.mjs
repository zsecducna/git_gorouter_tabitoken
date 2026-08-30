// read-otp.mjs — fetch latest inbound email for a to-address via Resend SDK (per resend-docs.md),
// extract OTP code, save body to otp.txt. Reads RESEND_API_KEY from .env (read-only, never echoed).
// Usage: node read-otp.mjs [to-address] [sender-filter]
import { Resend } from 'resend';
import fs from 'node:fs';

const TO = process.argv[2] ?? 'user2@listing-studio.uk';
const SENDER = process.argv[3] ?? ''; // optional substring, e.g. "github"
const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);
const resend = new Resend(env.RESEND_API_KEY);

// 1. list received emails (docs: resend.emails.receiving.list())
const { data: items, error: listErr } = await resend.emails.receiving.list();
if (listErr) throw new Error('list: ' + JSON.stringify(listErr).slice(0, 200));
if (!items?.length) { console.log('no inbound emails'); process.exit(0); }

// 2. pick latest matching to-address (+ optional sender filter)
const hit =
  items.find(
    (e) => (e.to ?? '').includes(TO) && (!SENDER || (e.from ?? '').toLowerCase().includes(SENDER))
  ) ?? items[0];
console.log(`picked: from=${hit.from} to=${hit.to} subject=${hit.subject} id=${hit.id}`);

// 3. retrieve full body (docs: resend.emails.receiving.get(id))
const { data: full, error: getErr } = await resend.emails.receiving.get(hit.id);
if (getErr) throw new Error('get: ' + JSON.stringify(getErr).slice(0, 200));
const text = full.text ?? full.html ?? '';
fs.writeFileSync('otp.txt', text);

// 4. extract OTP: standalone 4-8 digit group, GitHub-style
const code = (text.match(/\b(\d{6,8})\b/) ?? text.match(/\b([A-Z0-9]{6,8})\b/))?.[1];
console.log(`code: ${code ?? 'NOT FOUND — see otp.txt'}`);
