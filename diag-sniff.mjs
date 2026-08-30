// diag-sniff.mjs — watch ALL network responses while creating a key manually
import { launch } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const db = new DatabaseSync('/Users/z/Desktop/gorouter-auto/accounts.db');
const username = process.argv[2] ?? 'user0232listingstudio';
const siteName = process.argv[3] ?? 'tabitoken';
const acc = db.prepare("SELECT * FROM accounts WHERE username=?").get(username);
const site = siteName === 'gorouter'
  ? { name: 'gorouter', register: 'https://gorouter.app/sign-up?aff=Jju8', signin: 'https://gorouter.app/sign-in', origin: 'https://gorouter.app', keyPage: '/keys' }
  : { name: 'tabitoken', register: 'https://tabitoken.com/sign-up?aff=fPbO', signin: 'https://tabitoken.com/sign-in', origin: 'https://tabitoken.com', keyPage: '/keys' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({ headless: false, humanize: false });
const page = await browser.newPage();
try { (await import('node:child_process')).execSync('osascript -e "tell application \\"Chromium\\" to hide"', { stdio: 'ignore' }); } catch {}

// watch EVERYTHING
page.on('response', async (res) => {
  try {
    const u = res.url();
    if (!u.startsWith(site.origin)) return;
    const m = res.request().method();
    const ct = res.headers()['content-type'] ?? '';
    const body = await res.text().catch(() => null);
    const hasSk = body && /sk-[A-Za-z0-9_-]{16,}/.test(body);
    console.log(`[${m}] ${res.status()} ${u.slice(site.origin.length, 80)} ct=${ct.slice(0, 30)} ${hasSk ? 'HAS-SK: ' + (body.match(/sk-[A-Za-z0-9_-]{16,}/g) ?? []).join(',') : ''}`);
  } catch {}
});

// login github
await page.goto('https://github.com/login', { waitUntil: 'load' });
await page.fill('#login_field', acc.username);
await page.fill('#password', acc.password);
await Promise.all([
  page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }).catch(() => {}),
  page.evaluate(() => { [...document.querySelectorAll('input[type=submit],button')].find((b) => /sign in/i.test(b.value || b.textContent || ''))?.click(); }),
]);
await sleep(2500);
if (/sessions\/verified-device/.test(page.url())) {
  console.log('device verify — fetching OTP');
  const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const H = { Authorization: 'Bearer ' + env.RESEND_API_KEY };
  let code = null;
  const baseline = new Date();
  for (let i = 0; i < 20 && !code; i++) {
    await sleep(8000);
    const list = await fetch('https://api.resend.com/emails/receiving', { headers: H }).then((r) => r.json());
    const hit = (list.data ?? []).filter((e) => (e.to ?? []).includes(acc.email) && /github/i.test(e.from) && new Date(e.created_at) > new Date(baseline.getTime() - 60000))[0];
    if (hit) {
      const full = await fetch('https://api.resend.com/emails/receiving/' + hit.id, { headers: H }).then((x) => x.json());
      code = (full.text ?? '').match(/\b(\d{6})\b/)?.[1];
    }
  }
  console.log('device OTP:', code);
  await page.fill('input[name="otp"]', code);
  await page.keyboard.press('Enter');
  await sleep(3000);
}
// oauth
await page.goto(site.signin, { waitUntil: 'load' });
await page.waitForSelector('text=Continue with GitHub', { timeout: 20000 }).catch(() => {});
await sleep(1500);
await page.getByText(/Continue with GitHub/i).first().click({ timeout: 10000 }).catch(() => {});
for (let i = 0; i < 20; i++) {
  await sleep(1500);
  for (const p of page.context().pages()) {
    if (/github\.com\/login\/oauth\/authorize/.test(p.url())) {
      await p.evaluate(() => { [...document.querySelectorAll('button,input[type=submit]')].find((b) => /^authorize/i.test((b.textContent || b.value || '').trim()))?.click(); }).catch(() => {});
    }
  }
  if (/tabitoken|gorouter/.test(page.url()) && !/sign-in|sign-up/.test(page.url())) break;
}
console.log('oauth landed:', page.url());
await page.goto(site.origin + site.keyPage, { waitUntil: 'load' });
await sleep(2000);
// create a key named diag
const opened = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button,a')].find((b) => /^create api key$/i.test((b.textContent || '').trim()));
  if (!b) return false; b.click(); return true;
});
console.log('dialog opened:', opened);
await sleep(1500);
await page.click('input[name="name"]');
await page.type('input[name="name"]', `${username}-diag`, { delay: 30 });
await sleep(400);
// group
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /select a group/i.test((b.textContent || '').trim()))?.click(); });
await sleep(2000);
await page.evaluate(() => {
  const els = [...document.querySelectorAll('[role=option],li')].filter((e) => (e.textContent || '').trim());
  (els.find((e) => /default/i.test(e.textContent)) ?? els[0])?.click();
});
await sleep(800);
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => /^save changes$/i.test((b.textContent || '').trim()))?.click(); });
await sleep(6000);
console.log('done — review POST log above');
await browser.close().catch(() => {});
