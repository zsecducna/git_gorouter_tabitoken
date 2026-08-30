// diag-auth.mjs — inspect session storage + raw token-list response shape
import { launch } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const db = new DatabaseSync('/Users/z/Desktop/gorouter-auto/accounts.db');
const acc = db.prepare("SELECT * FROM accounts WHERE username=?").get(process.argv[2] ?? 'user0682listingstudio');
const siteArg = process.argv[3] ?? 'gorouter';
const site = siteArg === 'gorouter'
  ? { signin: 'https://gorouter.app/sign-in', origin: 'https://gorouter.app' }
  : { signin: 'https://tabitoken.com/sign-in', origin: 'https://tabitoken.com' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({ headless: false, humanize: false });
const page = await browser.newPage();
page.on('response', (res) => {
  const u = res.url();
  if (/oauth|auth\/github|session/.test(u)) console.log('[net]', res.request().method(), res.status(), u.slice(0, 90));
});
await page.goto('https://github.com/login', { waitUntil: 'load' });
await page.fill('#login_field', acc.username);
await page.fill('#password', acc.password);
await Promise.all([
  page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }).catch(() => {}),
  page.evaluate(() => { [...document.querySelectorAll('input[type=submit],button')].find((b) => /sign in/i.test(b.value || b.textContent || ''))?.click(); }),
]);
await sleep(2500);
if (/sessions\/verified-device/.test(page.url())) {
  const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const H = { Authorization: 'Bearer ' + env.RESEND_API_KEY };
  let code = null;
  const t0 = new Date();
  for (let i = 0; i < 20 && !code; i++) {
    await sleep(8000);
    const list = await fetch('https://api.resend.com/emails/receiving', { headers: H }).then((r) => r.json());
    const hit = (list.data ?? []).filter((e) => (e.to ?? []).includes(acc.email) && /github/i.test(e.from) && new Date(e.created_at) > new Date(t0.getTime() - 60000))[0];
    if (hit) code = ((await fetch('https://api.resend.com/emails/receiving/' + hit.id, { headers: H }).then((x) => x.json())).text ?? '').match(/\b(\d{6})\b/)?.[1];
  }
  await page.fill('input[name="otp"]', code);
  await page.keyboard.press('Enter');
  await sleep(3000);
}
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
  if (page.url().startsWith(site.origin) && !/sign-in|sign-up|\/oauth\//.test(page.url())) break;
}
console.log('landed:', page.url());
await page.goto(site.origin + '/keys', { waitUntil: 'load' });
await sleep(3000);
const dump = await page.evaluate(async () => {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    ls[k] = (localStorage.getItem(k) ?? '').slice(0, 150);
  }
  // chain: self → user id → list (New-Api-User header) → reveal key
  const self = await fetch('/api/user/self', { credentials: 'include' }).then((r) => r.json()).catch((e) => ({ err: e.message }));
  const id = self?.data?.id;
  const hdr = id ? { 'New-Api-User': String(id) } : {};
  const raw = await fetch('/api/token/?p=1&size=20', { credentials: 'include', headers: hdr }).then((r) => r.text()).catch((e) => 'ERR ' + e.message);
  let reveal = null;
  try {
    const list = JSON.parse(raw);
    const items = list?.data?.items ?? list?.data?.records ?? (Array.isArray(list?.data) ? list.data : []);
    const row = (items ?? []).find((t) => JSON.stringify(t).includes('0682'));
    if (row) reveal = await fetch('/api/token/' + row.id + '/key', { method: 'POST', credentials: 'include', headers: hdr }).then((r) => r.text());
  } catch {}
  const ss = {};
  for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = (sessionStorage.getItem(k) ?? '').slice(0, 120); }
  // probe key-cell buttons + what pops
  const probe = {};
  const cell = document.querySelector('td[data-column-id="key"]');
  probe.cellHtml = cell?.outerHTML.slice(0, 800) ?? 'no-cell';
  const b0 = cell?.querySelectorAll('button')[0];
  if (b0) {
    b0.click();
    await new Promise((r) => setTimeout(r, 1200));
    probe.afterClick = {
      dialogs: [...document.querySelectorAll('[role=dialog],[role=menu],[data-radix-popper-content-wrapper]')].map((d) => d.outerHTML.slice(0, 400)),
      newButtons: [...document.querySelectorAll('body > div button, [data-slot*=popover] button')].map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 10),
    };
  }
  return { probe };
});
console.log(JSON.stringify(dump, null, 1));
await browser.close().catch(() => {});
