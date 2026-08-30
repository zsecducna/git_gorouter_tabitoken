// probe-sites.mjs — for each target site: login GitHub (fresh browser, proxy
// rotation), goto the aff URL, dump the page, click the GitHub OAuth button,
// watch the redirect, dump the final page. Output = per-site UI facts to build
// the real automation.
// Usage: node probe-sites.mjs [username]   (default user4listingstudio)
import { launch } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = fileURLToPath(new URL('./accounts.db', import.meta.url));
const db = new DatabaseSync(DB);
const username = process.argv[2] ?? 'user4listingstudio';
const acc = db.prepare("SELECT * FROM accounts WHERE username=?").get(username);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SITES — name, signup url
const SITES = [
  { name: 'agentrouter', url: 'https://agentrouter.org/register?aff=VxVP' },
  { name: 'tabitoken', url: 'https://tabitoken.com/sign-up?aff=fPbO' },
  { name: 'kktoken', url: 'https://kktoken.cc/sign-up?aff=URdE' },
  { name: 'justwoker', url: 'https://api.justwoker.icu/register?aff=xzQl' },
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

// pollDeviceOtp — 6-digit device-verification code from Resend
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

// dumpState — page facts
async function dumpState(page, tag) {
  const info = await page.evaluate(() => ({
    url: location.href,
    h1: document.querySelector('h1')?.textContent?.trim() ?? null,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 500),
    buttons: [...document.querySelectorAll('button,a[role=button],input[type=submit],a.btn')]
      .map((b) => (b.textContent || b.value || '').trim()).filter((t) => t && t.length < 40).slice(0, 20),
    inputs: [...document.querySelectorAll('input:not([type=hidden]),select')].map((e) => ({ name: e.name || e.id, type: e.type, ph: e.placeholder?.slice(0, 25) })),
  }));
  log(`${tag}: ${JSON.stringify(info)}`);
  await page.screenshot({ path: `probe-${tag}.png`, fullPage: true }).catch(() => {});
  return info;
}

// proxies
const proxies = loadProxies();

// per site: fresh browser (proxy rotates by site index)
for (let si = 0; si < SITES.length; si++) {
  const site = SITES[si];
  log(`=== PROBE ${site.name}: ${site.url}`);
  const proxy = proxies.length ? proxies[si % proxies.length] : null;
  log(`proxy: ${proxy ? proxy.replace(/\/\/[^@]*@/, '//***@') : 'direct'}`);
  const browser = await launch({ headless: false, humanize: true, ...(proxy ? { proxy: parseProxy(proxy) } : {}) });
  const page = await browser.newPage();
  try {
    // 1. github login
    await page.goto('https://github.com/login', { waitUntil: 'load' });
    await page.fill('#login_field', acc.username);
    await page.fill('#password', acc.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }).catch(() => {}),
      page.evaluate(() => {
        [...document.querySelectorAll('input[type=submit],button')]
          .find((b) => /sign in/i.test(b.value || b.textContent || ''))?.click();
      }),
    ]);
    await sleep(2500);
    if (/sessions\/verified-device/.test(page.url())) {
      log(`${site.name}: device OTP flow`);
      const code = await pollDeviceOtp(acc.email);
      await page.fill('input[name="otp"]', code);
      await page.keyboard.press('Enter');
      await sleep(2500);
    }
    log(`${site.name}: github → ${page.url()}`);

    // 2. site signup page
    await page.goto(site.url, { waitUntil: 'load' });
    await sleep(3000);
    await dumpState(page, `${site.name}-page`);

    // 3. click the GitHub OAuth button (broad match)
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button,a,input[type=submit]')]
        .find((b) => /continue with github|sign in with github|sign up with github|github/i.test(b.textContent || b.value || ''));
      if (!b) return false;
      b.click();
      return true;
    });
    log(`${site.name}: github button clicked=${clicked}`);
    if (clicked) {
      // watch redirects incl. popups, click authorize if shown
      for (let i = 0; i < 15; i++) {
        await sleep(1500);
        let landed = false;
        for (const p of page.context().pages()) {
          const u = p.url();
          if (/github\.com\/login(\/oauth\/authorize)?/.test(u) && !/oauth\/authorize/.test(u)) {
            // github login page again → session issue
          }
          if (/github\.com\/login\/oauth\/authorize/.test(u)) {
            await p.evaluate(() => {
              [...document.querySelectorAll('button,input[type=submit]')]
                .find((b) => /^authorize/i.test((b.textContent || b.value || '').trim()))?.click();
            }).catch(() => {});
          }
          const siteHome = new URL(site.url).origin;
          if (u.startsWith(siteHome) && !/register|sign-up|sign-in|login/i.test(u)) landed = true;
        }
        if (landed) break;
      }
    }
    await sleep(3000);
    await dumpState(page, `${site.name}-final`);
  } catch (e) {
    log(`${site.name}: PROBE FAILED — ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: `probe-${site.name}-fail.png` }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
  await sleep(8000);
}
log('probes complete');
