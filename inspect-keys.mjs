// inspect-keys.mjs — login as given account, dump /keys row DOM (buttons with
// all attributes + row HTML snippet) to nail the copy interaction
import { launch } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = fileURLToPath(new URL('./accounts.db', import.meta.url));
const db = new DatabaseSync(DB);
const username = process.argv[2] ?? 'user3listingstudio';
const acc = db.prepare("SELECT * FROM accounts WHERE username=?").get(username);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launch({ headless: false, humanize: true });
const page = await browser.newPage();
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
  // device OTP via Resend
  const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const H = { Authorization: `Bearer ${env.RESEND_API_KEY}` };
  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    await sleep(8000);
    const list = await fetch('https://api.resend.com/emails/receiving', { headers: H }).then((r) => r.json());
    const hit = (list.data ?? []).filter((e) => (e.to ?? []).includes(acc.email) && /github/i.test(e.from) && new Date(e.created_at) > new Date(Date.now() - 10 * 60 * 1000))[0];
    if (hit) {
      const full = await fetch(`https://api.resend.com/emails/receiving/${hit.id}`, { headers: H }).then((x) => x.json());
      code = (full.text ?? '').match(/\b(\d{6})\b/)?.[1];
    }
  }
  console.log('device otp:', code);
  await page.fill('input[name="otp"]', code);
  await page.keyboard.press('Enter');
  await sleep(2500);
}
console.log('github:', page.url());

// gorouter OAuth — sign-in entry (existing account)
await page.goto('https://gorouter.app/sign-in', { waitUntil: 'load' });
await page.waitForSelector('text=Continue with GitHub', { timeout: 20000 }).catch(() => {});
for (let i = 0; i < 25; i++) {
  const ready = await page.evaluate(() => {
    const t = document.querySelector('input[name="cf-turnstile-response"]');
    return !t || t.value.length > 10;
  });
  if (ready) break;
  await sleep(1000);
}
await sleep(8000);
await page.getByText(/Continue with GitHub/i).first().click({ timeout: 10000 }).catch(() => {});
for (let i = 0; i < 15; i++) {
  await sleep(1500);
  for (const p of page.context().pages()) {
    const u = p.url();
    if (/github\.com\/login\/oauth\/authorize/.test(u)) {
      await p.evaluate(() => {
        [...document.querySelectorAll('button,input[type=submit]')]
          .find((b) => /^authorize/i.test((b.textContent || b.value || '').trim()))?.click();
      }).catch(() => {});
    }
  }
  if (/gorouter\.app/.test(page.url()) && !/sign-up|sign-in/.test(page.url())) break;
}
await sleep(3000);
console.log('gorouter:', page.url());
await page.goto('https://gorouter.app/keys', { waitUntil: 'load' });
// sniff XHR/JSON bodies while the table loads — API may return FULL keys
const apiHits = [];
page.on('response', async (res) => {
  try {
    const ct = res.headers()['content-type'] ?? '';
    if (!/json/i.test(ct)) return;
    const body = await res.text();
    if (/sk-[A-Za-z0-9_-]{10,}/.test(body)) {
      const keys = [...new Set(body.match(/sk-[A-Za-z0-9_-]{10,}/g) ?? [])];
      apiHits.push({ url: res.url(), keys });
    }
  } catch { /* body unavailable */ }
});
await sleep(5000);

const dump = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')].map((b, i) => ({
    i, text: (b.textContent || '').trim().slice(0, 30),
    aria: b.getAttribute('aria-label'), title: b.title,
    cls: String(b.className).slice(0, 60),
    html: b.outerHTML.slice(0, 200),
  }));
  const row = [...document.querySelectorAll('tr,tbody > div')].find((r) => (r.textContent || '').includes('-key1'));
  return { url: location.href, btns: btns.slice(0, 30), rowHtml: row ? row.outerHTML.slice(0, 3000) : null };
});
console.log(JSON.stringify({ url: dump.url, btns: dump.btns.length, hasRow: !!dump.rowHtml, apiHits }, null, 1));

// full key-cell HTML + click every button in it, checking clipboard/dialogs
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://gorouter.app' }).catch(() => {});
const cellInfo = await page.evaluate(() => {
  const cell = document.querySelector('td[data-column-id="key"]');
  return cell ? { html: cell.outerHTML.slice(0, 4000), btnCount: cell.querySelectorAll('button').length } : null;
});
console.log('CELL:', JSON.stringify(cellInfo, null, 1));
if (cellInfo) {
  for (let bi = 0; bi < cellInfo.btnCount; bi++) {
    await page.locator('td[data-column-id="key"] button').nth(bi).click({ timeout: 5000 }).catch(() => {});
    await sleep(1500);
    const after = await page.evaluate(() => ({
      clip: navigator.clipboard.readText().catch(() => 'ERR'),
      dialog: !!document.querySelector('[role=dialog],[data-slot=popover-content],[data-base-ui-popup],[data-open]'),
      dialogText: document.querySelector('[role=dialog],[data-slot=popover-content],[data-base-ui-popup]')?.textContent?.slice(0, 300) ?? null,
    }));
    console.log(`BTN ${bi}:`, JSON.stringify(after));
    if (after.dialog) await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
  }
}
await page.screenshot({ path: 'inspect-final.png', fullPage: true });

// explore the Actions "…" menu of the key row
const menu = await page.evaluate(() => {
  const row = [...document.querySelectorAll('tr')].find((r) => (r.textContent || '').includes('-key1'));
  if (!row) return { error: 'no row' };
  const btns = [...row.querySelectorAll('button')];
  const more = btns.find((b) => (b.textContent || '').trim() === '…' || (b.textContent || '').trim() === '⋯' || /more/i.test(b.getAttribute('aria-label') || ''));
  if (more) more.click();
  return { rowButtons: btns.map((b) => ({ text: (b.textContent || '').trim().slice(0, 20), aria: b.getAttribute('aria-label'), html: b.outerHTML.slice(0, 120) })) };
});
console.log('MORE:', JSON.stringify(menu, null, 1));
await sleep(2000);
const menuItems = await page.evaluate(() => ({
  portals: [...document.querySelectorAll('[role=menu],[data-slot=menu-content],[data-base-ui-popup],[role=listbox]')]
    .map((m) => m.outerHTML.slice(0, 2000)),
  fullText: document.body.innerText.match(/sk-[A-Za-z0-9_-]{16,}/)?.[0] ?? null,
}));
console.log('MENU:', JSON.stringify(menuItems, null, 1));
await page.screenshot({ path: 'inspect-menu.png', fullPage: true });

// click the key-cell popover trigger, dump the popover
await page.locator('td[data-column-id="key"] button').first().click({ timeout: 8000 }).catch(async () => {
  await page.locator('button', { hasText: /sk-[a-z0-9]{3,8}\*{5,}/ }).first().click({ timeout: 8000 }).catch(() => {});
});
await sleep(2000);
const pop = await page.evaluate(() => {
  const roots = [...document.querySelectorAll('[data-slot="popover-content"],[role=dialog],[data-base-ui-popup]')];
  return {
    roots: roots.map((r) => ({ tag: r.tagName, cls: String(r.className).slice(0, 50), html: r.outerHTML.slice(0, 2500) })),
    bodyHasSk: /sk-[A-Za-z0-9_-]{16,}/.test(document.body.innerText) ? document.body.innerText.match(/sk-[A-Za-z0-9_-]{16,}/)?.[0] : null,
  };
});
console.log('POPOVER:', JSON.stringify(pop, null, 1));
await page.screenshot({ path: 'inspect-popover.png', fullPage: true });
await browser.close().catch(() => {});
