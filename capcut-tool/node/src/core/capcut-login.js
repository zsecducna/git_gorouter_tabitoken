// Log an EXISTING CapCut account back in (email + password).
// Port of capcut_login.py (worker F).
//
// Why this exists: the tool only knew how to SIGN UP. Any account whose task
// run stalled mid-way (credit stuck at 520 or 1540 instead of 2060) had no
// path back to finish the rest — every run burned a fresh account and the
// missing credit was lost forever.
//
// Reuses the exact UI steps of the signup flow (same page, same input boxes);
// only the final button differs: 'Sign in' instead of 'Sign up'.
//
// Deviation vs python: the engine helpers (_click_step / _fill_field /
// _wait_rect / _js_by_text / _js_first / _page_error) and the step selectors
// are inlined here module-private, because capcut-engine.js is owned by
// another agent and its contract does not export them. The JS snippets and
// selectors are byte-identical to capcut_engine.py.

import { checkStop, currentUrl, defaultShouldStop, waitForDomReady } from '../browser/browser.js';
import { xorHex } from './capcut-api.js';
import { getUserId } from './capcut-tasks.js';
import { randFloat, sleep } from '../util/util.js';

// Login page URL, {locale} substituted at runtime (python LOGIN_URL_TPL).
const LOGIN_URL_TPL = 'https://www.capcut.com/{locale}/login';

// Submit button on the password screen. Class names carry a build hash, so
// match by TEXT first; the class selectors are only a backup.
const LOGIN_BTN_TXT = ['đăng nhập', 'sign in', 'log in'];
const LOGIN_BTN_SEL = [
  'button.lv_sign_in_panel_wide-sign-in-button',
  '.lv_sign_in_panel_wide-form button',
];

// "Continue with email" button. The page has many buttons sharing one class
// (Google, Facebook, TikTok...), so identify by the email icon first, text as
// backup. (Text needles stay Vietnamese — they match the live page copy.)
const EMAIL_BTN_JS =
  "(()=>{let i=document.querySelector('.lv_third_part_sign_in_expand-icon-email');" +
  "return i?(i.closest('.lv_third_part_sign_in_expand_new-button')||i.parentElement):null})()";
const EMAIL_BTN_SEL = ['.lv_third_part_sign_in_expand_new-button'];
const EMAIL_BTN_TXT = ['tiếp tục bằng email', 'continue with email'];

// Email input + "Continue" button.
const EMAIL_INPUT_SEL = [
  'input[name="username"][type="email"]',
  'input.lv_email_entry_view-input',
  'input[inputmode="email"]',
];
const EMAIL_NEXT_SEL = [
  'button.lv_email_entry_view-btn',
  '.lv_email_entry_view-form button',
];
const EMAIL_NEXT_TXT = ['tiếp tục', 'continue'];

// Password input (signup used the same box plus a newsletter checkbox).
const PASS_INPUT_SEL = [
  'input[name="password"][autocomplete="new-password"]',
  'input[name="password"]',
  'input[type="password"]',
];

// CapCut on-page error notices (email exists, weak password, wrong code...).
// Uses `innerText||textContent`: innerText does not exist in every context
// (elements inside SVG, unlayouted nodes); without the fallback reads come
// back empty and errors get missed.
const ERROR_TEXT_JS =
  "(()=>{const sels=['.lv-message-content','.lv-form-item-message'," +
  "'[class*=\"error\"]','.lv-input-error-msg','.lv-notification-content'];" +
  "for(const s of sels){for(const e of document.querySelectorAll(s)){" +
  "const r=e.getBoundingClientRect();" +
  "const t=(e.innerText||e.textContent||'').trim();" +
  "if(t&&r.width>0&&r.height>0)return t.replace(/\\s+/g,' ').slice(0,200)}}" +
  "return null})()";

// Race page.evaluate against a hard timeout — parity with the python wrapper
// `page.js(expr, timeout=60)`. Playwright's evaluate has no per-call timeout.
async function evalTimed(page, js, timeoutMs = 60000) {
  const work = page.evaluate(js);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`page.evaluate timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutException'; // same name pychrome raised, for log parity
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {}); // swallow the losing promise's late rejection
  }
}

// Viewport rect of the element `expr` (a JS expression returning an Element)
// points to. Null when missing, hidden, or disabled. Never mutates the DOM.
async function rectFromJs(page, expr) {
  const js =
    '(()=>{const e=(' + expr + ');if(!e)return null;' +
    "if(e.disabled||e.getAttribute('aria-disabled')==='true')return null;" +
    "const r=e.getBoundingClientRect(),s=getComputedStyle(e);" +
    "if(r.width<1||r.height<1||s.visibility==='hidden'||s.display==='none')return null;" +
    "if(r.top<40||r.bottom>innerHeight-40){e.scrollIntoView({block:'center'});}" +
    'const r2=e.getBoundingClientRect();' +
    'return{x:r2.x,y:r2.y,w:r2.width,h:r2.height}})()';
  try {
    return (await evalTimed(page, js)) ?? null;
  } catch {
    return null; // python caught RuntimeError from page.js -> None
  }
}

// Click the middle of a rect (with random offset) using the CDP mouse.
function clickPlan(rect) {
  const padX = Math.max(3, rect.w * 0.15);
  const padY = Math.max(3, rect.h * 0.15);
  return {
    x: rect.x + randFloat(padX, rect.w - padX),
    y: rect.y + randFloat(padY, rect.h - padY),
  };
}

// Wait until the element a JS expression points to shows up. Returns its rect
// or null on timeout. Polls every `interval` seconds.
async function waitRect(page, expr, { timeout = 20, interval = 0.25, shouldStop = null } = {}) {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    const rect = await rectFromJs(page, expr);
    if (rect) {
      // The rect just read may still be shifting (SPA animating) -> read again.
      await sleep(200);
      return (await rectFromJs(page, expr)) || rect;
    }
    await sleep(interval * 1000);
  }
  return null;
}

// Build a JS expression: first element whose TEXT matches within the selector
// list. `exact` compares equal (avoids grabbing 'Skip all' when 'Skip' is
// wanted); otherwise substring. Text compared lowercased, whitespace-squeezed.
function jsByText(selectors, texts, exact = false) {
  const sels = JSON.stringify(Array.isArray(selectors) ? selectors : [selectors]);
  const tx = JSON.stringify((Array.isArray(texts) ? texts : [texts]).map((t) => String(t).toLowerCase()));
  const cmp = exact ? 't===w' : 't.includes(w)';
  return (
    '(()=>{const S=' + sels + ',W=' + tx + ';' +
    'for(const s of S){for(const e of document.querySelectorAll(s)){' +
    'const r=e.getBoundingClientRect();if(r.width<1||r.height<1)continue;' +
    "const t=(e.innerText||e.textContent||'').trim().toLowerCase()" +
    ".replace(/\\s+/g,' ');" +
    'for(const w of W){if(' + cmp + ')return e}}}' +
    'return null})()'
  );
}

// Build a JS expression: first VISIBLE element matching one of the selectors.
function jsFirst(selectors) {
  const sels = JSON.stringify(Array.isArray(selectors) ? selectors : [selectors]);
  return (
    '(()=>{for(const s of ' + sels + '){' +
    'for(const e of document.querySelectorAll(s)){' +
    'const r=e.getBoundingClientRect();' +
    'if(r.width>=1&&r.height>=1)return e}}return null})()'
  );
}

// Wait then click the first element found from a list of JS expressions.
// `exprs` are ordered by decreasing reliability (specific selector -> by text
// -> backup class). Returns true when clicked.
async function clickStep(page, human, log, label, exprs, { timeout = 20, shouldStop = null } = {}) {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    for (let i = 0; i < exprs.length; i++) {
      const rect = await rectFromJs(page, exprs[i]);
      if (rect) {
        const { x, y } = clickPlan(rect);
        await human.clickXY(x, y);
        log(`    [ok] Clicked ${label}` + (i ? ` (way ${i + 1})` : ''));
        return true;
      }
    }
    await sleep(300);
  }
  log(`    [!] ${label} not found after ${timeout}s (url: ${await currentUrl(page)}).`);
  return false;
}

// Read the value of the first visible input matching the selectors; null when
// none found. Read-only.
async function fieldValue(page, selectors) {
  const sels = JSON.stringify(Array.isArray(selectors) ? selectors : [selectors]);
  const js =
    '(()=>{for(const s of ' + sels + '){' +
    'for(const e of document.querySelectorAll(s)){' +
    'const r=e.getBoundingClientRect();' +
    "if(r.width>=1&&r.height>=1)return e.value||''}}return null})()";
  try {
    return (await evalTimed(page, js)) ?? null;
  } catch {
    return null;
  }
}

// Fill an input then READ the value back to confirm; refill when it did not
// land. CapCut is a React SPA: the signup panel animates on step transitions,
// so a rect read before the shift can put the click outside the box and typed
// characters vanish. Without the re-check the tool would report success while
// the box is still empty. Returns the matched selector or null.
async function fillField(human, page, selectors, value, label, log, { attempts = 3, shouldStop = null } = {}) {
  let sel = null;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    checkStop(shouldStop);
    sel = await human.fill(selectors, value);
    if (sel === null) {
      log(`    [!] ${label} input not found.`);
      return null;
    }
    const got = await fieldValue(page, selectors);
    if (got === value) {
      if (i) log(`    [i] ${label}: needed ${i + 1} fills to land in the box.`);
      return sel;
    }
    if (i + 1 < attempts) {
      log(`    [!] ${label} did not land in the box (now ${JSON.stringify(got)}) — refilling (try ${i + 2}/${attempts}) ...`);
      await sleep(randFloat(0.3, 0.7) * 1000);
    } else {
      log(`    [!] ${label} STILL not in the box after ${attempts} tries (now ${JSON.stringify(got)}).`);
    }
  }
  return sel;
}

// The on-page error notice currently showing, or null.
async function pageError(page) {
  try {
    return (await evalTimed(page, ERROR_TEXT_JS)) ?? null;
  } catch {
    return null;
  }
}

// Wipe the previous session BEFORE opening the login page: a reused profile
// still holding the previous account's cookies makes CapCut bounce straight
// from the login page to /my-edit — no "Continue with email" button and the
// login fails (hit for real at 05:51 on 31/08/2026). Both clears are
// best-effort: a failure is logged, never fatal.
async function clearSession(page, log) {
  try {
    await page.context().clearCookies(); // python: Network.clearBrowserCookies _timeout=20
  } catch (e) {
    log(`    [i] could not clear cookies: ${e?.name || 'Error'}`);
  }
  try {
    // python: page.js("try{localStorage.clear();sessionStorage.clear()}catch(e){}", timeout=15)
    await evalTimed(page, "(()=>{try{localStorage.clear();sessionStorage.clear()}catch(e){}})()", 15000);
  } catch {
    /* storage clear failed — proceed anyway (python: except pass) */
  }
}

// API login: POST /passport/web/email/login/ via in-page NATIVE fetch.
// Measured 2026-09-02: the UI path ("Continue with email" → … → password)
// dies through the zingproxy gateways — the page's own SDK calls ERR_FAILED
// mid-flow and the password screen never appears. This passport endpoint
// needs no SDK signature (same family as check_email/send_code, all verified
// unsigned) and works via native fetch in BOTH direct and proxy environments.
// Returns 'ok' | 'rate-limited' | 'failed'.
async function apiLogin(page, email, password, { log = console.log, shouldStop = null } = {}) {
  checkStop(shouldStop);
  const qs = 'aid=348188&account_sdk_source=web&sdk_version=2.1.10-tiktok&language=vi';
  const emX = xorHex(email);
  const pwX = xorHex(password);
  const js = `(async () => {
    const f = window.__nativeFetch || window.fetch;
    const r = await f('https://login-row.www.capcut.com/passport/web/email/login/?${qs}', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=${emX}&password=${pwX}&mix_mode=1&email_active_status=0',
    });
    const t = await r.text();
    return r.status + ' ' + t;
  })()`;
  try {
    const raw = await evalTimed(page, js, 30000);
    if (/"user_id"\s*:/.test(raw) && /"message"\s*:\s*"success"/.test(raw)) {
      const m = /"user_id_str"\s*:\s*"(\d+)"/.exec(raw);
      log(`    [ok] Logged in via API${m ? `: user_id=${m[1]}` : ''}`);
      return 'ok';
    }
    if (/"error_code"\s*:\s*7/.test(raw)) {
      log('    [!] API login rate-limited (error_code 7 — "too frequent"): wait or switch exit IP.');
      return 'rate-limited';
    }
    log(`    [!] API login rejected: ${String(raw).slice(0, 160)}`);
    return 'failed';
  } catch (e) {
    log(`    [!] API login call failed: ${e?.message || e}`);
    return 'failed';
  }
}

// Log in with email + password. Returns true on success, false on failure.
//
// API first (works everywhere incl. proxied), UI flow as fallback for when
// the endpoint is unavailable but the page still works (direct runs).
// Success is verified via `getUserId` — never by trusting the URL change:
// CapCut swaps the URL BEFORE the session is actually valid, and trusting it
// makes the very next API call fail its signature check.
export async function login(page, human, email, password, {
  log = console.log,
  shouldStop = null,
  locale = 'vi-vn',
  waitSeconds = 45,
} = {}) {
  shouldStop = shouldStop || defaultShouldStop;
  checkStop(shouldStop);

  await clearSession(page, log);

  const url = LOGIN_URL_TPL.replace('{locale}', locale);
  log(`[>] Logging in ${email}`);
  await page.goto(url, { timeout: 90000 }); // 90s: heavy first load through slower proxy exits (30s measured too tight)
  await waitForDomReady(page, { settle: [1.0, 1.8] });
  checkStop(shouldStop);

  // API path first — the only path that works through the zingproxy gateways.
  const api = await apiLogin(page, email, password, { log, shouldStop });
  if (api === 'ok') {
    return true; // apiLogin already verified user_id in the response
  }
  if (api === 'rate-limited') {
    return false; // UI flow will hit the same server-side block — do not waste a minute on it
  }

  // UI fallback (direct connections where the page's own SDK flow works).
  if (!(await clickStep(page, human, log, "'Continue with email'",
    [
      EMAIL_BTN_JS,
      jsByText(EMAIL_BTN_SEL, EMAIL_BTN_TXT),
      jsFirst(EMAIL_BTN_SEL),
    ],
    { shouldStop }))) {
    return false;
  }

  if (!(await waitRect(page, jsFirst(EMAIL_INPUT_SEL), { timeout: 20, shouldStop }))) {
    log('    [!] Email input not found.');
    return false;
  }
  if (!(await fillField(human, page, EMAIL_INPUT_SEL, email, 'Email', log, { shouldStop }))) {
    return false;
  }
  if (!(await clickStep(page, human, log, "'Continue' (after email)",
    [
      jsFirst(EMAIL_NEXT_SEL),
      jsByText(EMAIL_NEXT_SEL, EMAIL_NEXT_TXT),
    ],
    { shouldStop }))) {
    return false;
  }

  if (!(await waitRect(page, jsFirst(PASS_INPUT_SEL), { timeout: 25, shouldStop }))) {
    const err = await pageError(page);
    log('    [!] Password input not found'
      + (err ? ` — page reports: ${err}` : '')
      + ` (url: ${await currentUrl(page)}).`);
    return false;
  }
  if (!(await fillField(human, page, PASS_INPUT_SEL, password, 'Password', log, { shouldStop }))) {
    return false;
  }
  if (!(await clickStep(page, human, log, "'Sign in'",
    [
      jsByText(LOGIN_BTN_SEL, LOGIN_BTN_TXT),
      jsFirst(LOGIN_BTN_SEL),
    ],
    { shouldStop }))) {
    return false;
  }

  // Wait for the session to be REALLY live: poll account/info for a user_id.
  // (Python returned the user_id string; this port returns bool per contract.)
  const deadline = Date.now() + Math.max(5, Math.trunc(Number(waitSeconds) || 0)) * 1000;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    const uid = await getUserId(page);
    if (uid) {
      log(`    [ok] Logged in: user_id=${uid}`);
      return true;
    }
    const err = await pageError(page);
    if (err) {
      log(`    [!] Page reports: ${err}`);
      return false;
    }
    await sleep(2000);
  }

  log('    [!] Login finished but could not read user_id.');
  return false;
}
