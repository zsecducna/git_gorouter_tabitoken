// CAPCUT SIGNUP ENGINE — Node port of capcut_engine.py.
//
// One complete CapCut account per signupOne() call: stealth browser -> mailbox
// reader -> signup (API fast-mode or UI 9-screen mode) -> credit tasks ->
// account saved. runBulk() drives a worker pool over the accounts.db queue.
//
// UI-mode 9-step flow (per the real capcut.com DOM, 08/2026 build):
//   1. open https://www.capcut.com/<locale>/login
//   2. click "Tiếp tục bằng email" (Continue with email)
//   3. type the email -> click "Tiếp tục" (Continue)
//   4. type the password, tick the newsletter opt-in -> click "Đăng ký" (Sign up)
//   5. birthday: type the year, pick month & day in dropdowns -> "Tiếp tục"
//   6. read the 6-digit code from the mailbox -> type it into the code box
//   7. click "Mở CapCut" (Open CapCut — the workspace-creation step)
//   8. click "Bỏ qua" (Skip) on the questionnaire
//   9. close the "What's new" modal
//
// Architecture changes vs python (decided, see CONTRACTS.md):
//   - GPMLogin is GONE: one throwaway CloakBrowser stealth profile per account
//     (src/browser/browser.js openBrowser), profile named after the username.
//   - OKOTP/TempMail rental is optional (MAIL_PROVIDER, worker K): default
//     'own' = own-domain IMAP catch-all mailbox (src/infra/mail.js
//     makeMailbox) bound to the row's pre-provisioned email; 'okotp' = rent a
//     paid gmail per account (src/infra/okotp.js) that replaces the row email.
//     python's dead-mailbox re-rent loop (OTP_MAX_HOP_THU) is not ported: the
//     own-domain mailbox cannot die, and in okotp mode a dead box (OkotpDead)
//     fails the account so the released row retries with a fresh rental.
//   - Credentials NEVER come from the engine: they are the claimed accounts.db
//     row (username/password/email provisioned by bin/provision.js).
//
// Rule kept from the original tool: every click/keystroke goes through CDP
// Input (bezier mouse + random delays via human-input.js); JS only READS page
// state. CapCut class names carry hashes (`skip-mrkR37`, `container-cHDY8I`)
// that change per build, so selectors anchor on name/placeholder/aria-label/
// visible TEXT; classes are fallbacks only.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StopRequested, checkStop, defaultShouldStop, currentUrl, waitForDomReady,
  openBrowser, closeBrowser,
} from '../browser/browser.js';
import { HumanInput } from '../browser/human-input.js';
import { NetworkRecorder } from '../browser/netlog.js';
import { makeMailbox, validateMail } from '../infra/mail.js';
import { OkotpClient, OkotpError, makeOrderMailbox } from '../infra/okotp.js';
import {
  openAccountsDb, ensureCapcutColumns, claimNextCapcut, markCapcutRegistered,
  markCapcutPoisoned, releaseCapcut, capcutStats, setCapcutEmail,
} from '../infra/db.js';
import { warmUp, signupViaApi } from './capcut-api.js';
import { getCredit, creditTotal, runAll as runAllTasks } from './capcut-tasks.js';
import { claimPro } from './upgrade-pro.js';
import { sleep, randInt, randFloat, makeMutex, appendLine } from '../util/util.js';
import { randomWorkspaceName } from '../util/gen.js';

// node/ package root (config file values are relative to it, like python's
// script-dir-relative result files). This file is node/src/core/capcut-engine.js.
const NODE_ROOT = path.dirname(fileURLToPath(new URL('../../', import.meta.url)));

// After this many failed attempts on the SAME username, runBulk poisons the row
// instead of releasing it back (a released row is oldest-first and would be
// reclaimed instantly, looping forever on e.g. an already-burned email).
// Node-port addition — python had no DB queue.
const MAX_SIGNUP_FAILS = 2;

// ----------------------------------------------------------------------------
// Selectors & texts per step
// ----------------------------------------------------------------------------

// Login page URL template ('vi-vn' -> https://www.capcut.com/vi-vn/login).
const LOGIN_URL_TPL = 'https://www.capcut.com/{locale}/login';

// Step 2: the "Continue with email" button. The page renders many buttons with
// the same class (Google, Facebook, TikTok...), so identify it by the email
// icon, fall back to text. NOTE: the *_TXT arrays MATCH rendered page text —
// they are payloads, NOT logs; the Vietnamese entries must stay verbatim.
const EMAIL_BTN_JS = (
  "(()=>{let i=document.querySelector(" +
  "'.lv_third_part_sign_in_expand-icon-email');" +
  "return i?(i.closest('.lv_third_part_sign_in_expand_new-button')||i.parentElement):null})()"
);
const EMAIL_BTN_SEL = ['.lv_third_part_sign_in_expand_new-button'];
const EMAIL_BTN_TXT = ['tiếp tục bằng email', 'continue with email'];

// Step 3: email input + Continue button
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

// Step 4: password + newsletter opt-in checkbox + Sign up button
const PASS_INPUT_SEL = [
  'input[name="password"][autocomplete="new-password"]',
  'input[name="password"]',
  'input[type="password"]',
];
// The lv library's input[type=checkbox] is hidden (0x0); the clickable layer
// is the mask on top of it.
const MARKETING_CHK_SEL = [
  'label.edm-auth-checkbox .lv-checkbox-mask-wrapper',
  'label.edm-auth-checkbox .lv-checkbox-mask',
  '.edm-auth-checkbox .lv-checkbox-mask-wrapper',
];
const SIGNUP_BTN_SEL = [
  'button.lv_sign_in_panel_wide-sign-in-button',
  '.lv_sign_in_panel_wide-form button',
];
const SIGNUP_BTN_TXT = ['đăng ký', 'sign up'];

// Step 5: birthday
const YEAR_INPUT_SEL = [
  'input.gate_birthday-picker-input',
  '.gate_birthday-picker input[placeholder="Năm"]',
  '.gate_birthday-picker input[placeholder="Year"]',
];
// Two dropdowns share one class: [0] = Month (flex:1), [1] = Day (width 96px).
const BIRTH_SELECTOR_SEL = '.gate_birthday-picker-selector';
const BIRTH_OPTION_SEL = '.lv-select-popup-inner li.lv-select-option';
const BIRTH_NEXT_SEL = [
  'button.lv_sign_in_panel_wide-birthday-next',
  '.lv_sign_in_panel_wide-birthday-detail button',
];
const BIRTH_NEXT_TXT = ['tiếp tục', 'continue'];

// Step 6: the 6-digit code box (the real input is opacity:0 but still has a
// size and accepts keys)
const CODE_INPUT_SEL = [
  '.verification_code_input-wrapper input[maxlength="6"]',
  'input[maxlength="6"]',
  '.lv_sign_in_panel_wide-code-input-wrapper input',
];

// Step 7: the "Workspace name" box + "Open CapCut" button.
// CapCut pre-fills something like "user448579073269's space" -> every account
// would look identical, so type a random name instead. maxlength="50".
const WORKSPACE_INPUT_SEL = [
  'input#name_input',
  '.lv-create-teamspace-panel-value input',
  'input[maxlength="50"]',
];
const OPEN_CAPCUT_SEL = [
  'button#create-bottom',
  'button.lv-create-teamspace-confirm',
];
const OPEN_CAPCUT_TXT = ['mở capcut', 'open capcut'];

// Step 8: "Skip" the questionnaire — its class carries a hash, anchor on TEXT.
const SKIP_TXT = ['bỏ qua', 'skip'];
const SKIP_SEL = ['[class*="skip-"]'];

// Step 9: close the "What's new" modal
const MODAL_CLOSE_SEL = [
  '.lv-modal-close-icon',
  '[aria-label="Close"]',
  '.lv-modal-content .lv-icon-hover',
];

// CapCut error banners (email already exists, weak password, wrong code...).
// Uses `innerText||textContent`: innerText does not exist in every context
// (elements inside SVG, nodes without layout); without the fallback errors
// read back empty and get missed.
const ERROR_TEXT_JS = (
  "(()=>{const sels=['.lv-message-content','.lv-form-item-message'," +
  "'[class*=\"error\"]','.lv-input-error-msg','.lv-notification-content'];" +
  "for(const s of sels){for(const e of document.querySelectorAll(s)){" +
  "const r=e.getBoundingClientRect();" +
  "const t=(e.innerText||e.textContent||'').trim();" +
  "if(t&&r.width>0&&r.height>0)return t.replace(/\\s+/g,' ').slice(0,200)}}" +
  "return null})()"
);

// Serializes result-file writes across concurrent workers (python _SAVE_LOCK).
const SAVE_MUTEX = makeMutex();

// Credit granted when all 11 tasks are complete. Below this = still missing.
const FULL_TASK_CREDIT = 2060;

// ----------------------------------------------------------------------------
// Helpers: find & click by rect (real mouse via CDP)
// ----------------------------------------------------------------------------

// Evaluate a read-only JS expression in the page with a hard timeout —
// parity with the python tool's CDP Runtime.evaluate timeout. On timeout the
// losing evaluate is left to settle (its late rejection is swallowed).
// 60s default = python's measured ceiling (30s hit 7/48 timeouts under load).
async function evalJs(page, js, timeoutMs = 60000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`page.evaluate timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutException';
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });
  const work = page.evaluate(js);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
  }
}

// Viewport rect of the element `expr` (a JS expression returning an Element)
// points to. Returns null when missing, hidden, or disabled. Never mutates
// the DOM (scrollIntoView only scrolls, it does not alter structure).
async function rectFromJs(page, expr) {
  const js = (
    '(()=>{const e=(' + expr + ');if(!e)return null;' +
    "if(e.disabled||e.getAttribute('aria-disabled')==='true')return null;" +
    "const r=e.getBoundingClientRect(),s=getComputedStyle(e);" +
    "if(r.width<1||r.height<1||s.visibility==='hidden'||s.display==='none')return null;" +
    "if(r.top<40||r.bottom>innerHeight-40){e.scrollIntoView({block:'center'});}" +
    'const r2=e.getBoundingClientRect();' +
    'return{x:r2.x,y:r2.y,w:r2.width,h:r2.height}})()'
  );
  try {
    return await evalJs(page, js);
  } catch {
    return null; // python caught the CDP error and returned None the same way
  }
}

// Click the middle of `rect` (with random jitter) using the CDP mouse.
async function clickRect(human, rect) {
  const padX = Math.max(3, rect.w * 0.15);
  const padY = Math.max(3, rect.h * 0.15);
  const x = rect.x + randFloat(padX, rect.w - padX);
  const y = rect.y + randFloat(padY, rect.h - padY);
  await human.clickXY(x, y);
  return true;
}

// Wait until the element (located by JS expression) shows up. Returns its rect
// or null after `timeout` seconds. The just-read rect may still drift (the SPA
// animates between screens) -> read it once more before handing it out.
async function waitRect(page, expr, { timeout = 20, interval = 0.25, shouldStop = null } = {}) {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    const rect = await rectFromJs(page, expr);
    if (rect) {
      await sleep(200);
      return (await rectFromJs(page, expr)) || rect;
    }
    await sleep(interval * 1000);
  }
  return null;
}

// Build a JS expression: the first element matching TEXT among the selectors.
// `exact=true` compares equal (avoids grabbing 'Bỏ qua tất cả' when 'Bỏ qua' is
// wanted); `exact=false` uses contains. Text compares lowercased with
// collapsed whitespace.
function jsByText(selectors, texts, exact = false) {
  const sels = JSON.stringify(Array.isArray(selectors) ? selectors : [selectors]);
  const tx = JSON.stringify(texts.map((t) => String(t).toLowerCase()));
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

// Build a JS expression: the first VISIBLE element matching any selector.
function jsFirst(selectors) {
  const sels = JSON.stringify(Array.isArray(selectors) ? selectors : [selectors]);
  return (
    '(()=>{for(const s of ' + sels + '){' +
    'for(const e of document.querySelectorAll(s)){' +
    'const r=e.getBoundingClientRect();' +
    'if(r.width>=1&&r.height>=1)return e}}return null})()'
  );
}

// Wait, then click the first element found among a list of JS expressions.
// `exprs` are ordered most-reliable first (specific selector -> text ->
// fallback class). Returns true once clicked.
async function clickStep(page, human, log, label, exprs, { timeout = 20, shouldStop = null } = {}) {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    for (let i = 0; i < exprs.length; i++) {
      const rect = await rectFromJs(page, exprs[i]);
      if (rect) {
        await clickRect(human, rect);
        log(`    [ok] Click ${label}${i ? ` (way ${i + 1})` : ''}`);
        return true;
      }
    }
    await sleep(300);
  }
  log(`    [!] ${label} not seen after ${timeout}s (url: ${await currentUrl(page)}).`);
  return false;
}

// ----------------------------------------------------------------------------
// Helpers: fill an input with VALUE CONFIRMATION
// ----------------------------------------------------------------------------

// Value of the first visible input matching the selectors; null when none.
async function fieldValue(page, selectors) {
  const sels = JSON.stringify(Array.isArray(selectors) ? selectors : [selectors]);
  const js = (
    '(()=>{for(const s of ' + sels + '){' +
    'for(const e of document.querySelectorAll(s)){' +
    'const r=e.getBoundingClientRect();' +
    "if(r.width>=1&&r.height>=1)return e.value||''}}return null})()"
  );
  try {
    return await evalJs(page, js);
  } catch {
    return null;
  }
}

// Fill the input, then READ `value` back to confirm; retype when it did not
// land. CapCut is a React SPA: the signup panel animates on step changes, so
// a rect read before a shift can make the click land outside the box and the
// typed characters vanish. Without the re-check the tool would report success
// while the box is still empty.
async function fillField(human, page, selectors, value, label, log,
  { attempts = 3, shouldStop = null } = {}) {
  const tries = Math.max(1, attempts);
  let sel = null;
  for (let i = 0; i < tries; i++) {
    checkStop(shouldStop);
    sel = await human.fill(selectors, value);
    if (sel === null) {
      log(`    [!] Cannot see the ${label} box.`);
      return null;
    }
    const got = await fieldValue(page, selectors);
    if (got === value) {
      if (i) log(`    [i] ${label}: needed ${i + 1} attempts to land in the box.`);
      return sel;
    }
    if (i + 1 < tries) {
      log(`    [i] ${label} did not land in the box (now ${JSON.stringify(got)}) — retyping (try ${i + 2}/${tries}) ...`);
      await sleep(randFloat(0.3, 0.7) * 1000);
    } else {
      log(`    [!] ${label} STILL not in the box after ${tries} attempts (now ${JSON.stringify(got)}).`);
    }
  }
  return sel;
}

// The error message currently shown on the page, or null.
async function pageError(page) {
  try {
    return await evalJs(page, ERROR_TEXT_JS);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// The signup steps
// ----------------------------------------------------------------------------

// Steps 1+2: open the login page, then click "Continue with email".
export async function stepOpenLogin(page, human, settings, log, shouldStop = null) {
  const locale = settings.CAPCUT_LOCALE || 'vi-vn';
  const url = LOGIN_URL_TPL.replace('{locale}', locale);
  log(`\n[>] Step 1: open ${url}`);
  await page.goto(url, { timeout: 90000 }); // 90s: heavy first load through slower proxy exits (30s measured too tight)
  await waitForDomReady(page, { settle: [1.0, 1.8] });
  checkStop(shouldStop);

  log("[>] Step 2: click 'Continue with email'");
  return clickStep(
    page, human, log, "'Continue with email'",
    [EMAIL_BTN_JS,
      jsByText([...EMAIL_BTN_SEL, '[class*="third_part"]'], EMAIL_BTN_TXT),
      jsFirst(EMAIL_BTN_SEL)],
    { timeout: 30, shouldStop });
}

// Step 3: type the email, then click "Continue".
export async function stepFillEmail(page, human, email, log, shouldStop = null) {
  log(`[>] Step 3: type the email ${email}`);
  if (!(await waitRect(page, jsFirst(EMAIL_INPUT_SEL), { timeout: 20, shouldStop }))) {
    log('    [!] Cannot see the email box.');
    return false;
  }
  if (!(await fillField(human, page, EMAIL_INPUT_SEL, email, 'Email', log, { shouldStop }))) {
    return false;
  }
  return clickStep(
    page, human, log, "'Continue' (after email)",
    [jsFirst(EMAIL_NEXT_SEL),
      jsByText(['button'], EMAIL_NEXT_TXT, true)],
    { timeout: 15, shouldStop });
}

// Step 4: type the password, tick the newsletter opt-in, click "Sign up".
export async function stepFillPassword(page, human, settings, password, log, shouldStop = null) {
  log("[>] Step 4: type the password & click 'Sign up'");
  if (!(await waitRect(page, jsFirst(PASS_INPUT_SEL), { timeout: 25, shouldStop }))) {
    const err = await pageError(page);
    log('    [!] Cannot see the password box'
      + (err ? ` — page says: ${err}` : '')
      + ` (url: ${await currentUrl(page)}).`);
    return false;
  }
  if (!(await fillField(human, page, PASS_INPUT_SEL, password, 'Password', log, { shouldStop }))) {
    return false;
  }

  if (settings.MARKETING_OPT_IN !== false) {
    // Not mandatory: tick it when present, run on when the box is not found.
    const rect = await rectFromJs(page, jsFirst(MARKETING_CHK_SEL));
    if (rect) {
      await clickRect(human, rect);
      log('    [ok] Ticked the newsletter opt-in box');
    } else {
      log('    [i] Newsletter opt-in box not seen — skipping it.');
    }
  }

  await sleep(randFloat(0.3, 0.7) * 1000);
  return clickStep(
    page, human, log, "'Sign up'",
    [jsFirst(SIGNUP_BTN_SEL),
      jsByText(['button'], SIGNUP_BTN_TXT, true)],
    { timeout: 15, shouldStop });
}

// Step 5: fill the birthday (year typed, month/day picked in dropdowns).
// Returns {ok, birthday} with birthday as 'dd/mm/yyyy' (python returned a
// (ok, birthday) tuple). Day stays within 1..28 so it is valid for every month.
export async function stepBirthday(page, human, settings, log, shouldStop = null) {
  log('[>] Step 5: fill the birthday');
  if (!(await waitRect(page, jsFirst(YEAR_INPUT_SEL), { timeout: 25, shouldStop }))) {
    const err = await pageError(page);
    log('    [!] Cannot see the birthday pane'
      + (err ? ` — page says: ${err}` : '') + '.');
    return { ok: false, birthday: null };
  }

  const yMin = intSetting(settings.BIRTH_YEAR_MIN, 1988);
  const yMax = intSetting(settings.BIRTH_YEAR_MAX, 2003);
  const year = randInt(Math.min(yMin, yMax), Math.max(yMin, yMax));
  const month = randInt(1, 12);
  const day = randInt(1, 28);

  if (!(await fillField(human, page, YEAR_INPUT_SEL, String(year), 'Birth year', log, { shouldStop }))) {
    return { ok: false, birthday: null };
  }

  // Month = dropdown #1, Day = dropdown #2 (same class).
  for (const [idx, want, label] of [[0, month, 'Month'], [1, day, 'Day']]) {
    checkStop(shouldStop);
    const selExpr = `document.querySelectorAll('${BIRTH_SELECTOR_SEL}')[${idx}]`;
    const rect = await waitRect(page, selExpr, { timeout: 10, shouldStop });
    if (!rect) {
      log(`    [!] Cannot see the ${label} dropdown.`);
      return { ok: false, birthday: null };
    }
    await clickRect(human, rect);
    await sleep(randFloat(0.4, 0.8) * 1000);

    // The popup opens OUTSIDE the selector's DOM subtree -> find by <li> text.
    // Vietnamese shows 'Tháng 1'; English shows 'January'/'Jan'.
    let optExpr = jsByText([BIRTH_OPTION_SEL], [String(want)], true);
    if (label === 'Month') {
      optExpr = jsByText([BIRTH_OPTION_SEL], [`tháng ${want}`, String(want)], true);
    }
    let opt = await waitRect(page, optExpr, { timeout: 8, shouldStop });
    if (!opt) {
      // Fallback: pick by LIST ORDER (month 1 = element 0).
      optExpr = `document.querySelectorAll('${BIRTH_OPTION_SEL}')[${want - 1}]`;
      opt = await waitRect(page, optExpr, { timeout: 5, shouldStop });
    }
    if (!opt) {
      log(`    [!] Cannot find the ${label} = ${want} option.`);
      return { ok: false, birthday: null };
    }
    await clickRect(human, opt);
    log(`    [ok] ${label}: ${want}`);
    await sleep(randFloat(0.3, 0.6) * 1000);
  }

  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  log(`    [i] Birthday: ${dd}/${mm}/${year}`);
  const ok = await clickStep(
    page, human, log, "'Continue' (birthday)",
    [jsFirst(BIRTH_NEXT_SEL),
      jsByText(['button'], BIRTH_NEXT_TXT, true)],
    { timeout: 15, shouldStop });
  return { ok, birthday: `${dd}/${mm}/${year}` };
}

// Step 6: wait for the 6-digit code in the mailbox, then type it.
// `mailbox` replaces python's rented (otp, order) pair — the seam is
// waitForCode({timeout, interval, log, shouldStop}); it never throws, it
// returns null on a miss.
export async function stepVerifyCode(page, human, mailbox, settings, log, shouldStop = null) {
  log('[>] Step 6: wait for the verification code in the mailbox');
  if (!(await waitRect(page, jsFirst(CODE_INPUT_SEL), { timeout: 30, shouldStop }))) {
    const err = await pageError(page);
    log('    [!] Cannot see the code box'
      + (err ? ` — page says: ${err}` : '') + '.');
    return false;
  }

  const timeout = intSetting(settings.OTP_CODE_TIMEOUT, 300);
  const code = await mailbox.waitForCode({ timeout, interval: 5, log, shouldStop });
  checkStop(shouldStop);
  if (!code) {
    log(`    [!] ${timeout}s elapsed and no code arrived.`);
    return false;
  }
  log(`    [ok] Verification code: ${code}`);

  // The code box is one input maxlength=6 (opacity:0 but still takes keys);
  // the 6 visible squares are just a display layer. Typing all 6 digits makes
  // CapCut advance on its own.
  if (!(await fillField(human, page, CODE_INPUT_SEL, code, 'Verification code', log, { shouldStop }))) {
    return false;
  }
  await sleep(randFloat(1.0, 1.8) * 1000);
  const err = await pageError(page);
  if (err) log(`    [i] Page says: ${err}`);
  return true;
}

// Steps 7-9: name the workspace -> 'Open CapCut' -> 'Skip' the questionnaire ->
// close the 'What's new' modal. Pure UI aftermath: missing any of these never
// loses the account, so failures only log a warning.
export async function stepFinish(page, human, log, shouldStop = null) {
  log("[>] Step 7: name the workspace & click 'Open CapCut'");

  // Workspace box: wait for it, then replace the default name
  // ("user448579073269's space") with a random one. human.fill does its own
  // Ctrl+A so the old name is overwritten — no manual clearing needed. When
  // the box is not found still click on — CapCut accepts the default name.
  if (await waitRect(page, jsFirst(WORKSPACE_INPUT_SEL), { timeout: 25, shouldStop })) {
    const wsName = randomWorkspaceName();
    if (await fillField(human, page, WORKSPACE_INPUT_SEL, wsName, 'Workspace name', log, { shouldStop })) {
      log(`    [ok] Workspace name: ${wsName}`);
    }
  } else {
    log('    [i] Workspace name box not seen — keeping the default name.');
  }

  await clickStep(page, human, log, "'Open CapCut'",
    [jsFirst(OPEN_CAPCUT_SEL),
      jsByText(['button'], OPEN_CAPCUT_TXT)],
    { timeout: 40, shouldStop });
  await waitForDomReady(page, { timeout: 20, settle: [1.0, 1.8] });

  log("[>] Step 8: click 'Skip' on the questionnaire");
  await clickStep(page, human, log, "'Skip'",
    [jsByText([...SKIP_SEL, 'div', 'span', 'button'], SKIP_TXT, true)],
    { timeout: 25, shouldStop });
  await sleep(randFloat(1.0, 1.8) * 1000);

  log("[>] Step 9: close the 'What's new' modal");
  await clickStep(page, human, log, 'the modal close button',
    [jsFirst(MODAL_CLOSE_SEL)],
    { timeout: 20, shouldStop });
  await sleep(randFloat(0.6, 1.2) * 1000);
  return true;
}

// ----------------------------------------------------------------------------
// Saving results
// ----------------------------------------------------------------------------

// 'YYYY-MM-DD HH:MM' local time — python ngay.py's column-5 stamp format.
// The stamp is the account's CREATION date: the Pro trial offer only opens
// within the first 24h, so later steps must never overwrite it (see ngay.py).
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Resolve a config file value against node/ (python resolved against its own
// script dir). Absolute paths pass through untouched.
function resolveDataFile(name) {
  return path.isAbsolute(name) ? name : path.join(NODE_ROOT, name);
}

// Append one `email|password|credits|plan|created` line to the Pro OR free
// file — and to the combined ACCOUNTS_FILE (the DB queue stays the primary
// record; the files are export parity with the python tool).
//
// Column 4 is `Pro` when the trial pack was claimed, `free` otherwise — and
// that same column decides which file the line lands in, so splitting out one
// group later never needs re-filtering. `credits` null (unreadable) writes 0
// so every line still has all columns.
export async function saveAccount(settings, email, password, credits = null, pro = null, log = console.log) {
  const plan = pro ? 'Pro' : 'free';
  const planFile = resolveDataFile(
    (pro ? settings.PRO_FILE : settings.FREE_FILE) || (pro ? 'capcut_pro.txt' : 'capcut_free.txt'));
  const allFile = resolveDataFile(settings.ACCOUNTS_FILE || 'capcut_accounts.txt');
  const credit = Number.isInteger(credits) ? credits : 0;
  const line = `${email}|${password}|${credit}|${plan}|${nowStamp()}`;
  // Dedupe when config points both writers at the same path.
  const targets = [...new Set([planFile, allFile])];
  let ok = true;
  await SAVE_MUTEX.run(async () => {
    for (const t of targets) {
      try {
        appendLine(t, line);
      } catch (e) {
        ok = false;
        log(`    [!] Could not write ${t}: ${e && e.message ? e.message : e}`);
      }
    }
  });
  if (ok) log(`    [ok] Saved: ${line}`);
  return ok;
}

// ----------------------------------------------------------------------------
// Credit tasks
// ----------------------------------------------------------------------------

// Total credit the currently logged-in account holds (0 when unreadable).
// Used for the credit column when tasks did NOT run: a fresh account is still
// granted 520 credit — writing 0 would be wrong data.
export async function readCreditTotal(page, log = console.log) {
  try {
    return creditTotal(await getCredit(page));
  } catch (e) {
    log(`    [i] Could not read credit (${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}).`);
    return 0;
  }
}

// Read an integer setting with a default (python getattr(settings, k, d) +
// int()). NaN-safe: a hand-edited config falls back to the default.
function intSetting(value, fallback) {
  const n = Number.parseInt(value ?? fallback, 10);
  return Number.isFinite(n) ? n : fallback;
}

// After signup, auto-complete the credit tasks (when DO_TASKS=true).
//
// Only runs in SIGNUP_MODE='api': the `/luckycat/...` API group needs the
// signature the in-page SDK injects, and 'ui' mode ends on a different screen
// so the tab may no longer be on capcut.com with the SDK loaded.
//
// Task errors never fail the account: the signup is already saved, tasks are
// only the bonus. Returns the total credit afterwards (or null when unknown —
// null makes signupOne re-read it itself; returning 0 here would write 0 to
// the file for an account actually holding the 520 gift credit).
export async function doTasksIfEnabled(page, settings, log = console.log, shouldStop = null) {
  if (!settings.DO_TASKS) return null;
  const mode = String(settings.SIGNUP_MODE || 'api').toLowerCase();
  if (mode !== 'api') {
    log("[i] DO_TASKS only runs with SIGNUP_MODE='api' — skipping the tasks.");
    return null;
  }
  try {
    log('[>] Auto-completing the credit tasks ...');
    // After register_verify_login the tab is still on the login page; reload
    // so the SDK is ready and the fresh session cookie takes effect.
    await warmUp(page, { localePath: settings.CAPCUT_LOCALE || 'vi-vn', log, shouldStop });
    const delayMin = Number(settings.TASK_DELAY_MIN ?? 0.8);
    const delayMax = Number(settings.TASK_DELAY_MAX ?? 1.6);
    // CAPCUT_FAST: cap the ripening wait once the task list exists (credit
    // only moves AFTER the actions in the grant_reward flow — the credit>0
    // gate alone burns the full 150s every run).
    const readyAfter = Number(settings.TASKS_READY_AFTER_SECONDS ?? 0) || 0;
    let res = await runAllTasks(page, { log, shouldStop, delayMin, delayMax, readyAfterSeconds: readyAfter });
    let after = res.creditAfter;
    // Not enough tasks done yet -> sweep ONE more pass. runAll already retries
    // each failed task, but sometimes the whole list is not ready on the first
    // pass — measured on a 96-account batch: 17% got 0 credit for that reason.
    // Gate on total==0 WITH work done (the old <2060 gate is stale: daily
    // task credits cap at ~1540 and would always re-trigger). CAPCUT_FAST
    // skips the sweep entirely — its final ledger read is the verdict.
    const needSweep = settings.CAPCUT_FAST
      ? false
      : creditTotal(after) === 0 && res.done.length > 0;
    if (needSweep) {
      log(`    [i] only ${creditTotal(after)}/${FULL_TASK_CREDIT} credit — sweeping the tasks one more pass`);
      // Reload the session first: after pass one the tab sits on /my-edit,
      // account/info reads come back empty and pass two dies right away at
      // "Not logged in" (really hit at 05:39 on 2026-08-31).
      await warmUp(page, { localePath: settings.CAPCUT_LOCALE || 'vi-vn', log, shouldStop });
      const res2 = await runAllTasks(page, { log, shouldStop, delayMin, delayMax, readyAfterSeconds: readyAfter });
      if (creditTotal(res2.creditAfter) > creditTotal(after)) {
        res = res2;
        after = res2.creditAfter;
      }
    }
    if (!after || Object.keys(after).length === 0) {
      // Credit unreadable after tasks: return null so signupOne re-reads it.
      log('    [!] Could not read credit after the tasks — will re-read.');
      return null;
    }
    const total = creditTotal(after);
    log(`    [ok] Done ${res.done.length} tasks, +${res.gained} credit (total ${total}).`);
    return total;
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    log(`    [!] Task error (${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}) — account kept.`);
    return null;
  }
}

// Claim the 7-day free Pro trial after the tasks, when enabled.
//
// Needs `netlog`: the claim reads the .jsonl back for `cashier_url` and
// VERIFIES the amount due is 0 before any card is typed. Without netlog there
// is no way to verify -> skip: a real card must not go into an unchecked
// order.
//
// The real flow (python claim_pro_if_enabled body) lives in upgrade-pro.js
// claimPro: wallet order per CLAIM_METHOD ('card' -> capcut-pro claimTrial
// with the dealt cards; anything else -> capcut-zalopay claimTrialZalopay
// with the QR queue). Claim errors never fail the account: it and its
// credits already exist. Returns the payload object on success, null when
// not claimed.
export async function claimProIfEnabled(page, human, tab, settings, netlog = null,
  log = console.log, shouldStop = null, email = '') {
  if (!settings.DO_CLAIM_PRO) return null;
  const mode = String(settings.SIGNUP_MODE || 'api').toLowerCase();
  if (mode !== 'api') {
    log("[i] DO_CLAIM_PRO only runs with SIGNUP_MODE='api' — skipping.");
    return null;
  }
  if (!netlog) {
    log('[!] DO_CLAIM_PRO needs netlog recording to verify the amount (run with --netlog) — skipping so no card goes into an unchecked order.');
    return null;
  }
  return claimPro(page, human, tab, settings, netlog, log, shouldStop, email);
}

// ----------------------------------------------------------------------------
// One complete account
// ----------------------------------------------------------------------------

// Time each stage of one account, then print a one-line summary. Only with
// numbers do you know where to cut: before this, "slow signup" was just a
// feeling while most of the time sat in waiting for the OTP mail, not the
// tool. (python class _DongHo.)
export class ProgressTimer {
  // `log` receives the per-stage and summary lines.
  constructor(log = console.log) {
    this.log = log;
    this.lastMark = Date.now();
    this.stages = [];
  }

  // Mark the end of a stage; log its duration in seconds.
  done(name) {
    const secs = (Date.now() - this.lastMark) / 1000;
    this.lastMark = Date.now();
    this.stages.push([name, secs]);
    this.log(`    [⏱] ${name}: ${secs.toFixed(1)}s`);
  }

  // One line: total seconds plus every stage. No-op when nothing was timed.
  summary() {
    if (!this.stages.length) return;
    const total = this.stages.reduce((s, [, g]) => s + g, 0);
    const detail = this.stages.map(([t, g]) => `${t} ${g.toFixed(0)}s`).join(' | ');
    this.log(`[⏱] Total ${total.toFixed(0)}s — ${detail}`);
  }
}

// Run the tasks + Pro claim + write the account to file. Wrapped in
// try/finally: the account is already created — a task or claim error must
// never lose it.
async function finishAccount(page, human, tab, settings, netlog, email, password,
  birthday, timer, log, shouldStop, printSummary = true) {
  let credits = null;
  let pro = null;
  try {
    credits = await doTasksIfEnabled(page, settings, log, shouldStop);
    if (printSummary) timer.done('tasks');
    pro = await claimProIfEnabled(page, human, tab, settings, netlog, log, shouldStop, email);
    if (printSummary) timer.done('claim Pro');
  } finally {
    // Tasks not run -> still read the balance: a fresh account already holds
    // 520 gift credit, writing 0 to the file would be wrong data.
    if (credits == null) credits = await readCreditTotal(page, log);
    // After a successful Pro claim the credit changed (the pack's vip_credit
    // added) — prefer the number read AFTER going Pro, else the file keeps
    // the stale one.
    if (pro && typeof pro === 'object' && pro.credits) credits = pro.credits;
    await saveAccount(settings, email, password, credits, pro, log);
    if (printSummary) timer.summary();
  }
  return { email, password, birthday, credits, pro };
}

// MAIL_PROVIDER='okotp' path: rent ONE paid gmail from okotp.com and rebind
// the DB row to it (the node counterpart of python signup's mailbox-rental
// branch). createOrder COSTS REAL MONEY — called exactly once per signup
// attempt, and only AFTER warmUp already proved the network works (see
// signupOne: no mailbox is rented for a dead proxy). The rented address
// REPLACES the row's placeholder email via setCapcutEmail so accounts.db
// stays the source of truth; the returned mailbox reads the OTP code from
// okotp polling, never IMAP. Throws OkotpError on any rental/config problem.
async function rentOkotpGmail(settings, username, { log = () => {} } = {}) {
  const okotpKey = String(settings.OTP_API_KEY || process.env.OTP_API_KEY || '').trim();
  if (!okotpKey) {
    throw new OkotpError('OTP_API_KEY is empty — set it in config.js or the repo-root .env (MAIL_PROVIDER=okotp).');
  }
  if (!String(settings.OTP_SERVICE_ID || '').trim() || !String(settings.OTP_EMAIL_TYPE_ID || '').trim()) {
    // Refuse rather than fall back to okotp.js's GitHub-service defaults: a
    // rented mailbox on the WRONG service still costs real money.
    throw new OkotpError('OTP_SERVICE_ID / OTP_EMAIL_TYPE_ID must be set in config.js (MAIL_PROVIDER=okotp).');
  }
  const client = new OkotpClient(okotpKey, {
    baseUrl: settings.OTP_BASE || undefined,
    log,
  });
  log('[>] Renting an OKOTP gmail (PAID) ...');
  const order = await client.createOrder({
    serviceId: String(settings.OTP_SERVICE_ID),
    emailTypeId: String(settings.OTP_EMAIL_TYPE_ID),
  });
  const rented = String(order.email || '').trim();
  if (!rented) throw new OkotpError('Order came back without an email address.');
  // Short-lived OWN db handle (runBulk / the CLI hold theirs; WAL allows the
  // concurrent write) — closed immediately to keep the lock window tiny.
  const db = openAccountsDb(settings.ACCOUNTS_DB || '');
  try {
    ensureCapcutColumns(db);
    setCapcutEmail(db, username, rented);
  } finally {
    db.close();
  }
  return { email: rented, mailbox: makeOrderMailbox(client, order, { log }) };
}

// Sign up ONE CapCut account from a claimed DB row: open a throwaway stealth
// browser -> bind the row's mailbox -> sign up.
//
// Two modes, chosen by settings.SIGNUP_MODE:
//   'api' (default) — 4 in-page fetch calls, no clicking/typing. Far faster
//                     because it never waits for the SPA to animate through
//                     the 9 screens. Chrome is still needed: only the page's
//                     SDK can sign CapCut requests.
//   'ui'             — click/type through the 9 screens like a real human.
//                     Slower but independent of the API shape, so it is the
//                     fallback when CapCut changes its API.
//
// `account` is the claimed accounts.db row — the ONLY credential source
// (python generated the password in-engine; the DB queue replaced that).
// `netlogPath`: a .jsonl file path; when set, every request during the run is
// recorded (see src/browser/netlog.js).
//
// Returns {email, password, birthday, credits, pro} on success, null on
// failure. The DB mark (registered/poisoned/released) is the CALLER's job —
// signupOne only performs the signup itself.
export async function signupOne(settings, { account, log = console.log, shouldStop = null, netlogPath = null } = {}) {
  shouldStop = shouldStop || defaultShouldStop;
  const username = String(account && account.username || '').trim();
  // `let`: with MAIL_PROVIDER='okotp' this becomes the RENTED gmail for the
  // rest of the run (DB rewrite + form fill + files all use the rented one).
  let email = String(account && account.email || '').trim();
  const password = String(account && account.password || '').trim();
  if (!username || !email || !password) {
    log('[!] Account row is missing username/email/password — cannot sign up.');
    return null;
  }

  const timer = new ProgressTimer(log);
  let handle = null;
  let recorder = null;
  let mailbox = null;
  try {
    // One throwaway stealth profile per account, named after the username
    // (python opened a per-account GPM profile instead).
    handle = await openBrowser(settings, {
      name: username,
      rawProxy: settings.RAW_PROXY ?? null,
      log,
      shouldStop,
    });
    timer.done('open browser');
    const human = new HumanInput(handle.page);
    if (netlogPath) {
      recorder = new NetworkRecorder({ target: handle.page, outPath: netlogPath, log });
      await recorder.start();
    }

    const mode = String(settings.SIGNUP_MODE || 'api').toLowerCase();

    // Try loading capcut.com BEFORE binding the mailbox. On a dead proxy the
    // page cannot load, the SDK never hooks fetch and every API after that
    // returns "Failed to fetch" — hit at 02:49 on 2026-08-31, one mailbox
    // wasted for nothing. Checking first costs seconds, not money (and with
    // the own-domain mailbox there is nothing to rent anyway — the check just
    // fails fast on a broken network).
    if (mode === 'api') {
      const okWarm = await warmUp(handle.page, {
        localePath: settings.CAPCUT_LOCALE || 'vi-vn',
        log,
        shouldStop,
      });
      if (!okWarm) {
        log('[!] Proxy/network cannot load capcut.com — dropping this account.');
        return null;
      }
    }

    // Bind the mailbox — provider branch on settings.MAIL_PROVIDER:
    //   'own' (default) — own-domain IMAP catch-all bound to the row's
    //     pre-provisioned email; throws only when MAIL_PASS is missing
    //     (original path, untouched).
    //   'okotp' — rent a paid gmail (REAL MONEY: createOrder debits the okotp
    //     balance) and let it REPLACE the row email: the rented address is
    //     written back to accounts.db (setCapcutEmail) and used for the whole
    //     signup; the code then comes from okotp polling, never IMAP. An
    //     OkotpDead thrown out of waitForCode propagates and fails the
    //     account fast — python re-rented dead boxes here; the node port
    //     releases the row instead (the next attempt rents a fresh one).
    if (String(settings.MAIL_PROVIDER || 'own').toLowerCase() === 'okotp') {
      try {
        const rent = await rentOkotpGmail(settings, username, { log });
        email = rent.email; // rented gmail replaces the row's placeholder
        mailbox = rent.mailbox;
      } catch (e) {
        log(`[!] Cannot rent an OKOTP gmail: ${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`);
        return null;
      }
    } else {
      try {
        mailbox = await makeMailbox({ settings, email, log, shouldStop });
      } catch (e) {
        log(`[!] Cannot open the mailbox: ${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`);
        return null;
      }
    }
    timer.done('open mailbox');
    log(`    [ok] Mailbox: ${email}`);

    if (mode === 'api') {
      // The mailbox seam replaces python's rented order; signupViaApi handles
      // code resends internally (python re-rented dead mailboxes here — moot
      // for an own-domain mailbox that cannot die).
      const r = await signupViaApi(handle.page, mailbox, email, password, settings, { log, shouldStop });
      if (!r.ok) return null;
      timer.done('signup');
      log(`[ok] Signup done: ${email}`);
      return await finishAccount(handle.page, human, handle.page, settings, netlogPath,
        email, password, r.birthday, timer, log, shouldStop);
    }

    // 'ui' mode: the 9 screens. python passed the rented (otp, order) pair;
    // the mailbox seam replaces both.
    if (!(await stepOpenLogin(handle.page, human, settings, log, shouldStop))) return null;
    if (!(await stepFillEmail(handle.page, human, email, log, shouldStop))) return null;
    if (!(await stepFillPassword(handle.page, human, settings, password, log, shouldStop))) return null;
    const birth = await stepBirthday(handle.page, human, settings, log, shouldStop);
    if (!birth.ok) return null;
    if (!(await stepVerifyCode(handle.page, human, mailbox, settings, log, shouldStop))) return null;
    await stepFinish(handle.page, human, log, shouldStop);

    timer.done('signup');
    log(`[ok] Signup done: ${email}`);
    return await finishAccount(handle.page, human, handle.page, settings, netlogPath,
      email, password, birth.birthday, timer, log, shouldStop);
  } finally {
    if (recorder) {
      try { await recorder.stop(); } catch { /* best-effort */ }
    }
    if (mailbox) {
      try { await mailbox.release(); } catch { /* soft-fail, must not mask the result */ }
    }
    // Always close the browser (python kept it open when CLOSE_AFTER_DONE was
    // false — a leftover Chromium per account would leak processes here). The
    // profile DIR survives when settings.DELETE_PROFILE_AFTER is false, which
    // is the part that actually matters for --keep-profile.
    if (handle) {
      await closeBrowser(handle, { log, settings });
    }
  }
}

// ----------------------------------------------------------------------------
// Worker pool
// ----------------------------------------------------------------------------

// Create up to `total` CapCut accounts with at most `concurrency` workers.
//
// Each account: its own throwaway stealth profile (named after the claimed
// row's username), proxy dealt round-robin per WORKER SLOT, credentials from
// the DB queue (claimed atomically, marked registered / poisoned / released).
// Workers stop cleanly on an empty queue or when shouldStop() fires (SIGINT).
//
// Returns the per-account results (true/false) in completion order.
export async function runBulk(settings, { total = 5, concurrency = 2, proxyList = null,
  log = console.log, shouldStop = null, deleteProfile = true, netlogDir = null } = {}) {
  shouldStop = shouldStop || defaultShouldStop;

  // --total override (python TONG_TAI_KHOAN): use the stated TOTAL directly,
  // one mailbox per account. (A one-mailbox-many-accounts scheme with Gmail
  // variants was tried — CapCut normalizes both `+n` and dots, it cannot work.)
  const tong = Number.parseInt(settings.TONG_TAI_KHOAN || 0, 10);
  if (tong > 0) total = tong;
  total = Math.max(1, Math.trunc(total) || 1);
  concurrency = Math.max(1, Math.min(Math.trunc(concurrency) || 1, total));

  // Proxy lanes: PROXY_LIST dealt round-robin per worker SLOT (a lane sticks
  // to its slot for the whole run); empty list -> RAW_PROXY for everyone;
  // neither -> machine IP.
  const lanes = (proxyList || []).map((p) => String(p || '').trim()).filter(Boolean);
  if (!lanes.length) {
    const raw = String(settings.RAW_PROXY || '').trim();
    if (raw) lanes.push(raw);
  }
  const machineIp = lanes.length === 0;
  if (machineIp) lanes.push(null); // placeholder lane = machine IP

  // DB queue: claim -> signup -> mark. Every worker shares this handle
  // (DatabaseSync is synchronous; claimNextCapcut is a single UPDATE..RETURNING
  // so claims can never collide).
  const db = openAccountsDb(settings.ACCOUNTS_DB || '');
  ensureCapcutColumns(db);
  const stats = capcutStats(db);

  log('\n' + '='.repeat(64));
  log(` CapCut: create ${total} accounts, ${concurrency} workers in parallel`);
  // Mail banner per provider so a paid okotp run is announced as such.
  log(String(settings.MAIL_PROVIDER || 'own').toLowerCase() === 'okotp'
    ? ` Mail: OKOTP rented gmails (PAID, serviceId=${settings.OTP_SERVICE_ID})`
    : ` Mail: own-domain IMAP catch-all @${settings.EMAIL_DOMAIN || 'thanhphuonglatoi.com'}`);
  if (machineIp) {
    log(' Proxy: NONE — every account shares the machine IP (easily blocked).');
  } else {
    log(` Proxy pool: ${lanes.length} proxies (round-robin, one lane per worker slot).`);
    if (concurrency > lanes.length) {
      log(`  [!] ${concurrency} workers > ${lanes.length} proxies -> some workers share an IP.`);
    }
  }
  log(` Mode: ${String(settings.SIGNUP_MODE || 'api').toLowerCase()}`
    + `${settings.DO_TASKS ? ' + credit tasks' : ''}`
    + `${settings.DO_CLAIM_PRO ? ' + Pro claim' : ''}`);
  log(` Queue: ${stats.unregistered} unregistered row(s) waiting`);
  log('='.repeat(64));

  const results = [];
  const failCounts = new Map(); // username -> consecutive failures (poison at MAX_SIGNUP_FAILS)
  let claimNo = 0;              // monotonic worker id for log prefixes / netlog names
  let queueEmptyLogged = false;

  // One worker slot: keep claiming rows off the queue until it drains or the
  // stop flag fires. All DB marks happen here — signupOne stays mark-free.
  const worker = async (slot) => {
    const proxy = lanes[slot % lanes.length];
    while (!shouldStop()) {
      const row = claimNextCapcut(db);
      if (!row) {
        if (!queueEmptyLogged) {
          queueEmptyLogged = true;
          log('[i] Account queue empty — workers winding down.');
        }
        return;
      }
      const wid = ++claimNo;
      const wlog = (msg) => log(`[#${wid}] ${msg}`);
      const username = String(row.username || '');

      // Per-account settings: this slot's proxy lane + profile-delete policy.
      const ws = { ...settings, RAW_PROXY: proxy ?? null, DELETE_PROFILE_AFTER: deleteProfile };

      wlog(`▶ Starting account ${username} (proxy: ${proxy || 'none'}, profile: ${username})`);
      const nl = netlogDir ? path.join(netlogDir, `net-${wid}.jsonl`) : null;
      let acc = null;
      let stoppedBySignal = false;
      try {
        acc = await signupOne(ws, { account: row, log: wlog, shouldStop, netlogPath: nl });
      } catch (e) {
        if (e instanceof StopRequested) {
          stoppedBySignal = true;
          wlog('[!] Stopped.');
        } else {
          wlog(`[!] Error: ${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`);
        }
      }
      try {
        if (acc) {
          markCapcutRegistered(db, username, {
            credits: Number.isInteger(acc.credits) ? acc.credits : null,
            plan: acc.pro ? 'pro' : 'free',
          });
          failCounts.delete(username);
        } else if (stoppedBySignal || shouldStop()) {
          // User stop: transient by definition — release without counting a
          // failure (two stops on the same row must never poison it).
          releaseCapcut(db, username);
        } else {
          // Failure: transient by assumption (proxy/network/code timeout) ->
          // release back to the queue. Same row failing repeatedly is a hard
          // error (e.g. its email already burned) -> poison it.
          const fails = (failCounts.get(username) || 0) + 1;
          failCounts.set(username, fails);
          if (fails >= MAX_SIGNUP_FAILS) {
            markCapcutPoisoned(db, username, 'signup-failed');
            wlog(`[db] poisoned ${username} after ${fails} failed attempt(s).`);
          } else {
            releaseCapcut(db, username);
          }
        }
      } catch (e) {
        wlog(`[!] DB mark error: ${e && e.message ? e.message : e}`);
      }
      results.push(Boolean(acc));
      wlog(`${acc ? '✔ Done' : '✖ Failed/Stopped'} account ${username}.`);
    }
  };

  const workers = [];
  for (let s = 0; s < concurrency; s++) {
    if (shouldStop()) break;
    workers.push(worker(s));
    if (s < concurrency - 1) {
      // Stagger launches (python staggered GPM starts 2s apart so port/profile
      // startup does not pile up — same reasoning for N Chromium launches).
      await sleep(2000);
    }
  }
  await Promise.all(workers);

  try { db.close(); } catch { /* already closed */ }
  const done = results.filter(Boolean).length;
  log('\n' + '='.repeat(64));
  log(` Result: ${done}/${total} accounts succeeded`);
  log('='.repeat(64));
  return results;
}

// ----------------------------------------------------------------------------
// Config validation
// ----------------------------------------------------------------------------

// List of configuration problems (empty = valid). Mail checks are
// provider-aware: 'own' validates the IMAP catch-all (MAIL_PASS via .env,
// EMAIL_DOMAIN — validateMail); 'okotp' validates the rental key instead
// (python: "Chưa nhập OTP_API_KEY của okotp.com" — OTP key missing).
export function validate(settings = {}) {
  const errs = [];
  const mode = String(settings.SIGNUP_MODE || 'api').toLowerCase();
  if (mode !== 'api' && mode !== 'ui') {
    errs.push(`SIGNUP_MODE must be 'api' or 'ui' (got '${mode}').`);
  }
  const y1 = intSetting(settings.BIRTH_YEAR_MIN, 1988);
  const y2 = intSetting(settings.BIRTH_YEAR_MAX, 2003);
  if (!(1900 < y1 && y1 <= y2 && y2 < 2020)) {
    errs.push('BIRTH_YEAR_MIN/MAX invalid (need 1900 < min <= max < 2020).');
  }
  // Mail readiness, per provider (MAIL_PASS lives in the repo-root .env, not
  // config.js; the okotp path never touches IMAP so MAIL_PASS is not needed).
  if (String(settings.MAIL_PROVIDER || 'own').toLowerCase() === 'okotp') {
    if (!String(settings.OTP_API_KEY || process.env.OTP_API_KEY || '').trim()) {
      errs.push('OTP_API_KEY is not set (config.js or .env) — MAIL_PROVIDER=okotp rents gmails from okotp.com and cannot run without it.');
    }
  } else {
    errs.push(...validateMail(settings));
  }
  return errs;
}
