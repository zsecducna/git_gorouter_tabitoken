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

const MAIL_DOMAIN = process.env.MAIL_DOMAIN ?? env.MAIL_DOMAIN ?? 'duke-kr.win'; // override for other catch-all domains

// hasMailCreds — IMAP available? (MAIL_PASS required; MAIL_USER optional,
// defaults to the catch-all mailbox me@duke-kr.win)
export const hasMailCreds = () => Boolean(env.MAIL_PASS);

// isFarmEmail — dispatcher helper: which OTP source owns this address?
export const isFarmEmail = (email) => (email ?? '').endsWith('@' + MAIL_DOMAIN);

// FOLDERS — the spam filter files weak-SPF senders into Junk Mail; GitHub
// occasionally lands there, so INBOX alone silently loses codes
const FOLDERS = ['INBOX', 'Junk Mail'];

const parseMsg = async (source) => {
  const mail = await simpleParser(source);
  return {
    to: (mail.to?.text ?? '').trim(),
    from: (mail.from?.text ?? '').trim(),
    date: mail.date ?? new Date(0),
    text: mail.text ?? String(mail.html ?? '').replace(/<[^>]+>/g, ' '),
  };
};

const newClient = () => new ImapFlow({
  host: process.env.MAIL_HOST ?? 'mail.duke-kr.win',
  port: Number(process.env.MAIL_PORT ?? 993),
  secure: true,
  auth: { user: env.MAIL_USER ?? 'me@' + MAIL_DOMAIN, pass: env.MAIL_PASS },
  logger: false,
});

// fetchRecent — newest-last array of {to, from, date, text} across BOTH folders
async function fetchRecent(count = 40) {
  const client = newClient();
  await client.connect();
  try {
    const out = [];
    for (const box of FOLDERS) {
      const lock = await client.getMailboxLock(box);
      try {
        const total = client.mailbox.exists;
        if (!total) continue;
        const from = Math.max(1, total - count + 1);
        for await (const msg of client.fetch(`${from}:${total}`, { source: true })) {
          out.push(await parseMsg(msg.source));
        }
      } finally { lock.release(); }
    }
    return out.sort((a, b) => new Date(a.date) - new Date(b.date)); // oldest→newest
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

// imapPollOtp — newest GitHub mail to `email` newer than `since`; digits = 6|8.
// Persistent IMAP connection across poll rounds (one TLS+login, then cheap
// NOOP+fetch every 3 s) — comparable latency to the Resend HTTP poll.
export async function imapPollOtp(email, since, digits = 8) {
  const re = new RegExp(`\\b(\\d{${digits}})\\b`);
  const anchored = digits === 8
    ? /entering the code below:?\s*(\d{8})/i
    : /\b(\d{6})\b/;

  const match = (m) =>
    m.to.includes(email) && /github/i.test(m.from) && new Date(m.date) > since
      ? (m.text.match(anchored)?.[1] ?? m.text.match(re)?.[1] ?? 'NOCODE')
      : null;

  // fast path: is the code already sitting in the box?
  try {
    for (const m of [...await fetchRecent(30)].reverse()) {
      const c = match(m);
      if (c === 'NOCODE') throw new Error(`GitHub mail found but no ${digits}-digit code in body`);
      if (c) return c;
    }
  } catch (e) { if (/no \d+-digit/.test(e.message)) throw e; }

  // IDLE push path — server notifies on delivery (<300ms); one client per
  // folder, matching watch-mail.js. Resolves as soon as the mail lands.
  const clients = [];
  const cleanup = async () => { for (const c of clients) { try { await c.logout(); } catch {} } };
  const timer = setTimeout(async () => {
    await cleanup();
    rejectWait(new Error('OTP not received via IMAP within 3 minutes'));
  }, 180_000);

  let rejectWait;
  const waited = new Promise((resolve, reject) => {
    rejectWait = reject;
    const result = async (c) => resolve(c);
    (async () => {
      for (const box of FOLDERS) {
        const client = newClient();
        client.on('error', () => {}); // ImapFlow auto-reconnects
        await client.connect();
        clients.push(client);
        await client.mailboxOpen(box);
        const drain = async () => {
          const range = `${client.mailbox.uidNext}:*`;
          for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
            client.mailbox.uidNext = msg.uid + 1;
            const c = match(await parseMsg(msg.source));
            if (c === 'NOCODE') { clearTimeout(timer); await cleanup(); reject(new Error(`GitHub mail found but no ${digits}-digit code in body`)); return; }
            if (c) { clearTimeout(timer); await cleanup(); await result(c); return; }
          }
        };
        client.on('exists', drain);
        client.on('mailboxUpdate', drain);
      }
    })().catch(async (e) => { clearTimeout(timer); await cleanup(); reject(e); });
  });

  try {
    return await waited;
  } finally {
    clearTimeout(timer);
    await cleanup();
  }
}
