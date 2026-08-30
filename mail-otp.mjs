// mail-otp.mjs — IMAP catch-all OTP reader for @duke-kr.win (replaces Resend
// for that domain). One shared mailbox (me@duke-kr.win) receives every
// userNNNN@duke-kr.win address; we fetch recent messages, filter by To +
// freshness, extract GitHub codes.
//
// Env: MAIL_PASS (required). Reads the catch-all me@ mailbox regardless of
// MAIL_USER (admin@ is a real account that does NOT see catch-all mail).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const env = Object.fromEntries(
  fs.readFileSync(fileURLToPath(new URL('./.env', import.meta.url)), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);

const MAIL_DOMAIN = 'duke-kr.win';

// isFarmEmail — dispatcher helper: which OTP source owns this address?
export const isFarmEmail = (email) => (email ?? '').endsWith('@' + MAIL_DOMAIN);

// fetchRecent — newest-last array of {to, from, date, text} from catch-all
async function fetchRecent(count = 40) {
  const client = new ImapFlow({
    host: process.env.MAIL_HOST ?? 'mail.duke-kr.win',
    port: Number(process.env.MAIL_PORT ?? 993),
    secure: true,
    auth: { user: 'me@' + MAIL_DOMAIN, pass: env.MAIL_PASS },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      if (!total) return [];
      const from = Math.max(1, total - count + 1);
      const out = [];
      for await (const msg of client.fetch(`${from}:${total}`, { source: true })) {
        const mail = await simpleParser(msg.source);
        out.push({
          to: (mail.to?.text ?? '').trim(),
          from: (mail.from?.text ?? '').trim(),
          date: mail.date ?? new Date(0),
          text: mail.text ?? String(mail.html ?? '').replace(/<[^>]+>/g, ' '),
        });
      }
      return out; // oldest→newest
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => client.close()); }
}

// imapLatestEmailTime — baseline for freshness (newest GitHub mail to address)
export async function imapLatestEmailTime(email) {
  try {
    const msgs = await fetchRecent(40);
    const hit = [...msgs].reverse().find((m) => m.to.includes(email) && /github/i.test(m.from));
    return hit ? new Date(hit.date) : new Date(0);
  } catch { return new Date(0); }
}

// imapPollOtp — newest GitHub mail to `email` newer than `since`; digits = 6|8
export async function imapPollOtp(email, since, digits = 8) {
  const re = new RegExp(`\\b(\\d{${digits}})\\b`);
  const anchored = digits === 8
    ? /entering the code below:?\s*(\d{8})/i
    : /\b(\d{6})\b/;
  for (let round = 0; round < 24; round++) {
    try {
      const msgs = await fetchRecent(40);
      const hit = [...msgs].reverse().find(
        (m) => m.to.includes(email) && /github/i.test(m.from) && new Date(m.date) > since
      );
      if (hit) {
        const code = hit.text.match(anchored)?.[1] ?? hit.text.match(re)?.[1];
        if (code) return code;
        throw new Error('GitHub mail found but no ' + digits + '-digit code in body');
      }
    } catch (e) {
      if (/no \d+-digit/.test(e.message)) throw e;
      // transient IMAP error — retry next round
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error('OTP not received via IMAP within 2 minutes');
}
