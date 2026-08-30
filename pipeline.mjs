// pipeline.mjs — full account lifecycle in ONE browser per account:
//   1. register GitHub (email/username/password/country → Create account →
//      Resend OTP → launch-code) — DataDome slider pauses for human
//   2. still logged in: gorouter aff sign-up → GitHub OAuth → API key
//   3. same for tabitoken
//   4. DB: status='registered', gorouter/tabitoen flags + api keys
// Proxy: random from proxies.txt per account; paced 3 signups per 240s.
//
// Usage: node pipeline.mjs [count]   (default: loop until no unregistered left)
import { launch } from 'cloakbrowser';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = fileURLToPath(new URL('./accounts.db', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout=10000'); // concurrent writers wait instead of failing
db.exec('PRAGMA journal_mode=WAL'); // readers never block writers — multi-instance safe

// SITES — the two targets
const SITES = [
  { name: 'gorouter', register: 'https://gorouter.app/sign-up?aff=Jju8', signin: 'https://gorouter.app/sign-in', origin: 'https://gorouter.app', keyPage: '/keys', keyStyle: 'newapi' },
  { name: 'tabitoken', register: 'https://tabitoken.com/sign-up?aff=fPbO', signin: 'https://tabitoken.com/sign-in', origin: 'https://tabitoken.com', keyPage: '/keys', keyStyle: 'newapi' }, // revived 2026-08-30
];

// log — timestamped progress line
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// loadEnv — RESEND_API_KEY from .env (read-only, never echoed)
function loadEnv() {
  return Object.fromEntries(
    fs.readFileSync(fileURLToPath(new URL('./.env', import.meta.url)), 'utf8')
      .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
  );
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

// setStatus — update one row's status
function setStatus(username, status) {
  db.prepare('UPDATE accounts SET status=? WHERE username=?').run(status, username);
}

// pickAccount — next unregistered row, username order so user0001 goes first.
// optional name filter → parallel instances can each work a different account.
function pickAccount(only) {
  // named account: allow registered too (retry run for the sites/keys phase)
  if (only) return db.prepare("SELECT * FROM accounts WHERE username=? AND status IN ('unregistered','registered')").get(only);
  const from = process.env.FROM, to = process.env.TO;
  if (from && to) {
    return db.prepare("SELECT * FROM accounts WHERE status='unregistered' AND username>=? AND username<=? ORDER BY username LIMIT 1").get(from, to);
  }
  return db.prepare("SELECT * FROM accounts WHERE status='unregistered' ORDER BY username LIMIT 1").get();
}

// latestEmailTime — newest GitHub email for `to` (baseline for freshness)
async function latestEmailTime(to) {
  const H = { Authorization: `Bearer ${loadEnv().RESEND_API_KEY}` };
  const r = await fetch('https://api.resend.com/emails/receiving', { headers: H });
  if (!r.ok) return new Date(0);
  const { data } = await r.json();
  const hit = (data ?? []).find((e) => (e.to ?? []).includes(to) && /github/i.test(e.from));
  return hit ? new Date(hit.created_at) : new Date(0);
}

// pollOtp — Resend inbound: 8-digit GitHub launch code newer than `since`.
// GitHub often re-issues the SAME code across attempts — anything newer than
// the pre-submit baseline is valid, even if sent minutes ago.
async function pollOtp(to, since) {
  const H = { Authorization: `Bearer ${loadEnv().RESEND_API_KEY}` };
  const deadline = Date.now() + 240_000;
  await sleep(2500);
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
        const code =
          raw.match(/entering the code below:?\s*(\d{8})/i)?.[1] ??
          raw.match(/launch code[^0-9]{0,60}(\d{8})/i)?.[1] ??
          raw.match(/\b(\d{8})\b/)?.[1];
        if (code) return code;
        throw new Error('GitHub email found but no 8-digit code in body');
      }
    }
    log(`  otp poll round done (nothing yet)`);
    await sleep(5_000);
  }
  throw new Error('OTP not received within 4 minutes');
}

// hasChallenge — DataDome interstitial present?
const hasChallenge = (page) =>
  page.evaluate(() => {
    const frameHit = [...document.querySelectorAll('iframe')]
      .some((f) => /captcha-delivery|datadome|arkose|hcaptcha|recaptcha|turnstile/i.test(f.src));
    const textHit = /verify your account|unusual activity|prove you are human|complete these steps|are you a robot/i.test(document.body.innerText);
    return { hit: frameHit || textHit, src: frameHit ? 'iframe' : textHit ? 'text' : null };
  });

// waitForForm — wait for selector; visible challenge → screenshot + PAUSE for
// human (max 15 min). Form presence is the real gate, not leftover iframes.
async function waitForForm(page, username, step, formSelector) {
  let marked = false;
  for (let i = 0; i < 450; i++) {
    if (await page.$(formSelector)) return;
    const c = await hasChallenge(page).catch(() => null);
    if (c && c.hit && !marked) {
      marked = true;
      await page.screenshot({ path: `captcha-WAIT-${step}-${username}.png` });
      // un-hide Chromium so the human can actually SEE and slide the challenge
      try { execSync('osascript -e "tell application \"System Events\" to set visible of process \"Chromium\" to true"', { stdio: 'ignore' }); } catch {}
      log(`${username}: ⚠ CAPTCHA at ${step} (${c.src}) — WINDOW UNHIDDEN, waiting for human slide`);
    }
    await sleep(2000);
  }
  throw new Error(`${step}: form "${formSelector}" never rendered within 15 minutes`);
}

// typeInto — page.fill (daemon-proven; CloakBrowser humanized typing flakes)
async function typeInto(page, selector, text) {
  await page.fill(selector, text, { timeout: 15000 });
}

// selectCountry — country dropdown → row's region (US proxy ⇒ United States)
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
    document.querySelector('#country-dropdown-panel-button')?.textContent ?? '');
  if (!ok || !shown.toLowerCase().includes(region.slice(0, 6).toLowerCase()))
    throw new Error(`could not select region "${region}" (got: ${shown})`);
}

// registerGithub — signup form → Create account → OTP → launch-code → dashboard
async function registerGithub(page, acc, baseline) {
  await page.goto('https://github.com/signup?source=form-home-signup', { waitUntil: 'load' });
  await waitForForm(page, acc.username, 'signup-gate', '#email');
  await sleep(1500);
  await typeInto(page, '#email', acc.email);
  await sleep(400);
  await typeInto(page, '#login', acc.username);
  await sleep(400);
  await typeInto(page, '#password', acc.password);
  // country auto-detected from proxy IP (Vietnam) — do NOT touch the dropdown

  // cookie banner may overlay the button — dismiss first, then trusted click
  for (const t of ['Accept', 'Reject']) {
    const banner = page.locator(`button:has-text("${t}")`).first();
    if (await banner.isVisible().catch(() => false)) { await banner.click().catch(() => {}); break; }
  }
  await sleep(500);
  // pre-submit: GitHub shows inline "already associated"/"not available" when
  // the account exists from an earlier partial run — skip to next account
  await sleep(1500);
  const taken = await page.evaluate(() => {
    const t = document.body.innerText;
    const email = /already associated with an account/i.test(t);
    const uname = /is not available/i.test(t);
    return { email, uname };
  }).catch(() => null);
  if (taken && (taken.email || taken.uname)) {
    // GitHub says taken — but a wedged pending-signup ALSO shows this while the
    // profile 404s. Only a live profile earns 'registered'; otherwise the
    // email is burned → 'poisoned', excluded from every queue forever.
    const exists = await fetch('https://github.com/' + acc.username).then((r) => r.status).catch(() => 0);
    if (exists === 200) {
      setStatus(acc.username, 'registered');
      throw new Error(`SKIP-TAKEN: account exists (profile 200)`);
    }
    setStatus(acc.username, 'poisoned');
    throw new Error(`POISONED: signup says taken but profile ${exists} — email burned, skipping forever`);
  }

  // submit — evaluate click (daemon-proven); button must be enabled first
  let submitted = false;
  for (let clickTry = 0; clickTry < 3 && !submitted; clickTry++) {
    const res = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button,input')]
        .find((b) => /^create account/i.test((b.textContent || b.value || '').trim()));
      if (!b) return { found: false };
      if (b.disabled) return { found: true, disabled: true };
      b.click();
      return { found: true, disabled: false };
    }).catch(() => ({ found: false, err: true }));
    log(`${acc.username}: click try ${clickTry + 1} → ${JSON.stringify(res)}`);
    if (res.found && res.disabled) { await sleep(2000); continue; }
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      if (!/\/signup/.test(page.url())) { submitted = true; break; }
    }
  }
  if (!submitted) {
    // last resort: Enter on the password field triggers form submit
    await page.focus('#password').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      if (!/\/signup/.test(page.url())) { submitted = true; break; }
    }
  }
  await sleep(2000);
  if (/\/signup/.test(page.url())) {
    const t = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: `fail-submit-${acc.username}.png` });
    const reason =
      t.match(/too many requests|secondary rate limit|abuse detection/i)?.[0] ??
      t.match(/already (taken|used)|invalid[^.]{0,60}|error[^.]{0,60}/i)?.[0] ??
      'unknown reason';
    throw new Error(`stayed on signup — ${reason}`);
  }

  // OTP → 8 launch-code boxes (auto-submit)
  await waitForForm(page, acc.username, 'verify', '#launch-code-0');
  const code = await pollOtp(acc.email, baseline);
  log(`${acc.username}: OTP ${code} received`);
  await sleep(1500);
  // value + input event — proven auto-submit path from the daemon session
  const typed = await page.evaluate((c) => {
    try {
      c.split('').forEach((d, i) => {
        const el = document.getElementById('launch-code-' + i);
        el.focus(); el.value = d;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return 'filled';
    } catch (e) { return 'err: ' + e.message; }
  }, code).catch((e) => 'eval-err: ' + e.message);
  log(`${acc.username}: launch-code fill → ${typed}`);
  await page.waitForURL(/login|dashboard/, { timeout: 30000 }).catch(() => {});
  await sleep(800);
  const url = page.url();
  // strict proof: meta[user-login] exists ONLY when signed in — bare github.com/
  // also occurs logged-out and previously false-flagged failed registrations
  const signedIn = await page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content ?? null).catch(() => null);
  if (!signedIn) {
    // no session after verify — normal variant: GitHub creates the account but
    // bounces to /login. The profile page decides: 200 = registered (the
    // caller's loginIfNeeded signs us in); 404 = truly failed, retryable.
    const code = await fetch('https://github.com/' + acc.username).then((r) => r.status).catch(() => 0);
    if (code !== 200) {
      await page.screenshot({ path: `fail-verify-${acc.username}.png` });
      setStatus(acc.username, 'unregistered');
      throw new Error(`registration incomplete — profile ${code}`);
    }
    setStatus(acc.username, 'registered');
    log(`${acc.username}: GITHUB CREATED (profile 200, no session — login next)`);
    return;
  }
  // decisive existence check: pending-verification sessions ALSO carry the
  // user-login meta while the account itself was never created — only a live
  // profile page proves creation
  const exists = await fetch('https://github.com/' + acc.username).then((r) => r.status).catch(() => 0);
  if (exists !== 200) {
    await page.screenshot({ path: `fail-noprofile-${acc.username}.png` });
    setStatus(acc.username, 'unregistered');
    throw new Error(`registration incomplete — profile ${exists}`);
  }
  setStatus(acc.username, 'registered');
  log(`${acc.username}: GITHUB REGISTERED (user-login=${signedIn})`);
}


// pollDeviceOtp — 6-digit GitHub device-verification code from Resend
async function pollDeviceOtp(to, since) {
  const H = { Authorization: `Bearer ${loadEnv().RESEND_API_KEY}` };
  const deadline = Date.now() + 240_000;
  await sleep(2500);
  while (Date.now() < deadline) {
    const r = await fetch('https://api.resend.com/emails/receiving', { headers: H });
    if (r.ok) {
      const { data } = await r.json();
      const hit = (data ?? [])
        .filter((e) => (e.to ?? []).includes(to) && /github/i.test(e.from) && new Date(e.created_at) > since)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (hit) {
        const full = await fetch(`https://api.resend.com/emails/receiving/${hit.id}`, { headers: H }).then((x) => x.json());
        const code = (full.text ?? '').match(/\b(\d{6})\b/)?.[1];
        if (code) return code;
      }
    }
    await sleep(5_000);
  }
  throw new Error('device OTP not received');
}

// loginIfNeeded — after registration GitHub sometimes bounces to /login;
// sign in with creds (device OTP handled) so the session is ready for sites
async function loginIfNeeded(page, acc) {
  // fresh registration ends on dashboard — nothing to do; otherwise ALWAYS
  // go through github.com/login explicitly (retry runs start on about:blank)
  if (/github\.com\/dashboard/.test(page.url())) return;
  log(`${acc.username}: github login`);
  await page.goto('https://github.com/login', { waitUntil: 'load' });
  const baseline = await latestEmailTime(acc.email);
  await page.fill('#login_field', acc.username);
  await page.fill('#password', acc.password);
  await page.evaluate(() => {
    [...document.querySelectorAll('input[type=submit],button')]
      .find((b) => /sign in/i.test(b.value || b.textContent || ''))?.click();
  });
  await sleep(2500);
  if (/sessions\/verified-device/.test(page.url())) {
    log(`${acc.username}: device verification`);
    const code = await pollDeviceOtp(acc.email, baseline);
    log(`${acc.username}: device OTP ${code}`);
    await page.fill('input[name="otp"]', code);
    await page.keyboard.press('Enter');
    await sleep(3000);
  }
  const url = page.url();
  const who = await page.evaluate(() => document.querySelector('meta[name="user-login"]')?.content ?? null).catch(() => null);
  if (!who) {
    await page.screenshot({ path: `fail-login-${acc.username}.png` });
    // login failed — if the account is not on GitHub at all, revert so it can
    // be re-created instead of being stranded as a phantom 'registered' row
    const exists = await fetch('https://github.com/' + acc.username).then((r) => r.status).catch(() => 0);
    if (exists === 404) {
      setStatus(acc.username, 'unregistered');
      db.prepare("UPDATE accounts SET gorouter=NULL, tabitoken=NULL WHERE username=?").run(acc.username);
      log(`${acc.username}: account 404 — reverted to unregistered`);
    }
    throw new Error(`login failed, no session (${url})`);
  }
  log(`${acc.username}: logged in as ${who}`);
}

// oauthViaGithub — site page: GitHub button → watch redirects.
// Hard 60s cap via Promise.race: any internal hang (headless turnstile click
// no-op etc.) rejects and the caller falls through instead of freezing the run.
async function oauthViaGithub(page, acc, site, entryUrl) {
  log(`  oauth: goto ${entryUrl}`);
  const attempt = (async () => {
  await page.goto(entryUrl, { waitUntil: 'load', timeout: 30000 }).catch((e) => log(`  oauth goto-err ${e.message.split('\n')[0]}`));
  await page.waitForSelector('text=Continue with GitHub', { timeout: 20000 }).catch(() => {});
  await sleep(1500); // hydration only — turnstile NOT required for GitHub button
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
      // flagged accounts cannot authorize third-party apps — bail out fast
      const flagged = await p.evaluate(() => /account is flagged/i.test(document.body.innerText)).catch(() => false);
      if (flagged) return 'flagged';
      if (u.startsWith(site.origin) && !/register|sign-up|sign-in|\/oauth\/|\/login/i.test(u)) done = true;
    }
    if (done) return true;
  }
  return false;
  })();
  return Promise.race([
    attempt,
    new Promise((_, rej) => setTimeout(() => rej(new Error('oauth 120s hard-timeout')), 120_000)),
  ]);
}

// waitForSelector — poll up to timeoutMs
async function waitForSelector(page, selector, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.$(selector)) return true;
    await sleep(1000);
  }
  return false;
}

// newApiKeyFlow — create key on /keys, capture full key (sniff → clipboard)
async function newApiKeyFlow(page, acc, site, sniffedKeys) {
  await page.goto(site.origin + site.keyPage, { waitUntil: 'load' });
  await sleep(1200);
  const keyName = `${acc.username}-${site.name}`;
  const existing = await page.evaluate((n) =>
    [...document.querySelectorAll('tr')].some((r) => r.textContent.includes(n)), keyName);
  if (existing) {
    log(`${acc.username}/${site.name}: key already in table`);
  } else {
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
    await sleep(2000);
    await page.click('input[name="name"]');
    await page.type('input[name="name"]', keyName, { delay: 30 });
    await sleep(400);
    // group is REQUIRED — open dropdown, wait for portal options, pick
    // "default" (or first non-empty), VERIFY button no longer says
    // "Select a group" before saving
    const groupState = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((b) => /select a group/i.test((b.textContent || '').trim()));
      if (!b) return 'no-dropdown';
      b.click();
      return 'opened';
    });
    if (groupState === 'opened') {
      let picked = false;
      for (let gi = 0; gi < 10 && !picked; gi++) {
        await sleep(600);
        picked = await page.evaluate(() => {
          const els = [...document.querySelectorAll('[role=option],li,[cmdk-item]')]
            .filter((e) => (e.textContent || '').trim());
          if (!els.length) return false;
          const want = els.find((e) => /default/i.test(e.textContent)) ?? els[0];
          want.click();
          return true;
        });
      }
      await sleep(600);
      const btnNow = await page.evaluate(() =>
        [...document.querySelectorAll('button')]
          .find((b) => /select a group/i.test((b.textContent || '').trim()))?.textContent?.trim() ?? null);
      if (btnNow) {
        await page.screenshot({ path: `sites-fail-group-${site.name}-${acc.username}.png` });
        throw new Error(`group not selected (button still: ${btnNow})`);
      }
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

  // PRIMARY capture: intercept the UI's OWN /key XHR via page.route — the
  // app's request carries real auth (httpOnly cookie); route.fetch gives us
  // the response body without clipboard or auth replication.
  {
    let captured = null;
    await page.route('**/api/token/*/key', async (route) => {
      try {
        const resp = await route.fetch();
        const body = await resp.text();
        // keys come BARE in data.key (no sk- prefix on these sites)
        let m = body.match(/sk-[A-Za-z0-9_-]{16,}/);
        if (!m) {
          try { const k = JSON.parse(body)?.data?.key; if (k && /^[A-Za-z0-9_-]{20,}$/.test(k)) m = ['sk-' + k]; } catch {}
        }
        if (m) captured = m[0];
        await route.fulfill({ response: resp });
      } catch { await route.continue().catch(() => {}); }
    }).catch(() => {});
    // click every key-cell button — one of them fires the /key XHR
    const btnCount = await page.evaluate(() =>
      document.querySelector('td[data-column-id="key"]')?.querySelectorAll('button').length ?? 0);
    for (let bi = 0; bi < btnCount && !captured; bi++) {
      await page.locator('td[data-column-id="key"] button').nth(bi).click({ timeout: 5000 }).catch(() => {});
      for (let i = 0; i < 5 && !captured; i++) await sleep(600);
      // second level: the cell button opens a popover/menu — click every
      // newly-visible action inside it (the copy action fires the /key XHR)
      if (!captured) {
        await page.evaluate(() => {
          const layers = [...document.querySelectorAll('[role=dialog],[role=menu],[data-slot*=popover] *, [data-radix-popper-content-wrapper] *')];
          const btns = layers.filter((e) => e.tagName === 'BUTTON' && e.offsetParent !== undefined);
          btns.slice(0, 6).forEach((b) => b.click());
        }).catch(() => {});
        for (let i = 0; i < 8 && !captured; i++) await sleep(600);
      }
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);
    }
    await page.unroute('**/api/token/*/key').catch(() => {});
    if (captured) {
      log(`${acc.username}/${site.name}: key via route-intercept`);
      return captured;
    }
    log(`${acc.username}/${site.name}: route-intercept missed (buttons=${btnCount})`);
  }
  let apiKey = sniffedKeys[sniffedKeys.length - 1] ?? null;
  if (apiKey) {
    log(`${acc.username}/${site.name}: key captured from creation response`);
    return apiKey;
  }
  // clipboard-free capture: the creation POST response carries the FULL key —
  // if the first attempt's sniff raced, create another key (distinct name) and
  // sniff again, up to 3 attempts. No OS clipboard (global, race-prone).
  // reveal path: clicking the masked-key button triggers a GET that returns
  // the FULL key — sniff catches it (no clipboard involved)
  if (!apiKey) {
    const btnCount = await page.evaluate(() =>
      document.querySelector('td[data-column-id="key"]')?.querySelectorAll('button').length ?? 0);
    for (let bi = 0; bi < btnCount && !sniffedKeys.length; bi++) {
      await page.locator('td[data-column-id="key"] button').nth(bi).click({ timeout: 5000 }).catch(() => {});
      for (let i = 0; i < 6 && !sniffedKeys.length; i++) await sleep(700);
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);
    }
    apiKey = sniffedKeys[sniffedKeys.length - 1] ?? null;
    if (apiKey) log(`${acc.username}/${site.name}: key captured via reveal GET`);
  }
  for (let attempt = 2; attempt <= 3 && !sniffedKeys.length; attempt++) {
    const retryName = `${acc.username}-${site.name}-${attempt}`;
    log(`${acc.username}/${site.name}: sniff empty — creating ${retryName}`);
    let opened = false;
    for (let i = 0; i < 20 && !opened; i++) {
      opened = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button,a')]
          .find((b) => /^create api key$/i.test((b.textContent || '').trim()));
        if (!b) return false;
        b.click();
        return true;
      });
      if (!opened) await sleep(1000);
    }
    if (!opened) break;
    await waitForSelector(page, 'input[name="name"]');
    await sleep(800);
    await page.click('input[name="name"]');
    await page.type('input[name="name"]', retryName, { delay: 30 });    await sleep(400);
    // group REQUIRED — open dropdown, wait for options, pick default/first,
    // verify button no longer reads "Select a group"
    {
      const groupState = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')]
          .find((b) => /select a group/i.test((b.textContent || '').trim()));
        if (!b) return 'no-dropdown';
        b.click();
        return 'opened';
      });
      if (groupState === 'opened') {
        let picked = false;
        for (let gi = 0; gi < 10 && !picked; gi++) {
          await sleep(600);
          picked = await page.evaluate(() => {
            const els = [...document.querySelectorAll('[role=option],li,[cmdk-item]')]
              .filter((e) => (e.textContent || '').trim());
            if (!els.length) return false;
            const want = els.find((e) => /default/i.test(e.textContent)) ?? els[0];
            want.click();
            return true;
          });
        }
        await sleep(600);
        const btnNow = await page.evaluate(() =>
          [...document.querySelectorAll('button')]
            .find((b) => /select a group/i.test((b.textContent || '').trim()))?.textContent?.trim() ?? null);
        if (btnNow) {
          await page.screenshot({ path: `sites-fail-group-${site.name}-${acc.username}.png` });
          throw new Error(`group not selected (button still: ${btnNow})`);
        }
      }
    }
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((b) => /^save changes$/i.test((b.textContent || '').trim()));
      b?.click();
    });
    for (let i = 0; i < 12 && !sniffedKeys.length; i++) await sleep(1000);
    apiKey = sniffedKeys[sniffedKeys.length - 1] ?? null;
  }
    if (!apiKey) {
    await page.screenshot({ path: `sites-fail-key-${site.name}-${acc.username}.png` });
    throw new Error('could not capture API key');
  }
  return apiKey;
}


// pickLRU — the eligible proxy with the OLDEST last-used timestamp
function pickLRU(list, state, cooling) {
  const eligible = list.filter((p) => !cooling(p));
  if (!eligible.length) return null;
  const oldest = Math.min(...eligible.map((p) => state[p] ?? 0));
  const tied = eligible.filter((p) => (state[p] ?? 0) === oldest);
  return tied[Math.floor(Math.random() * tied.length)]; // random among least-used
}

// proxyState — persistent global last-used map (proxy-state.json) so ALL
// processes pick the LEAST-recently-used proxy instead of random re-use
function loadProxyState() {
  try { return JSON.parse(fs.readFileSync(fileURLToPath(new URL('./proxy-state.json', import.meta.url)), 'utf8')); }
  catch { return {}; }
}
function saveProxyState(st) {
  try {
    const f = fileURLToPath(new URL('./proxy-state.json', import.meta.url));
    fs.writeFileSync(f + '.tmp', JSON.stringify(st));
    fs.renameSync(f + '.tmp', f);
  } catch { /* best-effort */ }
}

// runAccount — full lifecycle, ONE browser
async function runAccount(acc, proxies) {
  log(`pipeline: ${acc.username} (${acc.email})`);
  // proxy pick: avoid proxies in rate-limit cooldown (10 min); pinned
  // PROXY_IDX falls back to rotation when its proxy is cooling
  const idxEnv = process.env.PROXY_IDX;
  const cooling = (p) => (proxyCooldowns.get(p ?? 'direct') ?? 0) > Date.now();
  // least-recently-used pick (global, cross-process): the proxy idle the
  // longest is the safest against per-IP rate limits
  const state = loadProxyState();
  let proxy;
  if (idxEnv !== undefined) {
    const pinned = proxies[Number(idxEnv) % Math.max(proxies.length, 1)] ?? null;
    proxy = cooling(pinned)
      ? pickLRU(proxies, state, cooling)
      : pinned;
  } else {
    proxy = pickLRU(proxies, state, cooling);
  }
  if (proxy) { state[proxy] = Date.now(); saveProxyState(state); }
  acc.__proxy = proxy ?? 'direct';
  log(`proxy: ${proxy ? proxy.replace(/\/\/[^@]*@/, '//***@') : 'direct'}`);
  // per-proxy window: only wait if THIS proxy did WINDOW_MAX signups in 240s
  const times = signupTimesByProxy.get(proxy ?? 'direct') ?? [];
  const now = Date.now();
  while (times.length && now - times[0] > WINDOW_MS) times.shift();
  if (times.length >= WINDOW_MAX) {
    const wait = WINDOW_MS - (now - times[0]) + 5_000;
    log(`window full on this proxy (${times.length}/${WINDOW_MAX}) — waiting ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  const browser = await launch({ // humanize off — speed; C++ fingerprint unaffected
    headless: false, // headless broke gorouter turnstile/OAuth — headful required
    humanize: false,
    ...(proxy ? { proxy: parseProxy(proxy) } : {}),
  });
  // keep headful but out of the way: hide Chromium app (stays fully functional)
  try { execSync('osascript -e "tell application \"Chromium\" to hide"', { stdio: 'ignore' }); } catch { /* non-mac / not-yet-launched */ }
  const page = await browser.newPage();
  try {
    // 1. github registration (ends logged in on dashboard) — skip when the
    //    account already exists (retry runs for the sites phase only)
    if (acc.status === 'unregistered') {
      // count this signup attempt against THIS proxy's window (actual moment)
      const t = signupTimesByProxy.get(proxy ?? 'direct') ?? [];
      t.push(Date.now());
      signupTimesByProxy.set(proxy ?? 'direct', t);
      const baseline = await latestEmailTime(acc.email);
      log(`${acc.username}: email baseline ${baseline.toISOString()}`);
      await registerGithub(page, acc, baseline);
    }
    await loginIfNeeded(page, acc);

    // 2-3. both sites in the same session, one tab reused sequentially
    for (const site of SITES) {
      const tag = `${acc.username}/${site.name}`;
      try {
        const entryUrl = acc[site.name] === 'registered' ? site.signin : site.register;
        let ok = await oauthViaGithub(page, acc, site, entryUrl);
        if (ok !== true && ok !== 'flagged') {
          const alt = acc[site.name] === 'registered' ? site.register : site.signin;
          ok = await oauthViaGithub(page, acc, site, alt);
          if (ok !== true && ok !== 'flagged') {
            await page.screenshot({ path: `sites-${site.name}-stuck-${acc.username}.png` });
            throw new Error(`OAuth did not complete`);
          }
        }
        if (ok === 'flagged') {
          db.prepare(`UPDATE accounts SET ${site.name}='flagged' WHERE username=?`).run(acc.username);
          log(`${tag}: FLAGGED — cannot authorize third-party apps, skipped`);
          continue;
        }
        await sleep(1000);
        db.prepare(`UPDATE accounts SET ${site.name}='registered' WHERE username=?`).run(acc.username);
        log(`${tag}: registered → ${page.url()}`);

        const sniffedKeys = [];
        page.on('response', async (res) => {
          try {
            if (process.env.SNIFF_DEBUG) fs.appendFileSync('/tmp/sniff-debug.log', `[${site.name}] ${res.request().method()} ${res.status()} ${res.url().slice(0, 100)}\n`);
            if (!res.url().startsWith(site.origin) || !res.url().includes('/api/')) return;
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
        const apiKey = await newApiKeyFlow(page, acc, site, sniffedKeys);
        // dupe guard: a key already owned by ANOTHER row means cross-capture —
        // reject and fail loudly so the account retries with fresh capture
        const dupe = db.prepare(`SELECT username FROM accounts WHERE ${site.name}_api_key=? AND username!=?`).get(apiKey, acc.username);
        if (dupe) throw new Error(`key collision with ${dupe.username} — capture rejected`);
        db.prepare(`UPDATE accounts SET ${site.name}='registered', ${site.name}_api_key=? WHERE username=?`).run(apiKey, acc.username);
        log(`${tag}: API KEY SAVED`);
      } catch (e) {
        log(`${tag}: FAILED — ${e.message.split('\n')[0]}`);
      }
      await sleep(2500);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return proxy ?? 'direct';
}

// main — pacing: 3 signups per 240s (proxy IP rotation window), human slider
loadEnv(); // validates RESEND_API_KEY presence early
const proxies = loadProxies();
const maxCount = Number(process.argv[2] ?? Infinity);
const only = process.argv[3] ?? null; // optional specific username for parallel runs
const WINDOW_MS = 240_000;
const WINDOW_MAX = 3; // per PROXY — each proxy rotates its IP every 240s
const signupTimesByProxy = new Map(); // proxy string → [timestamps]
const proxyCooldowns = new Map(); // proxy string → rate-limit cooldown until ts
let done = 0;
let rateStreak = 0;
const failed = new Set(); // hard-failed usernames — never re-picked (no infinite loop)
const fromU = process.env.FROM ?? 'user0001listingstudio';
const toU = process.env.TO ?? 'user9999listingstudio';

// race guard: release in-flight rows left by dead instances — ONLY when we are
// the sole pipeline process (a sweep while siblings run could steal their row)
let instCount = 1;
try { instCount = execSync("ps aux | grep 'node pipeline.mjs' | grep -v grep | wc -l", { shell: '/bin/zsh' }).toString().trim() * 1 || 1; } catch {}
if (instCount <= 1) {
  const sweep = db.prepare("UPDATE accounts SET status='unregistered' WHERE status='in-flight'").run();
  if (sweep.changes) log(`swept ${sweep.changes} stale in-flight rows back to unregistered`);
}

// named mode targets EXACTLY that account (registered rows allowed — full
// retry incl. site keys). Queue mode walks the range.
const queue = only
  ? [only]
  : db.prepare("SELECT username FROM accounts WHERE status='unregistered' AND username>=? AND username<=? ORDER BY username").all(fromU, toU).map((r) => r.username);
log(only ? `named target: ${only}` : `queue: ${queue.length} accounts in range ${fromU}..${toU}`);
while (done < maxCount) {
  const nextIdx = queue.findIndex((u) => !failed.has(u));
  if (nextIdx < 0) { log('queue exhausted (all unregistered rows tried)'); break; }
  const nextName = queue[nextIdx];
  queue.splice(nextIdx, 1); // pop — processed names never re-run
  // read the row BEFORE claiming — after the claim its status is 'in-flight'
  // and the register-vs-skip decision would wrongly skip registration
  const acc = db.prepare('SELECT * FROM accounts WHERE username=?').get(nextName);
  if (!acc || !['unregistered', 'registered'].includes(acc.status)) { continue; }
  // atomic claim — exactly one instance can flip unregistered→in-flight
  const claim = db.prepare("UPDATE accounts SET status='in-flight' WHERE username=? AND status='unregistered'").run(nextName);
  if (!claim.changes && acc.status === 'unregistered') { log(`${nextName}: claimed elsewhere — skip`); continue; }
  try {
    acc.__proxy = await runAccount(acc, proxies);
    rateStreak = 0;
    done++;
  } catch (e) {
    const msg = e.message.split('\n')[0];
    if (/SKIP-TAKEN/.test(msg)) {
      log(`${acc.username}: account exists from earlier run — marked registered`);
      rateStreak = 0;
      if (only) {
        // named full-pipeline run: DON'T consume the shot — re-run as a
        // registered row so login + site keys still execute
        const fresh = db.prepare("SELECT * FROM accounts WHERE username=?").get(only);
        try {
          await runAccount(fresh, proxies);
          done++;
        } catch (e2) {
          log(`${only}: retry FAILED — ${e2.message.split('\n')[0]}`);
        }
        break;
      }
      done++;
      await sleep(3_000);
      continue;
    }
    if (/too many requests|secondary rate limit|abuse detection|RATE LIMITED/i.test(msg)) {
      rateStreak++;
      if (rateStreak >= 5) { log('rate-limited 5× in a row — stopping run'); break; }
      // cool the proxy that got limited; account goes back in the queue HEAD so
      // the very next attempt runs on a different proxy
      const usedProxy = acc.__proxy ?? null;
      if (usedProxy) proxyCooldowns.set(usedProxy, Date.now() + 600_000);
      db.prepare("UPDATE accounts SET status='unregistered' WHERE username=? AND status='in-flight'").run(acc.username);
      queue.unshift(acc.username); // retry same account, fresh proxy
      failed.delete(acc.username);
      log(`${acc.username}: RATE LIMITED — proxy cooled 10 min, retrying on another`);
      await sleep(5_000);
      continue;
    }
    // network-flavored failure = proxy health problem, not the account's fault:
    // cool that proxy and retry the SAME account on a fresh one
    if (/net::ERR_|Timeout 30000ms exceeded|ERR_CERT|ERR_TUNNEL|ERR_CONNECTION|ERR_ABORTED/i.test(msg)) {
      if (acc.__proxy) proxyCooldowns.set(acc.__proxy, Date.now() + 600_000);
      db.prepare("UPDATE accounts SET status='unregistered' WHERE username=? AND status='in-flight'").run(acc.username);
      queue.unshift(acc.username);
      failed.delete(acc.username);
      log(`${acc.username}: proxy flaky (${acc.__proxy?.split('@')[1] ?? '?'}) — cooled, requeue on fresh proxy`);
      await sleep(3_000);
      continue;
    }
    rateStreak = 0;
    failed.add(acc.username);
    db.prepare("UPDATE accounts SET status='unregistered' WHERE username=? AND status='in-flight'").run(acc.username);
    log(`${acc.username}: FAILED — ${msg} (queued out; ${failed.size} failed so far)`);
    await sleep(10_000);
  }
  await sleep(3_000);
  if (only) break; // named mode: exactly one attempt, then exit
}
log(`pipeline complete — ${done} accounts processed this run`);
log(`summary: registered=${db.prepare("SELECT COUNT(*) AS c FROM accounts WHERE status='registered'").get().c}, unregistered=${db.prepare("SELECT COUNT(*) AS c FROM accounts WHERE status='unregistered'").get().c}`);
