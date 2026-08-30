// gorouter-signup.mjs — for each registered GitHub account: login to GitHub,
// then complete gorouter.app sign-up via "Continue with GitHub" OAuth.
//
// Start state (mandatory): NOT logged in anywhere — fresh CloakBrowser per
// account (incognito-equivalent temp profile). Script logs into GitHub first,
// then drives https://gorouter.app/sign-up?aff=Jju8 → "Continue with GitHub"
// → authorize → whatever completion gorouter asks for (probed live, see log).
//
// Usage:
//   node gorouter-signup.mjs             # all registered accounts without gorouter flag
//   node gorouter-signup.mjs <username>  # one specific account
import { launch } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = fileURLToPath(new URL('./accounts.db', import.meta.url));
const GOROUTER_URL = 'https://gorouter.app/sign-up?aff=Jju8';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// log — timestamped progress line
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// db — shared connection
const db = new DatabaseSync(DB);

// pickAccount — next registered GitHub account without a gorouter result
function pickAccount(username) {
  return username
    ? db.prepare("SELECT * FROM accounts WHERE username=? AND status='registered' AND gorouter IS NULL").get(username)
    : db.prepare("SELECT * FROM accounts WHERE status='registered' AND gorouter IS NULL ORDER BY created LIMIT 1").get();
}

// hasChallenge — DataDome/other challenge on the page?
const hasChallenge = (page) =>
  page.evaluate(() => {
    const frameHit = [...document.querySelectorAll('iframe')]
      .some((f) => /captcha-delivery|datadome|arkose|hcaptcha|recaptcha|turnstile/i.test(f.src));
    const textHit = /verify your account|unusual activity|prove you are human|complete these steps|are you a robot/i.test(document.body.innerText);
    return { hit: frameHit || textHit, src: frameHit ? 'iframe' : textHit ? 'text' : null };
  });

// waitForSelectorPauseOnCaptcha — wait for selector; if a challenge shows up
// first, screenshot + mark + pause for human (max 15 min)
async function waitForSelectorPauseOnCaptcha(page, username, step, selector) {
  let marked = false;
  for (let i = 0; i < 450; i++) {
    if (await page.$(selector)) return;
    const c = await hasChallenge(page).catch(() => null);
    if (c && c.hit && !marked) {
      marked = true;
      await page.screenshot({ path: `captcha-WAIT-${step}-${username}.png` });
      log(`${username}: ⚠ CAPTCHA at ${step} (${c.src}) — PAUSED, waiting for human`);
    }
    await sleep(2000);
  }
  throw new Error(`${step}: "${selector}" never rendered within 15 minutes`);
}

// dumpState — page facts for probing the gorouter flow
async function dumpState(page, tag) {
  const info = await page.evaluate(() => ({
    url: location.href,
    h1: document.querySelector('h1')?.textContent?.trim() ?? null,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
    buttons: [...document.querySelectorAll('button,a[role=button],input[type=submit]')]
      .map((b) => (b.textContent || b.value || '').trim())
      .filter((t) => t && t.length < 40)
      .slice(0, 15),
    inputs: [...document.querySelectorAll('input,select')].map((e) => ({ name: e.name || e.id, type: e.type })).slice(0, 15),
  }));
  log(`${tag}: ${JSON.stringify(info)}`);
  await page.screenshot({ path: `gorouter-${tag}.png` }).catch(() => {});
  return info;
}

// pollOtp — poll Resend inbound for a NEW GitHub email to `to`, extract 4-8
// digit code (device-verification codes are 6 digits, launch codes 8)
async function pollOtp(to, since, digits = '4-8') {
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
        const code = raw.match(new RegExp(`\\b(\\d{${digits}})\\b`))?.[1];
        if (code) return code;
        throw new Error('GitHub email found but no code in body');
      }
    }
    await sleep(10_000);
  }
  throw new Error('OTP not received within 4 minutes');
}

// gorouterOne — full flow for one account
async function gorouterOne(acc) {
  log(`gorouter signup for ${acc.username}`);
  const browser = await launch({ headless: false, humanize: true });
  const page = await browser.newPage();
  try {
    // 1. GitHub login
    await page.goto('https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Fdashboard', { waitUntil: 'load' });
    await waitForSelectorPauseOnCaptcha(page, acc.username, 'gh-login', 'form[action="/session"]');
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
    let ghUrl = page.url();
    // device verification: GitHub emails a one-time code on new-browser logins
    if (/sessions\/verified-device/.test(ghUrl)) {
      log(`${acc.username}: device verification required — reading OTP from Resend`);
      await dumpState(page, `${acc.username}-device-verify`);
      const code = await pollOtp(acc.email, new Date(Date.now() - 10 * 60 * 1000), '6');
      log(`${acc.username}: device OTP ${code} received`);
      await waitForSelectorPauseOnCaptcha(page, acc.username, 'device-verify', 'input[name="otp"],input[autocomplete="one-time-code"],input[type="text"]');
      await page.click('input[name="otp"],input[autocomplete="one-time-code"],input[type="text"]');
      await page.type('input[name="otp"],input[autocomplete="one-time-code"],input[type="text"]', code, { delay: 80 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }).catch(() => {}),
        page.keyboard.press('Enter').catch(() => {}),
      ]);
      await sleep(2500);
      ghUrl = page.url();
      log(`${acc.username}: device verify → ${ghUrl}`);
    }
    if (!/github\.com\/?$|dashboard/.test(ghUrl)) throw new Error(`github login failed: ${ghUrl}`);
    log(`${acc.username}: github logged in → ${ghUrl}`);

    // 2. gorouter sign-up page
    await page.goto(GOROUTER_URL, { waitUntil: 'load' });
    await sleep(2500);
    await dumpState(page, `${acc.username}-gorouter-page`);

    // 3. click "Continue with GitHub"
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button,a,input[type=submit]')]
        .find((b) => /continue with github|sign in with github|sign up with github/i.test(b.textContent || b.value || ''));
      if (!b) return false;
      b.click();
      return true;
    });
    if (!clicked) {
      await page.screenshot({ path: `gorouter-fail-nobutton-${acc.username}.png` });
      throw new Error('Continue with GitHub button not found on gorouter');
    }
    // OAuth may navigate multiple hops (gorouter → github authorize → callback)
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const u = page.url();
      if (/github\.com\/login\/oauth\/authorize/.test(u)) {
        await dumpState(page, `${acc.username}-authorize`);
        // click the Authorize button if present
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button,input[type=submit],a')]
            .find((b) => /^authorize/i.test((b.textContent || b.value || '').trim()));
          b?.click();
        });
      }
      if (/gorouter\.app/.test(u) && !/sign-up/.test(u)) break; // landed past signup
      if (/gorouter\.app/.test(u) && i > 8) break;
    }
    await sleep(2500);
    const info = await dumpState(page, `${acc.username}-final`);

    // 4. outcome — success if we're past the sign-up form
    const finalUrl = page.url();
    const done = /gorouter\.app/.test(finalUrl) && !/sign-up/.test(finalUrl);
    db.prepare('UPDATE accounts SET gorouter=? WHERE username=?').run(done ? 'registered' : `unknown: ${finalUrl.slice(0, 60)}`, acc.username);
    log(`${acc.username}: gorouter ${done ? 'DONE' : 'UNCLEAR'} → ${finalUrl} | h1=${info.h1}`);
  } finally {
    // --keep-open (debug mode): hold the browser open for manual next steps
    if (process.argv.includes('--keep-open')) {
      log('KEEP-OPEN: browser left running for manual next steps');
      browser.on('disconnected', () => log('browser closed — exiting'));
      setInterval(() => {}, 1 << 30); // hold forever
    } else {
      await browser.close().catch(() => {});
    }
  }
}

// main — loop over accounts without gorouter result
const only = process.argv[2];
const failed = new Set();
if (only && !pickAccount(only)) {
  console.error(`account ${only} not found / not registered / already done`);
  process.exit(1);
}
while (true) {
  const acc = pickAccount(only);
  if (!acc || failed.has(acc.username)) break;
  try {
    await gorouterOne(acc);
  } catch (e) {
    log(`${acc.username}: FAILED — ${e.message.split('\n')[0]}`);
    failed.add(acc.username);
  }
  if (only) break;
  await sleep(10_000);
}
log('gorouter run complete');
