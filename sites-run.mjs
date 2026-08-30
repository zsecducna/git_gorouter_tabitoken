// sites-run.mjs — register one GitHub account on all 4 target sites and create
// an API key on each. ONE browser per account, ONE GitHub login (device-OTP via
// Resend when challenged), then per site: aff sign-up URL (or /sign-in if the
// site flag is already set) → turnstile wait → "Continue with GitHub" →
// watch redirect (authorize auto-click) → confirm console → create API key →
// capture full key (creation-POST sniff, clipboard brute-force fallback) → DB.
//
// Usage: node sites-run.mjs <username> [--sites a,b,c] [--keep-open]
import { launch } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = fileURLToPath(new URL('./accounts.db', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new DatabaseSync(DB);

// SITES — new-api stack clones of gorouter (same "Create API Key"/keys UI);
// agentrouter = separate UI, key page/console still to be confirmed live
const SITES = [
  { name: 'gorouter', register: 'https://gorouter.app/sign-up?aff=Jju8', signin: 'https://gorouter.app/sign-in', origin: 'https://gorouter.app', keyPage: '/keys', keyStyle: 'newapi' },
// agentrouter parked per user request — re-enable by uncommenting
// { name: 'agentrouter', register: 'https://agentrouter.org/register?aff=VxVP', signin: 'https://agentrouter.org/login', origin: 'https://agentrouter.org', keyPage: '/console/token', keyStyle: 'unknown' },
  { name: 'tabitoken', register: 'https://tabitoken.com/sign-up?aff=fPbO', signin: 'https://tabitoken.com/sign-in', origin: 'https://tabitoken.com', keyPage: '/keys', keyStyle: 'newapi' },
  // kktoken.cc dropped per user request
  // api.justwoker.icu dropped per user request
];

// log — timestamped progress line
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

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

// loadProxies — proxies.txt; http URL or host:port:user:pass
function loadProxies() {
  const f = fileURLToPath(new URL('./proxies.txt', import.meta.url));
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const p = l.split(':');
      return p.length === 4 ? `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}` : l;
    });
}

// pollDeviceOtp — 6-digit GitHub device-verification code from Resend
async function pollDeviceOtp(to) {
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
        .filter((e) => (e.to ?? []).includes(to) && /github/i.test(e.from) && new Date(e.created_at) > new Date(Date.now() - 10 * 60 * 1000))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (hit) {
        const full = await fetch(`https://api.resend.com/emails/receiving/${hit.id}`, { headers: H }).then((x) => x.json());
        const code = (full.text ?? '').match(/\b(\d{6})\b/)?.[1];
        if (code) return code;
      }
    }
    await sleep(10_000);
  }
  throw new Error('device OTP not received');
}

// dumpState — page facts for debugging
async function dumpState(page, tag) {
  const info = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
    buttons: [...document.querySelectorAll('button,a[role=button],input[type=submit]')]
      .map((b) => (b.textContent || b.value || '').trim()).filter(Boolean).slice(0, 25),
    inputs: [...document.querySelectorAll('input:not([type=hidden]),select')].map((e) => ({ name: e.name || e.id, type: e.type })),
  })).catch(() => null);
  log(`${tag}: ${JSON.stringify(info)}`);
  await page.screenshot({ path: `sites-${tag}.png`, fullPage: true }).catch(() => {});
  return info;
}

// waitForSelector — poll for selector up to timeoutMs
async function waitForSelector(page, selector, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.$(selector)) return true;
    await sleep(1000);
  }
  return false;
}

// githubLogin — login once per browser; device OTP auto-resolved
async function githubLogin(page, acc) {
  await page.goto('https://github.com/login', { waitUntil: 'load' });
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
  await sleep(2500);
  let url = page.url();
  if (/sessions\/verified-device/.test(url)) {
    log(`${acc.username}: device verification — reading OTP`);
    const code = await pollDeviceOtp(acc.email);
    await page.fill('input[name="otp"]', code);
    await page.keyboard.press('Enter');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }).catch(() => {}),
      page.waitForTimeout(2500),
    ]);
    url = page.url();
    log(`${acc.username}: device verify → ${url}`);
  }
  if (!/github\.com\/?$|dashboard/.test(url)) {
    const errText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 250)).catch(() => '');
    await page.screenshot({ path: `sites-fail-ghlogin-${acc.username}.png` }).catch(() => {});
    throw new Error(`github login failed: ${url} — ${errText}`);
  }
  log(`${acc.username}: github logged in`);
}

// ensureGithubSession — parallel tabs share cookies, but GitHub OAuth sometimes
// still lands on the login interstitial; verify the session in THIS tab and
// (re-)login if the form is showing
async function ensureGithubSession(p, acc) {
  await p.goto('https://github.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(1500);
  if (await p.$('form[action="/session"]')) {
    log(`${acc.username}: tab lost github session — logging in`);
    await p.goto('https://github.com/login', { waitUntil: 'load' });
    await p.click('#login_field');
    await p.type('#login_field', acc.username, { delay: 30 });
    await p.click('#password');
    await p.type('#password', acc.password, { delay: 30 });
    await Promise.all([
      p.waitForNavigation({ waitUntil: 'load', timeout: 45000 }).catch(() => {}),
      p.evaluate(() => {
        [...document.querySelectorAll('input[type=submit],button')]
          .find((b) => /sign in/i.test(b.value || b.textContent || ''))?.click();
      }),
    ]);
    await sleep(2500);
    if (/sessions\/verified-device/.test(p.url())) {
      const code = await pollDeviceOtp(acc.email);
      await p.fill('input[name="otp"]', code);
      await p.keyboard.press('Enter');
      await sleep(2500);
    }
  }
}

// oauthViaGithub — on the site page: turnstile wait, click the GitHub button,
// watch all pages for the console landing (mid-redirect /oauth/ excluded)
async function oauthViaGithub(page, acc, site, entryUrl) {
  await page.goto(entryUrl, { waitUntil: 'load' });
  await page.waitForSelector('text=Continue with GitHub', { timeout: 20000 }).catch(() => {});
  for (let i = 0; i < 25; i++) {
    const ready = await page.evaluate(() => {
      const t = document.querySelector('input[name="cf-turnstile-response"]');
      return !t || t.value.length > 10;
    });
    if (ready) break;
    await sleep(1000);
  }
  await sleep(8000); // turnstile settle — click too early = no-op
  await page.getByText(/Continue with GitHub|Sign in with GitHub/i).first()
    .click({ timeout: 10000 })
    .catch(async () => {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button,a,input[type=submit]')]
          .find((b) => /continue with github|sign in with github|github/i.test(b.textContent || b.value || ''));
        b?.click();
      });
    });
  for (let i = 0; i < 14; i++) {
    await sleep(1500);
    let done = false;
    for (const p of page.context().pages()) {
      const u = p.url();
      if (/github\.com\/login\/oauth\/authorize/.test(u)) {
        await p.evaluate(() => {
          [...document.querySelectorAll('button,input[type=submit]')]
            .find((b) => /^authorize/i.test((b.textContent || b.value || '').trim()))?.click();
        }).catch(() => {});
      }
      if (u.startsWith(site.origin) && !/register|sign-up|sign-in|\/oauth\/|\/login/i.test(u)) { done = true; }
    }
    if (done) return true;
  }
  return false;
}

// newApiKeyFlow — gorouter-clone keys UI: create key, capture full key
async function newApiKeyFlow(page, acc, site, sniffedKeys) {
  await page.goto(site.origin + site.keyPage, { waitUntil: 'load' });
  await sleep(2500);
  const keyName = `${acc.username}-${site.name}`;

  // create (skip only if this site's key name already listed AND db has key)
  const existing = await page.evaluate((n) =>
    [...document.querySelectorAll('tr')].some((r) => r.textContent.includes(n)), keyName);
  if (existing && acc[site.name + '_api_key']) {
    log(`${acc.username}/${site.name}: key already exists`);
    return acc[site.name + '_api_key'];
  }
  if (!existing) {
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
      await page.screenshot({ path: `sites-fail-nokeybtn-${site.name}-${acc.username}.png` });
      throw new Error('Create API Key button not found');
    }
    await waitForSelector(page, 'input[name="name"]');
    await sleep(800);
    await page.click('input[name="name"]');
    await page.type('input[name="name"]', keyName, { delay: 30 });
    await sleep(400);
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
        const opt = [...document.querySelectorAll('[role=option],li')]
          .find((e) => /^default$/i.test((e.textContent || '').trim()))
          ?? [...document.querySelectorAll('[role=option]')][0];
        opt?.click();
      });
      await sleep(500);
    }
    const saved = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((b) => /^save changes$/i.test((b.textContent || '').trim()));
      if (!b) return false;
      b.click();
      return true;
    });
    if (!saved) throw new Error('Save changes button not found');
    for (let i = 0; i < 10 && !sniffedKeys.length; i++) await sleep(1000);
  }

  // full key: sniffed creation response first, clipboard brute-force fallback
  let apiKey = sniffedKeys[sniffedKeys.length - 1] ?? null;
  if (apiKey) {
    log(`${acc.username}/${site.name}: key captured from creation response`);
    return apiKey;
  }
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: site.origin }).catch(() => {});
  apiKey = await page.evaluate(() => {
    const el = [...document.querySelectorAll('td *,code,span')]
      .map((e) => (e.textContent || '').trim())
      .find((t) => /^(sk-|gr-|grt-)[A-Za-z0-9_\-]{8,}$/.test(t));
    return el ?? null;
  });
  if (!apiKey) {
    const btnCount = await page.evaluate(() =>
      document.querySelector('td[data-column-id="key"]')?.querySelectorAll('button').length ?? 0);
    for (let bi = 0; bi < btnCount; bi++) {
      await page.locator('td[data-column-id="key"] button').nth(bi).click({ timeout: 5000 }).catch(() => {});
      await sleep(1200);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
      if (clip && /^(sk-|gr-|grt-)[A-Za-z0-9_\-]{8,}$/.test(clip.trim())) { apiKey = clip.trim(); break; }
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(400);
    }
  }
  if (!apiKey) {
    await page.screenshot({ path: `sites-fail-key-${site.name}-${acc.username}.png` });
    throw new Error('could not capture API key');
  }
  return apiKey;
}

// main
const argv = process.argv.slice(2);
const username = argv.find((a) => !a.startsWith('--'));
if (!username) {
  console.error('usage: node sites-run.mjs <username> [--sites a,b,c] [--keep-open]');
  process.exit(1);
}
const acc = db.prepare("SELECT * FROM accounts WHERE username=? AND status='registered'").get(username);
if (!acc) {
  console.error(`account ${username} not found / not registered`);
  process.exit(1);
}
const sitesFlagIdx = argv.indexOf('--sites');
const onlySites = sitesFlagIdx >= 0 ? argv[sitesFlagIdx + 1].split(',') : SITES.map((s) => s.name);
const proxies = loadProxies();
const allDone = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE status='registered' AND created < ?").get(acc.created).n;
let proxy = proxies.length ? proxies[Math.floor(Math.random() * proxies.length)] : null; // random per run

// SAME browser + SAME proxy for the whole account: github login → per-site tab
let browser = null;
let lastErr = null;
for (let runAttempt = 0; runAttempt < 3; runAttempt++) {
  if (runAttempt > 0) {
    proxy = proxies.length ? proxies[Math.floor(Math.random() * proxies.length)] : null;
    log(`${acc.username}: retrying with new proxy (attempt ${runAttempt + 1})`);
  }
  log(`using proxy: ${proxy ? proxy.replace(/\/\/[^@]*@/, '//***@') : 'direct'}`);
  browser = await launch({ headless: false, humanize: true, ...(proxy ? { proxy: parseProxy(proxy) } : {}) });
  const page = await browser.newPage(); // tab 1 — github login
  let hadNetworkError = false;
  try {
    await githubLogin(page, acc);

    // step 3-4: sequential NEW TAB per site, same browser, same proxy/session
    const results = [];
    for (const site of SITES) {
      if (!onlySites.includes(site.name)) continue;
      if (acc[site.name] === 'registered' && acc[site.name + '_api_key']) {
        log(`${acc.username}/${site.name}: already done, skipping`);
        continue;
      }
      const p = page; // SAME tab — navigate to each ref link one by one
      const tag = `${acc.username}/${site.name}`;
      try {
        const entryUrl = acc[site.name] === 'registered' ? site.signin : site.register;
        const ok = await oauthViaGithub(p, acc, site, entryUrl);
        if (!ok) {
          // second chance: the other entry (sign-in ↔ sign-up)
          const alt = acc[site.name] === 'registered' ? site.register : site.signin;
          const ok2 = await oauthViaGithub(p, acc, site, alt);
          if (!ok2) {
            await dumpState(p, `${site.name}-stuck-${acc.username}`);
            throw new Error(`OAuth did not complete (tried ${entryUrl} + ${alt})`);
          }
        }
        await sleep(2000);
        db.prepare(`UPDATE accounts SET ${site.name}='registered' WHERE username=?`).run(acc.username);
        log(`${tag}: registered → ${p.url()}`);

        if (site.keyStyle === 'unknown') {
          await dumpState(p, `${site.name}-console-${acc.username}`);
          results.push(`${tag}: registered (key flow pending UI probe)`);
          continue;
        }
        const sniffedKeys = [];
        p.on('response', async (res) => {
          try {
            if (res.request().method() !== 'POST' || !res.url().startsWith(site.origin)) return;
            const body = await res.text().catch(() => null);
            if (!body) return;
            for (const k of [...new Set(body.match(/sk-[A-Za-z0-9_-]{16,}/g) ?? [])]) {
              if (!sniffedKeys.includes(k)) {
                sniffedKeys.push(k);
                log(`  sniffed key ${k.slice(0, 8)}… on ${site.name}`);
              }
            }
          } catch { /* body unavailable */ }
        });
        const apiKey = await newApiKeyFlow(p, acc, site, sniffedKeys);
        db.prepare(`UPDATE accounts SET ${site.name}='registered', ${site.name}_api_key=? WHERE username=?`).run(apiKey, acc.username);
        log(`${tag}: API KEY SAVED`);
        results.push(`${tag}: OK`);
      } catch (e) {
        const msg = e.message.split('\n')[0];
        log(`${tag}: FAILED — ${msg}`);
        results.push(`${tag}: FAILED (${msg.slice(0, 60)})`);
        if (/net::ERR_|ERR_CERT|ERR_PROXY|ERR_TUNNEL|ERR_CONNECTION/i.test(msg)) hadNetworkError = true;
      }
    }
    log(`${acc.username}: results — ${results.join(' | ')}`);
    lastErr = null;
    break;
  } catch (e) {
    lastErr = e.message.split('\n')[0];
    log(`${acc.username}: RUN FAILED — ${lastErr}`);
    if (!/net::ERR_|ERR_CERT|ERR_PROXY|ERR_TUNNEL|ERR_CONNECTION/i.test(lastErr)) break;
    hadNetworkError = true;
  } finally {
    await browser.close().catch(() => {});
    browser = null;
  }
  if (!hadNetworkError) break;
  await sleep(5000);
}
if (lastErr) process.exitCode = 1;
log(`${acc.username}: done`);
