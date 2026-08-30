// gorouter-keys.mjs — create a GoRouter API key for one GitHub account.
// Chain: fresh browser → github login (device-OTP via Resend) → gorouter OAuth
// (instant — app already authorized) → /keys → Create API Key → name+group →
// Save changes → copy the API key → store in accounts.db.
// Leaves the browser OPEN at the end (--keep-open) for manual next steps.
//
// Usage: node gorouter-keys.mjs <username> [--keep-open]
import { launch } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = fileURLToPath(new URL('./accounts.db', import.meta.url));
const GOROUTER_URL = 'https://gorouter.app/sign-up?aff=Jju8';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// parseProxy — "http://user:pass@host:port" (scheme optional) → proxy object
function parseProxy(url) {
  const withScheme = /^https?:\/\//.test(url) ? url : `http://${url}`;
  const u = new URL(withScheme);
  return {
    server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  };
}

// loadProxies — proxies.txt next to this script, one per line, '#' comments.
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

// db — shared connection
const db = new DatabaseSync(DB);

// pollOtp — poll Resend inbound for a NEW GitHub email to `to`, extract 6-digit
// device-verification code
async function pollOtp(to, since) {
  const env = Object.fromEntries(
    fs.readFileSync(fileURLToPath(new URL('./.env', import.meta.url)), 'utf8')
      .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
  );
  const H = { Authorization: `Bearer ${env.RESEND_API_KEY}` };
  const deadline = Date.now() + 240_000;
  await sleep(5000);
  while (Date.now() < deadline) {
    const r = await fetch('https://api.resend.com/emails/receiving', { headers: H });
    if (r.ok) {
      const { data } = await r.json();
      const hit = (data ?? [])
        .filter((e) => (e.to ?? []).includes(to) && /github/i.test(e.from) && new Date(e.created_at) > since)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (hit) {
        const full = await fetch(`https://api.resend.com/emails/receiving/${hit.id}`, { headers: H }).then((x) => x.json());
        const raw = full.text ?? String(full.html ?? '').replace(/<[^>]+>/g, ' ');
        const code = raw.match(/\b(\d{6})\b/)?.[1];
        if (code) return code;
        throw new Error('GitHub email found but no 6-digit code in body');
      }
    }
    await sleep(10_000);
  }
  throw new Error('device OTP not received within 4 minutes');
}

// dumpState — page facts for debugging
async function dumpState(page, tag) {
  const info = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
    buttons: [...document.querySelectorAll('button,a[role=button],input[type=submit]')]
      .map((b) => (b.textContent || b.value || '').trim()).filter(Boolean).slice(0, 20),
    inputs: [...document.querySelectorAll('input:not([type=hidden]),select')].map((e) => ({ name: e.name || e.id, type: e.type })),
  }));
  log(`${tag}: ${JSON.stringify(info)}`);
  await page.screenshot({ path: `keys-${tag}.png` }).catch(() => {});
  return info;
}

// waitForSelector — poll for selector up to 30s
async function waitForSelector(page, selector, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.$(selector)) return true;
    await sleep(1000);
  }
  return false;
}

// githubLogin — login to GitHub, auto-resolve device verification via Resend OTP
async function githubLogin(page, acc) {
  await page.goto('https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fdashboard', { waitUntil: 'load' });
  await waitForSelector(page, 'form[action="/session"]');
  await page.click('#login_field');
  await page.type('#login_field', acc.username, { delay: 30 });
  await page.click('#password');
  await page.type('#password', acc.password, { delay: 30 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }).catch(() => {}),
    page.evaluate(() => {
      [...document.querySelectorAll('input[type=submit],button')]
        .find((b) => /sign in/i.test(b.value || b.textContent || ''))?.click();
    }),
  ]);
  await sleep(2000);
  let url = page.url();
  if (/sessions\/verified-device/.test(url)) {
    log(`${acc.username}: device verification — reading OTP`);
    const code = await pollOtp(acc.email, new Date(Date.now() - 10 * 60 * 1000));
    log(`${acc.username}: device OTP ${code}`);
    await waitForSelector(page, 'input[name="otp"],input[type="text"]');
    await page.click('input[name="otp"]');
    await page.type('input[name="otp"]', code, { delay: 80 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }).catch(() => {}),
      page.keyboard.press('Enter').catch(() => {}),
    ]);
    await sleep(2500);
    url = page.url();
    log(`${acc.username}: device verify → ${url}`);
  }
  if (!/github\.com\/?$|dashboard/.test(url)) {
    const errText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300)).catch(() => '');
    await page.screenshot({ path: `fail-ghlogin-${acc.username}.png` }).catch(() => {});
    throw new Error(`github login failed: ${url} — ${errText}`);
  }
}

// sniffedKeys — full keys captured from creation POST responses (server only
// returns the full key once, at creation; the table always shows it masked)
const sniffedKeys = [];

// keysFlow — create API key on gorouter /keys; full key comes from the sniffed
// creation response, UI copy paths are fallbacks only
async function keysFlow(page, acc) {
  // 1. create a new key unless the DB already has one — table shows masked
  //    values so existing keys can't be re-extracted from the UI
  await page.goto('https://gorouter.app/keys', { waitUntil: 'load' });
  await sleep(2500);
  const keyName = acc.gorouter_api_key ? `${acc.username}-key2` : `${acc.username}-key1`;
  const existing = await page.evaluate((n) =>
    [...document.querySelectorAll('tr')].some((r) => r.textContent.includes(n)), keyName);
  if (existing) {
    log(`${acc.username}: ${keyName} already exists in table — will try UI copy`);
  } else {
    // open the create dialog (exact "Create API Key" button — page may still be
    // loading/console onboarding, so wait for it)
    let opened = false;
    for (let i = 0; i < 20; i++) {
      opened = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button,a')]
          .find((b) => /^create api key$/i.test((b.textContent || '').trim()));
        if (!b) return false;
        b.click();
        return true;
      });
      if (opened) break;
      await sleep(1000);
    }
    if (!opened) {
      await page.screenshot({ path: `keys-fail-nokeybtn-${acc.username}.png` });
      throw new Error('Create API Key button not found');
    }
    await waitForSelector(page, 'input[name="name"]');
    await sleep(800);

    // 2. name — any info is fine, use <username>-key1
    await page.click('input[name="name"]');
    await page.type('input[name="name"]', keyName, { delay: 30 });
    await sleep(400);

    // 3. group — open the group dropdown, pick the "default" option if present
    const groupPicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((b) => /select a group/i.test((b.textContent || '').trim()));
      if (!b) return 'no-dropdown';
      b.click();
      return 'opened';
    });
    if (groupPicked === 'opened') {
      await sleep(800);
      await page.evaluate(() => {
        const opt = [...document.querySelectorAll('[role=option],li,div[data-radix-popper-content-wrapper] *')]
          .find((e) => /^default$/i.test((e.textContent || '').trim()))
          ?? [...document.querySelectorAll('[role=option]')][0];
        opt?.click();
      });
      await sleep(500);
    }

    // 4. Save changes — exact button; dialog must close and table must gain a row
    const saveClicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((b) => /^save changes$/i.test((b.textContent || '').trim()));
      if (!b) return false;
      b.click();
      return true;
    });
    if (!saveClicked) {
      await page.screenshot({ path: `keys-fail-save-${acc.username}.png` });
      throw new Error('Save changes button not found');
    }
    // the creation POST response carries the FULL key — grab it fresh
    for (let i = 0; i < 10 && !sniffedKeys.length; i++) await sleep(1000);
  }
  await dumpState(page, `${acc.username}-key-created`);

  // 5. full key: sniffed creation response first, UI copy paths as fallback
  let apiKey = sniffedKeys[sniffedKeys.length - 1] ?? null;
  if (apiKey) {
    log(`${acc.username}: API key captured from creation response`);
    return apiKey;
  }
  // fallbacks: UI copy paths (table inline / key-cell popover)
  const context = page.context();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://gorouter.app' }).catch(() => {});
  apiKey = await page.evaluate(() => {
    const el = [...document.querySelectorAll('td *,code,span')]
      .map((e) => (e.textContent || '').trim())
      .find((t) => /^(sk-|gr-|grt-)[A-Za-z0-9_\-]{8,}$/.test(t));
    return el ?? null;
  });
  if (!apiKey) {
    // brute-force: click EVERY button in the API Key cell (masked key button,
    // copy icon, …), reading the clipboard after each — one of them copies
    const btnCount = await page.evaluate(() =>
      document.querySelector('td[data-column-id="key"]')?.querySelectorAll('button').length ?? 0);
    log(`${acc.username}: probing ${btnCount} buttons in key cell`);
    for (let bi = 0; bi < btnCount; bi++) {
      await page.locator('td[data-column-id="key"] button').nth(bi).click({ timeout: 5000 }).catch(() => {});
      await sleep(1200);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
      if (clip && /^(sk-|gr-|grt-)[A-Za-z0-9_\-]{8,}$/.test(clip.trim())) {
        apiKey = clip.trim();
        log(`${acc.username}: clipboard key from button #${bi}`);
        break;
      }
      await page.keyboard.press('Escape').catch(() => {}); // close any popover
      await sleep(400);
    }
    if (!apiKey) {
      await page.screenshot({ path: `keys-fail-copy-${acc.username}.png` });
      throw new Error(`no key-cell button copied a key (probed ${btnCount})`);
    }
  }
  if (!apiKey || !/^(sk-|gr-|grt-)[A-Za-z0-9_\-]{8,}$/.test(apiKey.trim())) {
    await page.screenshot({ path: `keys-fail-copy-${acc.username}.png` });
    throw new Error(`clipboard did not contain a valid API key (got: ${String(apiKey).slice(0, 40)})`);
  }
  log(`${acc.username}: API key ${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`);
  return apiKey.trim();
}

// main
const username = process.argv[2];
if (!username) {
  console.error('usage: node gorouter-keys.mjs <username> [--keep-open]');
  process.exit(1);
}
const acc = db.prepare("SELECT * FROM accounts WHERE username=? AND status='registered'").get(username);if (!acc) {
  console.error(`account ${username} not found / not registered`);
  process.exit(1);
}

log(`creating gorouter API key for ${acc.username}`);
// proxy — CLI --proxy flag wins, else proxies.txt rotation. A dead/MITM-broken
// proxy (net::ERR_*, cert errors) advances to the next one, up to 3 tries.
const argv = process.argv.slice(2);
const proxyFlagIdx = argv.indexOf('--proxy');
const cliProxy = proxyFlagIdx >= 0 ? argv[proxyFlagIdx + 1] : null;
const proxies = cliProxy ? [cliProxy] : loadProxies();
const allDone = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE status='registered' AND created < ?").get(acc.created).n;
const NETWORK_ERR_RE = /net::ERR_|ERR_CERT|ERR_PROXY|ERR_TUNNEL|ERR_CONNECTION/i;

let apiKey = null;
let fatalErr = null;
sniffedKeys.length = 0;
for (let tryIdx = 0; tryIdx < 3 && !apiKey; tryIdx++) {
  const proxy = proxies.length ? proxies[(allDone + tryIdx) % proxies.length] : null;
  if (tryIdx > 0) log(`${acc.username}: retrying with next proxy (try ${tryIdx + 1})`);
  log(`using proxy: ${proxy ? proxy.replace(/\/\/[^@]*@/, '//***@') : 'none (direct)'}`);
  const browser = await launch({ headless: false, humanize: true, ...(proxy ? { proxy: parseProxy(proxy) } : {}) });
  const page = await browser.newPage();
  // capture full keys from responses (creation POST returns the key once)
  page.on('response', async (res) => {
    try {
      // only the creation POST returns the full key — static JS bundles contain
      // "sk-" strings (sk-image…) that would pollute the list
      if (res.request().method() !== 'POST' || !/gorouter\.app\/api/.test(res.url())) return;
      const body = await res.text().catch(() => null);
      if (!body) return;
      for (const k of [...new Set(body.match(/sk-[A-Za-z0-9_-]{16,}/g) ?? [])]) {
        if (!sniffedKeys.includes(k)) {
          sniffedKeys.push(k);
          log(`  sniffed key ${k.slice(0, 8)}… from ${res.url().slice(0, 60)}`);
        }
      }
    } catch { /* body unavailable */ }
  });
  try {
    await githubLogin(page, acc);

    // gorouter session — click "Continue with GitHub". Existing gorouter accounts
    // (aff sign-up already done) must go through /sign-in — /sign-up OAuth bounces
    // back. Cloudflare Turnstile must complete first. Flaky: retry up to 3×.
    const entryUrl = acc.gorouter === 'registered'
      ? 'https://gorouter.app/sign-in'
      : GOROUTER_URL;
    let oauthOk = false;
    for (let attempt = 1; attempt <= 3 && !oauthOk; attempt++) {
      await page.goto(entryUrl, { waitUntil: 'load' });
      await page.waitForSelector('text=Continue with GitHub', { timeout: 20000 }).catch(() => {});
      for (let i = 0; i < 25; i++) {
        const ready = await page.evaluate(() => {
          const t = document.querySelector('input[name="cf-turnstile-response"]');
          return !t || t.value.length > 10; // widget absent or solved
        });
        if (ready) break;
        await sleep(1000);
      }
      await sleep(8000); // turnstile needs a few extra seconds before the click lands
      await page.getByText(/Continue with GitHub|Sign in with GitHub/i).first()
        .click({ timeout: 10000 })
        .catch(async () => {
          await page.evaluate(() => {
            const b = [...document.querySelectorAll('button,a,input[type=submit]')]
              .find((b) => /continue with github|sign in with github/i.test(b.textContent || b.value || ''));
            b?.click();
          });
        });
      for (let i = 0; i < 12; i++) {
        await sleep(1500);
        // OAuth may navigate in-tab OR popup — watch all pages. /oauth/github?code=…
        // is a MID-REDIRECT url, not a real session — only console pages count.
        let done = false;
        for (const p of page.context().pages()) {
          const u = p.url();
          if (/github\.com\/login\/oauth\/authorize/.test(u)) {
            await p.evaluate(() => {
              [...document.querySelectorAll('button,input[type=submit]')]
                .find((b) => /^authorize/i.test((b.textContent || b.value || '').trim()))?.click();
            }).catch(() => {});
          }
          if (/gorouter\.app/.test(u) && !/sign-up|sign-in|\/oauth\//.test(u)) { done = true; }
        }
        if (done) { oauthOk = true; break; }
      }
      if (!oauthOk) log(`${acc.username}: OAuth attempt ${attempt} failed — retrying`);
    }
    await sleep(2000);
    if (!oauthOk) {
      await dumpState(page, `${acc.username}-oauth-stuck`);
      throw new Error(`gorouter OAuth did not complete: ${page.url()}`);
    }
    log(`${acc.username}: gorouter session ready → ${page.url()}`);
    // gorouter account now exists — flag it so future runs use /sign-in
    db.prepare("UPDATE accounts SET gorouter='registered' WHERE username=?").run(acc.username);

    apiKey = await keysFlow(page, acc);
    db.prepare('UPDATE accounts SET gorouter=?, gorouter_api_key=? WHERE username=?')
      .run('registered', apiKey, acc.username);
    log(`${acc.username}: API KEY SAVED to accounts.db`);
  } catch (e) {
    const msg = e.message.split('\n')[0];
    fatalErr = msg;
    log(`${acc.username}: FAILED (try ${tryIdx + 1}) — ${msg}`);
    if (!NETWORK_ERR_RE.test(msg)) break; // non-network failure — proxy won't help
  } finally {
    await browser.close().catch(() => {});
  }
  await sleep(5000);
}
if (!apiKey) process.exitCode = 1;
