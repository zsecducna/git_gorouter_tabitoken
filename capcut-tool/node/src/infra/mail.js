// src/infra/mail.js — own-domain IMAP catch-all mailbox reader for CapCut OTP codes.
// Replaces the paid OKOTP and free TempMail sources of the Python tool:
// measured 01:30 2026-09-01, 10/20 OKOTP-rented mailboxes came back 'Email
// dead', and TempMail's documented host 404s on every endpoint (measured
// 19:28 2026-08-31). Own domain + catch-all IMAP = no per-mailbox cost, no
// third party block-lists. Mailboxes are READ ONLY here — the email addresses
// are pre-provisioned rows in accounts.db (provision-capcut.mjs); this module
// never creates or deletes mail. Auth + IDLE-push pattern mirrors
// /Users/z/Desktop/gorouter-auto/mail-otp.mjs: fast fetch sweep first (the
// code may already sit in the box), then one IDLE connection per pollable
// folder for near-real-time push. Stalwart quirk (measured): new mail
// announces via untagged STATUS, NOT EXISTS — BOTH the `exists` and
// `mailboxUpdate` events are wired or pushes are silently missed.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Domain of the pre-provisioned capcut.com account rows. Exact spelling:
// t-h-a-n-h-p-h-u-o-n-g-l-a-t-o-i (the only domain currently receiving mail,
// user-confirmed 2026-09-01).
const DEFAULT_EMAIL_DOMAIN = 'thanhphuonglatoi.com';
// Shared IMAP server (same host mail-otp.mjs uses); override via settings.MAIL_HOST.
const DEFAULT_MAIL_HOST = 'mail.duke-kr.win';

// Poll both the inbox and the spam folder: the server files weak-SPF senders
// into Junk, and CapCut/"Pippit" mail occasionally lands there — polling
// INBOX alone silently loses codes. 'Junk Mail' is the measured folder name
// on mail.duke-kr.win (mail-otp.mjs); 'Junk' is the common Dovecot alias.
// Folders that fail to open are skipped.
const FOLDERS = ['INBOX', 'Junk Mail', 'Junk'];

// Folders that get a dedicated IDLE push connection while waitForCode waits.
// Only INBOX and the measured 'Junk Mail' — 'Junk' is a mere Dovecot ALIAS of
// the same folder, so it stays sweep/poll-only and can never double-report
// the same message on two push links.
const IDLE_FOLDERS = ['INBOX', 'Junk Mail'];

// How many newest messages to fetch per folder per poll round. The catch-all
// box is shared by every concurrent worker (each matches on its own To:
// address), so scan a window large enough to not miss ours on a busy run.
const FETCH_COUNT = 50;

// CSS color codes (#000000, #00c1cd, ...) are the ONLY thing in a CapCut mail
// that looks like a 6-digit code — strip them BEFORE scanning or the parser
// picks them up as codes. Ported verbatim from tempmail.py.
const RE_HEX_COLOR = /#[0-9a-fA-F]{3,8}/g;
const RE_RGBA = /rgba?\([^)]*\)/g;
const RE_TAG = /<[^>]+>/g;
// A run of exactly 6 digits, not touching another digit on either side.
const RE_SIX_DIGITS = /(?<!\d)(\d{6})(?!\d)/g;

/**
 * Sanitize a mail body for code scanning: strip CSS hex colors, rgba(...)
 * values, and HTML tags. Port of tempmail.py `_lam_sach`. Gotcha kept from
 * the Python source: quoted-printable bodies must be decoded BEFORE this
 * step ('=3D' is '=' and '=\r\n' is a soft line break — undecoded, a 6-digit
 * code can be split in two). mailparser already decodes QP for both .text
 * and .html, so no explicit decode is needed here.
 */
export function stripColorsAndTags(content) {
  let t = String(content ?? '');
  t = t.replace(RE_HEX_COLOR, ' ');
  t = t.replace(RE_RGBA, ' ');
  t = t.replace(RE_TAG, ' ');
  return t;
}

/**
 * Extract the CapCut 6-digit verification code from a parsed mail.
 * Port of tempmail.py `boc_ma_capcut`. Prefers the SUBJECT — CapCut writes
 * the code right there ("...verification code is 776702"), clean, no CSS.
 * Body scan order: text, then html, after sanitizing each. Codes made of one
 * repeated digit (000000, 111111) are skipped: almost always leftover CSS
 * residue. Missing a real code like that is a one-in-a-million event; a false
 * accept burns the signup attempt. Returns the 6-digit string or null.
 */
export function extractCapcutCode(mail) {
  if (!mail || typeof mail !== 'object') return null;
  const subject = String(mail.subject ?? '');
  const inSubject = subject.match(RE_SIX_DIGITS);
  if (inSubject) return inSubject[0]; // whole match is exactly the 6 digits
  for (const body of [mail.text, mail.html]) {
    if (!body) continue;
    for (const m of stripColorsAndTags(body).matchAll(RE_SIX_DIGITS)) {
      const code = m[1];
      if (new Set(code).size > 1) return code; // all-same-digit = CSS junk
    }
  }
  return null;
}

/**
 * Config sanity check for the mail source. Returns a list of human-readable
 * problem strings (empty = ready to run). MAIL_PASS is checked against
 * process.env because it lives in the repo-root .env, not in config.js.
 */
export function validateMail(settings = {}) {
  const problems = [];
  if (!process.env.MAIL_PASS) {
    problems.push('MAIL_PASS is not set — add MAIL_PASS=<catch-all mailbox password> to the repo-root .env (loaded by src/util/util.js loadEnv()); IMAP cannot authenticate without it');
  }
  if (!settings.EMAIL_DOMAIN && !settings.MAIL_CATCHALL_USER) {
    problems.push(`EMAIL_DOMAIN is not set — catch-all user would default to me@${DEFAULT_EMAIL_DOMAIN}, which may not match your mailbox`);
  }
  return problems;
}

/**
 * Parse a raw MIME source into the flat shape the code scanner wants.
 * mailparser handles quoted-printable/base64 decoding and HTML alternatives;
 * text falls back to tag-stripped html when a mail has no text part.
 */
async function parseMessage(source) {
  const mail = await simpleParser(source);
  return {
    to: String(mail.to?.text ?? '').toLowerCase(),
    from: String(mail.from?.text ?? ''),
    subject: mail.subject ?? '',
    date: mail.date instanceof Date ? mail.date : new Date(mail.date ?? 0),
    text: mail.text ?? (mail.html ? String(mail.html).replace(/<[^>]+>/g, ' ') : ''),
    html: mail.html ? String(mail.html) : '',
  };
}

/**
 * Open the mailbox reader for one pre-provisioned email address.
 * `email` always comes from the claimed accounts.db row — never generated
 * here. Connects lazily (first waitForCode) over one shared IMAP connection
 * for sweeps/polls plus ONE dedicated IDLE push connection per pollable
 * folder while waitForCode waits; ImapFlow auto-reconnects, connection
 * errors are logged and answered with a poll fallback instead of throwing.
 * Throws eagerly ONLY when MAIL_PASS is missing — that error is
 * unrecoverable and must fail fast and loud.
 * Returns { waitForCode, release }.
 */
export async function makeMailbox({ settings = {}, email, log = () => {}, shouldStop = () => false }) {
  if (!process.env.MAIL_PASS) {
    throw new Error('MAIL_PASS is not set — put MAIL_PASS=<catch-all mailbox password> in the repo-root .env (src/util/util.js loadEnv() reads it). Cannot read the mailbox.');
  }
  const domain = settings.EMAIL_DOMAIN || DEFAULT_EMAIL_DOMAIN;
  // Shared connection options: the sweep/poll client and every per-folder
  // IDLE client all authenticate as the same single catch-all mailbox.
  const imapOptions = {
    host: settings.MAIL_HOST || DEFAULT_MAIL_HOST,
    port: 993,
    secure: true,
    auth: { user: settings.MAIL_CATCHALL_USER || 'me@' + domain, pass: process.env.MAIL_PASS },
    logger: false,
  };
  const client = new ImapFlow(imapOptions);
  client.on('error', () => {}); // ImapFlow reconnects on its own; errors surface in the poll loop
  const address = String(email || '').toLowerCase();
  // Signup moment minus a 2-minute skew margin — only mail NEWER than this
  // counts. The address is unique per run, so any mail to it is ours; the
  // margin only guards against the local clock running ahead of the sending
  // MTA's Date header (review WARN #1 — a bare `new Date()` filter could
  // silently drop every code mail on clock skew; python had no time filter).
  const since = new Date(Date.now() - 120 * 1000);

  // Live per-folder IDLE push connections. waitForCode owns their lifecycle
  // (opens on wait start, closes on wait end); release() force-closes
  // whatever is still open, e.g. when the caller aborts mid-wait.
  const liveIdlers = new Set();

  /**
   * Close one IDLE connection, best-effort: logout when usable, hard close
   * otherwise, never throws (a broken socket on cleanup must never mask a
   * found code — contract rule). Removes itself from liveIdlers first so
   * release() can never double-close the same connection.
   */
  async function closeIdler(idler) {
    liveIdlers.delete(idler);
    try {
      if (idler.usable) await idler.logout();
      else idler.close();
    } catch {
      try { idler.close(); } catch { /* already gone — nothing to do */ }
    }
  }

  let authHintShown = false;
  /**
   * Auth trap (measured 2026-09-01 preflight): on this host only the
   * me@duke-kr.win IMAP user is real — me@<other hosted domain> fails auth and
   * burns ~8 s per attempt. Surface a pointed hint once instead of silent
   * generic connect errors every poll. Shared by the sweep client and the
   * IDLE clients so the hint appears no matter which connect fails first.
   */
  function showAuthHintOnce(e) {
    if (e && (e.authenticationFailed || /auth/i.test(String(e.responseText || e.message || '')))) {
      if (!authHintShown) {
        authHintShown = true;
        log(`[!] IMAP auth failed for user "${imapOptions.auth.user}" — on this host the working catch-all user is me@duke-kr.win even for other hosted domains. Set MAIL_CATCHALL_USER='me@duke-kr.win' in config.js. Each failed attempt costs ~8 s.`);
      }
    }
  }

  /**
   * (Re)establish the shared IMAP session if it is down. Called by the sweep
   * and every fallback poll round; a dead connection is retried on the next
   * interval, never thrown out of waitForCode (soft-fail per contract).
   */
  async function ensureConnected() {
    try {
      if (!client.usable) await client.connect();
    } catch (e) {
      showAuthHintOnce(e);
      throw e;
    }
  }

  /**
   * Fetch the newest FETCH_COUNT messages from the given folders and keep
   * only ours: To: containing our address AND arrival newer than the signup
   * moment. Oldest→newest, ready for newest-first scanning. Folders that
   * fail to open are skipped quietly (default: every folder in FOLDERS).
   */
  async function fetchCandidates(folders = FOLDERS) {
    const out = [];
    for (const box of folders) {
      let lock;
      try {
        lock = await client.getMailboxLock(box);
      } catch {
        continue; // folder not present on this server — skip quietly
      }
      try {
        const total = client.mailbox.exists;
        if (!total) continue;
        const from = Math.max(1, total - FETCH_COUNT + 1);
        for await (const msg of client.fetch(`${from}:${total}`, { source: true })) {
          const parsed = await parseMessage(msg.source);
          if (parsed.to.includes(address) && parsed.date > since) out.push(parsed);
        }
      } finally {
        lock.release();
      }
    }
    return out.sort((a, b) => a.date - b.date);
  }

  /**
   * Wait for the CapCut code with IDLE push (near-real-time) instead of a
   * bare 5 s poll: (1) one immediate fetch sweep — the code may already sit
   * in the box; (2) ONE dedicated IDLE connection per pollable folder that
   * drains new mail the moment the server announces it and runs the SAME
   * matcher as the poll (To + since filter, sender-hinted newest-first,
   * 6-digit extract). `timeout`/`interval` are SECONDS (defaults 300/5);
   * `interval` now only paces the FALLBACK poll for folders whose IDLE
   * connection died — robustness beats purity, so a dead push link degrades
   * to the old poll loop for that folder for the rest of the wait instead
   * of losing it. Returns the 6-digit code string or null; never throws.
   */
  async function waitForCode({ timeout = 300, interval = 5, log: pollLog = log, shouldStop: stopNow = shouldStop } = {}) {
    const deadline = Date.now() + timeout * 1000;
    let lastError = ''; // dedupe repeated IMAP errors to one log line until the message changes

    // The one true matcher, shared by sweep, fallback poll, and IDLE drain,
    // so push and poll can never disagree on what a hit is: newest first
    // (CapCut invalidates older codes on every resend), sender-hinted
    // (CapCut / "Pippit") mail before unhinted, then 6-digit extraction.
    const pickCode = (candidates) => {
      const newestFirst = [...candidates].reverse();
      const hinted = newestFirst.filter((m) => /capcut|pippit/i.test(m.from));
      const rest = newestFirst.filter((m) => !/capcut|pippit/i.test(m.from));
      for (const m of [...hinted, ...rest]) {
        const code = extractCapcutCode(m);
        if (code) {
          pollLog(`[mail] code for ${address}: ${code} (from ${m.from})`);
          return code;
        }
      }
      return null;
    };
    // Soft-fail logger: network/auth errors are deduped and retried by later
    // rounds — they must never throw out of waitForCode (contract rule).
    const logSoftError = (err) => {
      const msg = String(err && err.message ? err.message : err).slice(0, 90);
      if (msg !== lastError) {
        pollLog(`[mail] ${msg} — still waiting ...`);
        lastError = msg;
      }
    };

    // --- Phase 1: immediate sweep (fast path — code may already be in the box).
    try {
      await ensureConnected();
      const code = pickCode(await fetchCandidates());
      if (code) return code;
    } catch (err) {
      logSoftError(err); // logged, then retried via the IDLE/poll phases below
    }

    // --- Phase 2: IDLE push wait.
    const fallback = new Set(); // folders whose push link died → polled for the rest of the wait
    const myIdlers = []; // IDLE connections opened by THIS wait
    const pollMs = Math.max(1, interval) * 1000;

    return await new Promise((resolve) => {
      let done = false;
      // Single exit point: clears every timer, resolves, then tears the IDLE
      // connections down best-effort in the background — a slow logout must
      // never delay returning a found code.
      const finish = (value) => {
        if (done) return;
        done = true;
        clearInterval(stopTimer);
        clearInterval(pollTimer);
        clearTimeout(clock);
        resolve(value);
        for (const idler of myIdlers) void closeIdler(idler);
      };

      // shouldStop watchdog: IDLE blocks the connection, so the flag cannot
      // be awaited — poll it on a short timer instead (checked between events).
      const stopTimer = setInterval(() => {
        if (stopNow()) finish(null);
      }, 500);
      // Absolute deadline for the whole wait, push or no push.
      const clock = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));

      // Fallback poller: folders whose IDLE connection errored keep the old
      // polling cadence for the rest of the wait; zero work while both push
      // links are healthy. Overlapping rounds are suppressed — a slow poll
      // must not stack up on a flaky connection.
      let pollBusy = false;
      const pollTimer = setInterval(async () => {
        if (done || pollBusy || fallback.size === 0) return;
        pollBusy = true;
        try {
          await ensureConnected();
          const code = pickCode(await fetchCandidates([...fallback]));
          if (code) finish(code);
        } catch (err) {
          logSoftError(err); // same soft-fail as the old poll loop
        } finally {
          pollBusy = false;
        }
      }, pollMs);

      // Arm one IDLE connection per pollable folder (skip folders that fail
      // to open, as in the sweep). Stalwart quirk (measured): new mail
      // announces via untagged STATUS, NOT EXISTS — wire BOTH events.
      const armed = new Set(); // folders with both push events successfully wired
      (async () => {
        for (const box of IDLE_FOLDERS) {
          if (done) return;
          const idler = new ImapFlow({ ...imapOptions, auth: { ...imapOptions.auth } });
          // Health rule: once this folder's push link errors, it stays on the
          // fallback poll for the rest of the wait (logged once — no
          // reconnect churn, robustness > purity).
          idler.on('error', () => {
            if (done) return;
            if (!fallback.has(box)) {
              fallback.add(box);
              pollLog(`[mail] IDLE connection error on "${box}" — falling back to ${interval}s polling for the rest of this wait`);
            }
          });
          try {
            await idler.connect();
            await idler.mailboxOpen(box);
          } catch (err) {
            // Connect or SELECT failed (absent folders skip quietly here, as
            // in the sweep): no push link for this folder — if the folder
            // exists at all, the fallback poll above still sweeps it.
            showAuthHintOnce(err);
            if (!fallback.has(box)) {
              fallback.add(box);
              pollLog(`[mail] could not open "${box}" for IDLE — covered by ${interval}s polling instead`);
            }
            try { idler.close(); } catch { /* already gone — nothing to do */ }
            continue;
          }
          myIdlers.push(idler);
          liveIdlers.add(idler);

          // Drain handler, run on every push event: fetch everything since
          // the last seen uid. `${uidNext}:*` is burst-safe — N mails landing
          // together drain in one range sweep, uidNext advancing per message.
          let draining = false;
          let pendingDrain = false;
          const drain = async () => {
            if (done) return;
            if (draining) { pendingDrain = true; return; } // event burst → one more sweep after this one
            draining = true;
            try {
              do {
                pendingDrain = false;
                const batch = [];
                for await (const msg of idler.fetch(`${idler.mailbox.uidNext}:*`, { uid: true, source: true }, { uid: true })) {
                  idler.mailbox.uidNext = msg.uid + 1;
                  const parsed = await parseMessage(msg.source);
                  if (parsed.to.includes(address) && parsed.date > since) batch.push(parsed);
                }
                const code = pickCode(batch);
                if (code) { finish(code); return; }
              } while (pendingDrain && !done);
            } catch {
              // Transient fetch failure: the error handler above has already
              // armed the fallback poll for this folder — and an exception
              // must never escape an event handler.
            } finally {
              draining = false;
            }
          };
          // Stalwart announces new mail via STATUS (mailboxUpdate), everyone
          // else via EXISTS — wire both, one shared drain either way.
          idler.on('exists', drain);
          idler.on('mailboxUpdate', drain);
          armed.add(box);
        }
      })().catch(() => {
        // Unexpected setup crash: push every not-yet-armed folder onto the
        // fallback poll so the wait can still succeed.
        for (const box of IDLE_FOLDERS) if (!armed.has(box)) fallback.add(box);
      });
    });
  }

  /**
   * Close the shared IMAP session plus any IDLE push connections still open
   * from an in-flight waitForCode (e.g. caller abort). Soft-fail ONLY — a
   * broken socket on cleanup must never mask the signup result (contract
   * rule).
   */
  async function release() {
    const closing = [...liveIdlers].map((idler) => closeIdler(idler));
    try {
      if (client.usable) await client.logout();
      else client.close();
    } catch {
      try { client.close(); } catch { /* already gone — nothing to do */ }
    }
    await Promise.allSettled(closing);
  }

  return { waitForCode, release };
}
