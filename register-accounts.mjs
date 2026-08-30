// register-accounts.mjs — end-to-end GitHub registration via REAL form
// navigation (v3, DOM-driven).
//
// Lesson from capture + probes (2026-08-30): GitHub creates the account only
// when the launch-code verify completes, and the whole signup→verify chain is
// bound to the browser session + DataDome JS signals. In-page fetch() POSTs
// 422 — only real form navigations with trusted keystrokes/clicks work.
// So: real interactions end-to-end, humanized, in a fresh CloakBrowser per
// account. The DataDome slider stays human-in-the-loop (pause + resume).
//
// Flow per account:
//   goto /signup → fill #email/#login/#password (typed) → select Vietnam →
//   click "Create account" → wait /account_verifications → poll Resend OTP →
//   type 8 launch-code boxes (auto-submit) → dashboard → login confirm →
//   mark status='registered' in accounts.db
//
// Usage:
//   node register-accounts.mjs            # all unregistered accounts, sequential
//   node register-accounts.mjs <username> # one specific account
import { launch } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = fileURLToPath(new URL('./accounts.db', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// parseProxy — "http://user:pass@host:port" (scheme optional) → cloakbrowser
// proxy object { server, username, password }
function parseProxy(url) {
  const withScheme = /^https?:\/\//.test(url) ? url : `http://${url}`;
  const u = new URL(withScheme);
  return {
    server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  };
}

// loadProxies — proxies.txt next to this script, one proxy per line, '#' comments.
// Accepts http://user:pass@host:port OR host:port:user:pass (zingproxy style).
function loadProxies() {
  const f = fileURLToPath(new URL('./proxies.txt', import.meta.url));
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const p = l.split(':');
      return p.length === 4 ? `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}` : l;
    });
}

// log — timestamped progress line
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// loadEnv — read RESEND_API_KEY from .env (read-only, never echoed)
function loadEnv() {
  return Object.fromEntries(
    fs.readFileSync(fileURLToPath(new URL('./.env', import.meta.url)), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
  );
}

// db — one shared connection for the whole run
const db = new DatabaseSync(DB);

// setStatus — update one row's status
function setStatus(username, status) {
  db.prepare('UPDATE accounts SET status=? WHERE username=?').run(status, username);
}

// pickAccount — next unregistered row (or the one named on the CLI); null if none
function pickAccount(username) {
  return username
    ? db.prepare("SELECT * FROM accounts WHERE username=? AND status='unregistered'").get(username)
    : db.prepare("SELECT * FROM accounts WHERE status='unregistered' ORDER BY created LIMIT 1").get();
}

// pollOtp — poll Resend inbound list for a NEW email to `to` (created_at after
// `since`, GitHub sender), extract the 8-digit launch code. Max ~4 min.
async function pollOtp(to, apiKey, since) {
  const H = { Authorization: `Bearer ${apiKey}` };
  const deadline = Date.now() + 240_000;
  await sleep(5000); // give GitHub a moment to send before first poll
  while (Date.now() < deadline) {
    const r = await fetch('https://api.resend.com/emails/receiving', { headers: H });
    if (r.ok) {
      const { data } = await r.json();
      const hit = (data ?? [])
        .filter((e) => (e.to ?? []).includes(to) && /github/i.test(e.from) && new Date(e.created_at) > since)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (hit) {
        const full = await fetch(`https://api.resend.com/emails/receiving/${hit.id}`, { headers: H }).then((x) => x.json());
        // prefer text part; strip tags if html. Anchor on GitHub's phrasing to
        // avoid matching dates/IDs elsewhere in the body.
        const raw = full.text ?? String(full.html ?? '').replace(/<[^>]+>/g, ' ');
        const code =
          raw.match(/entering the code below:?\s*(\d{8})/i)?.[1] ??
          raw.match(/launch code[^0-9]{0,60}(\d{8})/i)?.[1] ??
          raw.match(/\b(\d{8})\b/)?.[1];
        if (code) return code;
        throw new Error('GitHub email found but no 8-digit code in body');
      }
    } else {
      log(`  resend api ${r.status}, retrying…`);
    }
    await sleep(10_000);
  }
  throw new Error('OTP not received within 4 minutes');
}

// hasChallenge — DataDome interstitial present? It lives in a cross-origin
// iframe with empty main-page text, so check iframe srcs primarily; body text
// only counts for strong challenge markers.
const hasChallenge = (page) =>
  page.evaluate(() => {
    const frameHit = [...document.querySelectorAll('iframe')]
      .some((f) => /captcha-delivery|datadome|arkose|hcaptcha|recaptcha|turnstile/i.test(f.src));
    const textHit = /verify your account|unusual activity|prove you are human|complete these steps|are you a robot/i.test(document.body.innerText);
    return { hit: frameHit || textHit, src: frameHit ? 'iframe' : textHit ? 'text' : null };
  });

// waitForForm — wait until formSelector renders (that's the real gate: DataDome
// leftover iframes don't block anything while the form is there). If a visible
// challenge is up, screenshot + mark it and wait for a human (max 15 min).
async function waitForForm(page, username, step, formSelector) {
  let marked = false;
  for (let i = 0; i < 450; i++) {
    if (await page.$(formSelector)) return;
    const c = await hasChallenge(page).catch(() => null);
    if (c && c.hit && !marked) {
      marked = true;
      await page.screenshot({ path: `captcha-WAIT-${step}-${username}.png` });
      log(`${username}: ⚠ CAPTCHA at ${step} (${c.src}) — PAUSED, waiting for human (captcha-WAIT-${step}-${username}.png)`);
    }
    await sleep(2000);
  }
  throw new Error(`${step}: form "${formSelector}" never rendered within 15 minutes`);
}

// attachPopupKiller — close Google OAuth popups the moment they appear
function attachPopupKiller(browser) {
  browser.on('page', (p) => {
    const kill = async () => {
      if (/accounts\.google|google\.com\/(o\/oauth|accounts)/.test(p.url())) {
        log('  blocked Google OAuth popup');
        await p.close().catch(() => {});
      }
    };
    p.once('load', kill).catch(() => {});
    setTimeout(kill, 2500);
  });
}

// typeInto — click the field and type like a human (trusted key events)
async function typeInto(page, selector, text) {
  await page.click(selector, { timeout: 15000 });
  await page.type(selector, text, { delay: 30 });
}

// selectCountry — open country dropdown, click acc.region (e.g. "United States"
// when going through the US proxy); throw if not selected
async function selectCountry(page, region) {
  await page.click('#country-dropdown-panel-button');
  await page.waitForSelector('[role=option],li button,a', { timeout: 5000 }).catch(() => {});
  const ok = await page.evaluate((region) => {
    const el = [...document.querySelectorAll('button,a,li,div[role=option]')]
      .find((e) => e.textContent.replace(/\u00A0/g, ' ').trim().includes(region));
    if (!el) return false;
    el.click();
    return true;
  }, region);
  await sleep(500);
  const shown = await page.evaluate(() =>
    document.querySelector('#country-dropdown-panel-button')?.textContent ?? ''
  );
  if (!ok || !shown.toLowerCase().includes(region.slice(0, 6).toLowerCase()))
    throw new Error(`could not select region "${region}" in country dropdown (got: ${shown})`);
}

// registerOne — drive one account through the full flow with real navigation.
// proxy: optional "http://user:pass@host:port" string — GitHub caps ~3 signups
// per IP, so each proxy gets its own batch of accounts.
async function registerOne(acc, apiKey, proxy) {
  log(`registering ${acc.username} (${acc.email})${proxy ? ` via ${proxy.replace(/\/\/[^@]*@/, '//***@')}` : ''}`);
  const browser = await launch({ headless: false, humanize: true, ...(proxy ? { proxy: parseProxy(proxy) } : {}) });
  const page = await browser.newPage();
  const since = new Date(); // OTP must arrive after this — no stale codes
  try {
    // 1. signup form
    attachPopupKiller(browser);
    await page.goto('https://github.com/signup?source=form-home-signup', { waitUntil: 'load' });
    await waitForForm(page, acc.username, 'signup-gate', '#email');
    await sleep(1500);

    // 2. fill fields with real keystrokes
    await typeInto(page, '#email', acc.email);
    await typeInto(page, '#login', acc.username);
    await typeInto(page, '#password', acc.password);
    await selectCountry(page, acc.region);

    // 3. click the real submit — trusted click on exact "Create account"
    //    (dismiss cookie banner first — it overlays the button and eats clicks;
    //     never the SSO buttons: "Continue with Google" also matches /continue/)
    for (const t of ['Accept', 'Reject']) {
      const banner = page.locator(`button:has-text("${t}")`).first();
      if (await banner.isVisible().catch(() => false)) {
        await banner.click().catch(() => {});
        break;
      }
    }
    await sleep(500);
    const createBtn = page.getByRole('button', { name: /create account/i }).first();
    if (await createBtn.count()) {
      await createBtn.scrollIntoViewIfNeeded().catch(() => {});
      await createBtn.click({ timeout: 10000 }).catch(async () => {
        // fallback: JS click if the trusted click times out
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button,input')]
            .find((b) => /^create account/i.test((b.textContent || b.value || '').trim()));
          b?.click();
        });
      });
    } else {
      throw new Error('no Create account button found');
    }
    await page.waitForURL(/account_verifications|signup/, { timeout: 30000 }).catch(() => {});
    await sleep(2000);

    // signup failure = still on signup (validation/captcha/rate-limit)
    if (/\/signup/.test(page.url())) {
      const t = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: `fail-submit-${acc.username}.png` });
      const reason =
        t.match(/too many requests|secondary rate limit|abuse detection/i)?.[0] ??
        t.match(/already (taken|used)|invalid[^.]{0,60}|error[^.]{0,60}/i)?.[0] ??
        'unknown reason';
      throw new Error(`stayed on signup — ${reason}`);
    }

    // 4. OTP — poll Resend, then type the 8 launch-code boxes (auto-submits)
    await waitForForm(page, acc.username, 'verify', '#launch-code-0');
    const code = await pollOtp(acc.email, apiKey, since);
    log(`${acc.username}: OTP ${code} received`);
    for (let i = 0; i < code.length; i++) {
      await page.type(`#launch-code-${i}`, code[i], { delay: 90 });
    }
    await page.waitForURL(/login|dashboard/, { timeout: 30000 }).catch(() => {});
    await sleep(2000);

    // 5. sign in to confirm the account is live
    await page.goto('https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fdashboard', { waitUntil: 'load' });
    await waitForForm(page, acc.username, 'login', 'form[action="/session"]');
    await typeInto(page, '#login_field', acc.username);
    await typeInto(page, '#password', acc.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }).catch(() => {}),
      page.evaluate(() => {
        const b = [...document.querySelectorAll('input[type=submit],button')]
          .find((b) => /sign in/i.test(b.value || b.textContent || ''));
        if (!b) throw new Error('sign-in button not found');
        b.click();
      }),
    ]);
    await sleep(2000);

    // 6. outcome
    const url = page.url();
    if (/dashboard/.test(url)) {
      setStatus(acc.username, 'registered');
      log(`${acc.username}: REGISTERED + verified + signed in → ${url}`);
    } else {
      await page.screenshot({ path: `fail-login-${acc.username}.png` });
      const t = await page.evaluate(() => document.body.innerText.slice(0, 200));
      log(`${acc.username}: login unconfirmed (${url}) — ${t.replace(/\n/g, ' ').slice(0, 120)}`);
      throw new Error(`login did not reach dashboard: ${url}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// main — loop over unregistered rows; failed usernames tracked so a permanent
// failure can't loop forever; rate-limit errors trigger a 10-min cooldown and
// retry of the SAME account (GitHub secondary rate limit, not a real failure).
// Proxy source, first match wins:
//   1. CLI: node register-accounts.mjs <username?> --proxy http://user:pass@host:port
//   2. proxies.txt — accounts chunked across proxies, 2 per proxy (GitHub
//      caps ~3 signups/IP; one-proxy fallback if several lines)
const apiKey = loadEnv().RESEND_API_KEY;
const argv = process.argv.slice(2);
const proxyFlagIdx = argv.indexOf('--proxy');
const cliProxy = proxyFlagIdx >= 0 ? argv[proxyFlagIdx + 1] : null;
const only = argv.find((a, i) => !a.startsWith('--') && i !== proxyFlagIdx + 1);
const proxies = cliProxy ? [cliProxy] : loadProxies();
const ACCOUNTS_PER_PROXY = 2;
const failed = new Set();
const RATE_LIMIT_RE = /too many requests|secondary rate limit|abuse detection/i;
if (only && !pickAccount(only)) {
  console.error(`account ${only} not found in accounts.db (or not unregistered)`);
  process.exit(1);
}
let rateLimitStreak = 0;
const WINDOW_MS = 240_000;   // proxy rotates public IP every 240s
const WINDOW_MAX = 3;        // GitHub ~3 signups/IP — stay inside one IP window
const signupTimes = [];
while (true) {
  const acc = pickAccount(only);
  if (!acc || failed.has(acc.username)) break;
  // sliding-window cap: if WINDOW_MAX signups happened inside the current IP
  // window, wait until the oldest rolls out (fresh IP = fresh rate limit)
  const now = Date.now();
  while (signupTimes.length && now - signupTimes[0] > WINDOW_MS) signupTimes.shift();
  if (signupTimes.length >= WINDOW_MAX) {
    const wait = WINDOW_MS - (now - signupTimes[0]) + 5_000;
    log(`window full (${signupTimes.length}/${WINDOW_MAX} in last 240s) — waiting ${Math.round(wait / 1000)}s for IP rotation`);
    await sleep(wait);
  }
  // proxy for this account: rotation index by how many unregistered rows came before it
  const ahead = db.prepare(
    "SELECT COUNT(*) AS n FROM accounts WHERE status='unregistered' AND created < ?"
  ).get(acc.created).n;
  const proxy = proxies.length ? proxies[Math.floor(ahead / ACCOUNTS_PER_PROXY) % proxies.length] : null;
  try {
    await registerOne(acc, apiKey, proxy);
    signupTimes.push(Date.now());
    rateLimitStreak = 0;
  } catch (e) {
    const msg = e.message.split('\n')[0];
    if (RATE_LIMIT_RE.test(msg)) {
      rateLimitStreak++;
      if (rateLimitStreak >= 3) {
        log('rate-limited 3× in a row — aborting run, try again later');
        break;
      }
      log(`${acc.username}: RATE LIMITED — cooling down 10 min, will retry (streak ${rateLimitStreak})`);
      await sleep(600_000);
      continue; // same account retried — not marked failed
    }
    rateLimitStreak = 0;
    log(`${acc.username}: FAILED — ${msg}`);
    failed.add(acc.username);
  }
  if (only) break;      // single-account mode runs once
  await sleep(15_000);  // small gap — IP-window limiter does the real pacing
}
log('run complete — statuses now in accounts.db');
