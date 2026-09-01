// CLAIM THE 7-DAY PRO FREE TRIAL (0₫) for a freshly created CapCut account.
// Port of capcut_pro.py; every measured-behavior note is kept (translated) —
// it is the real documentation of this flow.
//
// Chain verified via netlog + a real run (charge_id 27982a7ae01f...):
//
//   UI: click "Upgrade" (top bar) -> plan table -> "Upgrade" inside the Pro
//   card -> the page itself POSTs /commerce/v3/trade/init_trade (returns
//   cashier_url) -> open the pipopay cashier_url, fill the card, click
//   "Start free trial" -> pipo: get_unified_bin_detail -> payment/v1/cert ->
//   authen_pre_risk -> bind_and_active_agreement (result_code=redirect,
//   3-D Secure) -> query_active_agreement_result (poll) -> get_pay_result:
//   SUCCESS
//
// Four lessons learned by experiment — do not drop them:
//
// 1. `init_trade` could NOT be called bare at first: in-page fetch (even from
//    /ai-design or /my-space, with sku_id/pms_trade taken from cc_price_list
//    itself) returned `ret 36010101 "init trade err: unknown"`. Only letting
//    the page call it via a real click worked, which is why claimTrial still
//    follows the UI. Later it was measured (31/08/2026) that the SAME call
//    DOES go through the API when the tab first returns to a commerce page
//    (openCommercePage) — that is the fast path openOrderViaApi uses; calling
//    from a login page still fails with ret=36010117.
//
// 2. The 0₫ offer does NOT exist for every account. Measured on 8 accounts:
//    some get `data:{}` and an empty `resource_position` from
//    campaign/v1/capcut/web/resource -> the top bar never renders the
//    "Upgrade" button, there is no way in. The right handling is to SWITCH
//    ACCOUNT + SWITCH IP and try again, so claimTrial returns 'retry' for the
//    caller to act on.
//
// 3. The old GPM profile viewport was only ~1264x805 while the Pro-card button
//    sits at y≈838 -> OFF screen; CDP Input clicks miss silently (no
//    init_trade in the netlog). The Node browser.js default (1280x900) has the
//    same trap — setViewport must raise it to 1600x1200 before clicking.
//
// 4. The confirm button only enables when ALL 4 fields are filled, INCLUDING
//    `holder_name`. And NEVER match the button by the word "pay": "ZaloPay" /
//    "Apple Pay" / "Google Pay" are wallet-selector buttons, always enabled —
//    clicking one by mistake loses the whole flow.
//
// MONEY SAFETY: only fill a card when pre_order_details.amount == 0. The base
// 222,000₫ plan is charged IMMEDIATELY, no trial — anything non-zero stops
// the flow with ('stop', ...).

import { checkStop, defaultShouldStop, waitForDomReady } from '../browser/browser.js';
import { makeMutex, readLines, sleep } from '../util/util.js';

// Viewport override so the Pro-card button lands inside the screen (lesson 3).
export const VIEW_W = 1600;
export const VIEW_H = 1200;

// The REAL confirm-button keywords. NEVER a bare "pay" (matches ZaloPay /
// Apple Pay / Google Pay — Vietnamese + English UI texts, do not translate).
export const CONFIRM_KW = [
  'bắt đầu dùng thử', 'dùng thử miễn phí', 'bắt đầu', 'thanh toán',
  'xác nhận', 'hoàn tất', 'start free trial', 'start trial',
  'subscribe', 'confirm', 'place order',
];

// Wallet-selector buttons — skipped while looking for the confirm button.
export const WALLET_KW = ['momo', 'zalopay', 'apple pay', 'google pay', 'vnpay', 'paypal'];

// Error codes meaning "this card / method cannot be used" -> try another card.
// RISK_REJECTED: pipo blocks for risk (card or context); the rest are the
// card's own fault. Anything NOT in this group is a flow problem — swapping
// cards is pointless there.
export const CARD_ERRORS = [
  'RISK_REJECTED', 'CARD_DECLINED', 'DECLINED',
  'INSUFFICIENT_FUNDS', 'INVALID_CARD', 'CARD_EXPIRED',
  'DO_NOT_HONOR', 'PAYMENT_METHOD_NOT_SUPPORTED',
  'BIN_NOT_SUPPORTED', 'AUTH_FAILED', 'CVV',
];

// Find every "Nâng cấp" / "Upgrade" button/link currently in the viewport,
// sorted top-first. Read-only anonymous IIFE (leaves no trace in the page).
// Vietnamese UI text is part of the match — keep verbatim.
const JS_ANY_UPGRADE = String.raw`(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const res = [];
    document.querySelectorAll('button, [role=button], a').forEach(n => {
        const t = norm(n.innerText);
        if (!t || t.length > 60) return;
        if (!/(Nâng cấp|Upgrade)/.test(t)) return;
        const r = n.getBoundingClientRect();
        if (r.width < 20 || r.height < 12) return;
        if (r.top < 0 || r.bottom > innerHeight) return;
        res.push({x: r.left + r.width / 2, y: r.top + r.height / 2,
                  text: t, top: Math.round(r.top)});
    });
    res.sort((a, b) => a.top - b.top);
    return res;
})()`;

// Close an onboarding overlay ("Đã hiểu"/"Got it"/...) by clicking its button.
// Read-only scan; null when no overlay button is visible.
const JS_CLOSE_OVERLAY = String.raw`(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    for (const b of document.querySelectorAll('button,[role=button]')) {
        const t = norm(b.innerText);
        if (!/^(Đã hiểu|Got it|OK|Bỏ qua|Skip|Để sau|Not now)$/.test(t)) continue;
        const r = b.getBoundingClientRect();
        if (r.width < 8) continue;
        return {x: r.left + r.width / 2, y: r.top + r.height / 2, text: t};
    }
    return null;
})()`;

// A REAL Pro card must have BOTH the base price, "0₫" and "7 days" -> that is
// the trial plan. Finds the outermost such card and its smallest clickable
// button, scrolls it into view, returns text + click point. Read-only.
const JS_PRO_BTN = String.raw`(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    let card = null;
    document.querySelectorAll('div, section, li').forEach(n => {
        const t = norm(n.innerText);
        if (!t || t.length < 40 || t.length > 700) return;
        if (!/(₫|VND)/.test(t) || !/\bPro\b/.test(t)) return;
        if (!/(7 ngày|7 days)/.test(t)) return;
        const r = n.getBoundingClientRect();
        if (r.width < 150 || r.height < 200) return;
        let inner = false;
        n.querySelectorAll('div, section, li').forEach(c => {
            const ct = norm(c.innerText);
            if (ct.length > 40 && /\bPro\b/.test(ct)
                && /(7 ngày|7 days)/.test(ct) && ct.length > t.length * 0.8)
                inner = true;
        });
        if (inner) return;
        if (!card) card = n;
    });
    if (!card) return {error: 'no Pro card with a 0d trial offer found'};
    let btn = null, area = 1e9;
    card.querySelectorAll('button, [role=button], a, div, span').forEach(b => {
        const t = norm(b.innerText);
        if (!t || t.length > 40) return;
        if (!/(Nâng cấp|Upgrade|Dùng thử|Try)/.test(t)) return;
        const r = b.getBoundingClientRect();
        if (r.width < 40 || r.height < 16) return;
        const a = r.width * r.height;
        if (a < area) { area = a; btn = b; }
    });
    if (!btn) return {error: 'no button found inside the Pro card'};
    btn.scrollIntoView({block: 'center', inline: 'center'});
    const r = btn.getBoundingClientRect();
    return {cardText: norm(card.innerText).slice(0, 400),
            text: norm(btn.innerText),
            x: r.left + r.width / 2, y: r.top + r.height / 2,
            inView: r.top >= 0 && r.bottom <= innerHeight};
})()`;

// Snapshot the cashier page: every visible input (name/id/type/placeholder/
// aria/maxlength/value + click point) and every button (text/disabled/point).
// Read-only — this is how the card form and the confirm button are found
// (pipo's classes are hashed, so only structural signals are stable).
const JS_CASHIER = String.raw`(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const out = {url: location.href, fields: [], buttons: []};
    document.querySelectorAll('input').forEach(i => {
        const r = i.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        out.fields.push({name: i.name || '', id: i.id || '',
            type: i.type || '', ph: i.placeholder || '',
            aria: i.getAttribute('aria-label') || '',
            max: i.getAttribute('maxlength') || '', value: i.value || '',
            x: r.left + r.width / 2, y: r.top + r.height / 2,
            inView: r.top >= 0 && r.bottom <= innerHeight});
    });
    document.querySelectorAll('button, [role=button]').forEach(b => {
        const t = norm(b.innerText);
        const r = b.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return;
        out.buttons.push({text: t.slice(0, 80), disabled: !!b.disabled,
            x: r.left + r.width / 2, y: r.top + r.height / 2,
            inView: r.top >= 0 && r.bottom <= innerHeight});
    });
    return out;
})()`;

// Expand the "Credit / debit card" section on the cashier. First visit has it
// open, but after a RELOAD (trying another card) it collapses -> 0 inputs.
// Match the DESCRIPTIVE phrase, never a bare 'card' ('card' also matches
// 'Mastercard' — that is a brand logo, clicking it opens nothing).
const JS_EXPAND_CARD = String.raw`(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    // A card-number input already present -> nothing to click.
    for (const i of document.querySelectorAll('input')) {
        const r = i.getBoundingClientRect();
        if (r.width > 4 && /card_number|cardnumber/i.test(i.name || '')) return null;
    }
    const want = /(Thẻ tín dụng|thẻ ghi nợ|Credit\s*\/?\s*debit|Debit\s*\/?\s*credit|Credit card|Debit card)/i;
    const wallet = /(momo|zalopay|apple pay|google pay|vnpay|paypal|mastercard|visa|jcb|amex)/i;
    let best = null, area = 1e9;
    document.querySelectorAll('button, [role=button], [class*=method], li, div')
        .forEach(n => {
            const t = norm(n.innerText);
            if (!t || t.length > 120) return;
            if (!want.test(t) || wallet.test(t)) return;
            const r = n.getBoundingClientRect();
            if (r.width < 60 || r.height < 20) return;
            if (r.top < 0 || r.top > innerHeight) return;
            const a = r.width * r.height;
            if (a < area) { area = a; best = {x: r.left + r.width / 2,
                                             y: r.top + r.height / 2,
                                             text: t.slice(0, 60)}; }
        });
    return best;
})()`;

// ---------------------------------------------------------------------------
// Reading order state from the netlog file
// ---------------------------------------------------------------------------

// Race page.evaluate against a hard timeout — parity with pychrome's
// Runtime.evaluate `_timeout` (Playwright's evaluate has no per-call timeout).
// The error carries name 'TimeoutException' like pychrome's, so callers can
// keep Python's distinction: a transport timeout escapes, a page-side JS error
// is swallowed. (Duplicated from capcut-tasks.js on purpose: no shared
// contract slot, same as capcut-api.js.)
async function evalTimed(page, expr, timeoutMs = 60000) {
  const work = page.evaluate(expr);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`page.evaluate timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutException'; // same name pychrome raised, for log parity
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {}); // swallow the losing promise's late rejection
  }
}

// In-page JSON POST so the SDK signs it (identical rules to capcut-api.js /
// capcut-tasks.js: `credentials:'include'`, NEVER add X-Bogus / X-Gnarly /
// msToken / device-time / sign by hand — the hooked fetch adds them itself
// and hand-adding BREAKS the signature). Response body truncated to 1200
// chars for logging, `json` holds the full parse. Python imported `_post`
// from capcut_tasks; the Node port keeps that helper module-private, so it is
// deliberately duplicated here (same policy as evalTimed).
const JS_POST_FN = `(async (url, payload) => {
    try {
        const r = await window.fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload),
        });
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch (e) {}
        return {status: r.status, ok: r.ok, json: j, text: t.slice(0, 1200)};
    } catch (e) {
        return {status: 0, ok: false, json: null, text: String(e)};
    }
})`;

// Marshal a JSON POST through the page (SDK signs it). Args are embedded as
// JSON literals — same technique as Python's json.dumps + %s substitution.
async function postJson(page, url, payload, timeoutMs = 60000) {
  const expr = `${JS_POST_FN}(${JSON.stringify(url)}, ${JSON.stringify(payload)})`;
  return evalTimed(page, expr, timeoutMs);
}

// Log-format helper: Python printed missing dict values as "None" — keep the
// log lines recognizable for anyone diffing old vs new runs.
function fmt(v) {
  return v === undefined || v === null ? 'None' : String(v);
}

// Python dict/list truthiness: {} / [] / None are falsy, any content is true.
// commerce-api payloads are dicts or lists, so this covers unwrap checks.
function isFilled(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

// Current number of physical lines in the netlog file (0 when missing).
// Used as a MARK: waitNetlogResult later scans only lines AFTER this index so
// an earlier card attempt's error is never mistaken for a new one.
export function countLines(path) {
  try {
    return readLines(path).length;
  } catch {
    return 0;
  }
}

// Extract the real JSON: commerce/pipo wrap it inside a `response` (string).
// Some APIs return BOTH `data` (already unwrapped) and `response` (string) —
// prefer `data`. Some return a bare list (batch_get), so the type must be
// checked before property access. null when the body is not an object.
function innerJson(body) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  if (j.data && typeof j.data === 'object' && !Array.isArray(j.data)) return j.data;
  if (typeof j.response === 'string') {
    try {
      const v = JSON.parse(j.response);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Pull the user-facing error sentence out of `pipo_error_action`.
function errorTip(d) {
  let act = d.pipo_error_action;
  if (typeof act === 'string') {
    try {
      act = JSON.parse(act);
    } catch {
      return '';
    }
  }
  if (!act || typeof act !== 'object' || Array.isArray(act)) return '';
  const ui = act.ui_data || {};
  return String(ui.error_content_text || '').trim();
}

// Read the .jsonl file -> order state & payment result.
//
// `startLine` skips the first N physical lines: use it to only look at what
// happened AFTER a mark (e.g. after pressing the confirm button), so a
// previous card attempt's error is not re-read as a fresh one.
//
// The file is re-read instead of hooking the page: the cashier is a different
// tab/origin, and both pipopay's and capcut's requests must be seen on one
// timeline. Field names match src/browser/netlog.js records exactly
// ({kind:'body', id, url, base64, body, t, tab?}).
//
// Returns an object that may contain: order_id, cashier_url, amount,
// currency, discount_type, sku_name, intro_amount, standard_amount,
// next_payment_date, stage, agree_status, agreement_id, charge_id, pay_status,
// pay_method, pay_amount, err_code, err_msg, err_tip.
export function scanNetlog(path, startLine = 0) {
  const out = {};
  let lines;
  try {
    lines = readLines(path);
  } catch {
    return out;
  }
  for (let lineno = 0; lineno < lines.length; lineno++) {
    if (lineno < startLine) continue;
    const line = lines[lineno].trim();
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // torn write mid-recording — skip, keep earlier records
    }
    if (!r || r.kind !== 'body') continue;
    const b = typeof r.body === 'string' ? r.body : '';
    // Substring probes deliberately carry NO quotes: commerce/pipo wrap the
    // real JSON inside the escaped `response` field, so a quoted probe like
    // "order_id" would never match the escaped \"order_id\" form.
    if (b.includes('pipo_aggregate_pay_info') && b.includes('order_id')) {
      const d = innerJson(b);
      if (d) {
        out.order_id = d.order_id ?? null;
        out.cashier_url = ((d.pipo_aggregate_pay_info || {}).cashier_url) ?? null;
      }
    }
    if (b.includes('pre_order_status') && b.includes('sku_info')) {
      const d = innerJson(b);
      if (d) {
        out.amount = d.amount ?? null;
        out.currency = d.currency ?? null;
        out.discount_type = d.discount_type ?? null;
        const si = d.sku_info || {};
        out.sku_name = si.sku_name ?? null;
        out.intro_amount = si.intro_amount ?? null;
        out.standard_amount = si.standard_amount ?? null;
        out.next_payment_date = si.next_payment_date ?? null;
      }
    }
    if (b.includes('stage') && b.includes('agreement_id')) {
      const d = innerJson(b);
      if (d) {
        out.stage = d.stage ?? null;
        out.agree_status = d.status ?? null;
        out.agreement_id = d.agreement_id ?? null;
      }
    }
    if (b.includes('order_flow') && b.includes('charge_id')) {
      const d = innerJson(b);
      if (d) {
        const of = d.order_flow || {};
        out.charge_id = of.charge_id ?? null;
        out.pay_status = of.status ?? null;
        out.pay_method = of.payment_method ?? null;
        out.pay_amount = of.payment_amount ?? null;
      }
    }
    // Pipo rejects the card at the binding step: `result_code: error` plus an
    // error_code (RISK_REJECTED, CARD_DECLINED, ...). Must be caught, or the
    // result-wait loop idles to its timeout and reports `stage=None` — hiding
    // the real cause.
    if (b.includes('result_code') && b.includes('error_code')) {
      const d = innerJson(b);
      if (d && String(d.result_code) === 'error') {
        const ec = String(d.error_code || '').trim();
        if (ec && ec !== '0') {
          out.err_code = ec;
          out.err_msg = String(d.error_message || '');
          const tip = errorTip(d);
          if (tip) out.err_tip = tip;
        }
      }
    }
  }
  return out;
}

// Wait until `needle` appears as a raw substring in any line of the netlog
// file (checked against the RAW line, not the parsed record — a needle like
// 'trade/init_trade' survives the JSON escaping of both). Polls every 1.5s.
async function waitNetlogNeedle(path, needle, seconds, shouldStop = null) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    try {
      for (const line of readLines(path)) {
        if (line.includes(needle)) return true;
      }
    } catch {
      // missing/unreadable file — keep polling, it may appear any moment
    }
    await sleep(1500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Filling the card form
// ---------------------------------------------------------------------------

// Pick an input by name/placeholder/maxlength — pipo's CSS classes are
// hashed, so only these structural signals are stable. `phs` also probes the
// aria-label. `maxlen` compares as a string ('3').
function pickField(fields, { names = [], phs = [], maxlen = null } = {}) {
  for (const f of fields) {
    const blob = `${f.name || ''} ${f.id || ''}`.toLowerCase();
    const ph = (f.ph || '').toLowerCase();
    const aria = (f.aria || '').toLowerCase();
    if (names.length && names.some((n) => blob.includes(n))) return f;
    if (phs.length && phs.some((p) => ph.includes(p) || aria.includes(p))) return f;
    if (maxlen && String(f.max ?? '') === String(maxlen)) return f;
  }
  return null;
}

// Click the input then type through CDP Input; read `value` back to confirm
// the text actually landed. `clear=true` presses Ctrl+A before typing to
// REPLACE the old value — needed when refilling a different card on a form
// that already holds one. Never logs card values: only length + last 4
// digits, enough to cross-check without leaking the card.
async function typeIntoField(page, human, field, text, log, label, clear = false) {
  await human.clickXY(field.x, field.y);
  await sleep(350);
  if (clear) {
    // modifiers=2 is Ctrl in the CDP Input bitmask (mapped by HumanInput).
    await human.pressKey('a', { code: 'KeyA', vk: 65, modifiers: 2 });
    await sleep(200);
  }
  await human.typeText(text);
  await sleep(450);
  let got = '';
  const sel = field.name
    ? `input[name='${field.name}']`
    : (field.id ? `#${field.id}` : '');
  if (sel) {
    try {
      got = (await evalTimed(
        page,
        `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.value : ''; })()`,
        15000,
      )) || '';
    } catch (e) {
      if (e && e.name === 'TimeoutException') throw e; // Python parity: transport timeout escapes
      got = '';
    }
  }
  const tail = got.length >= 4 ? got.slice(-4) : '';
  log(`      ${label}: ${String(text).length} chars -> ...${tail}`);
  return Boolean(got);
}

// Make sure the card form is OPEN; returns the input list ([] when it never
// opened). Why needed: on the first cashier visit the card form is already
// open, but after RELOADING the page (to try another card) the "Credit /
// debit card" section comes back COLLAPSED — reading immediately shows 0
// inputs and looks like a broken page. Clicks the section header once, then
// waits for the card-number input to appear.
export async function openCardForm(page, human, { log = console.log, seconds = 45, shouldStop = null } = {}) {
  const deadline = Date.now() + seconds * 1000;
  let clicked = false;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    const d = (await evalTimed(page, JS_CASHIER, 30000)) || {};
    const fields = d.fields || [];
    if (fields.some((f) => (f.name || '').toLowerCase().includes('card_number'))) {
      return fields;
    }
    if (!clicked) {
      const btn = await evalTimed(page, JS_EXPAND_CARD, 20000);
      if (btn) {
        log(`    [i] opening the card section: ${JSON.stringify(btn.text)}`);
        await human.clickXY(btn.x, btn.y);
        clicked = true;
        await sleep(3000);
        continue;
      }
    }
    await sleep(2500);
  }
  return [];
}

// Fill the 4 fields of the VN cashier: card number, MM/YY, CVV, holder name.
// `card` = {number, mm, yy, cvv, holder}. Returns true when the NUMBER field
// was fillable (the mandatory one); when other fields are missing the confirm
// button simply stays disabled and the caller detects that itself.
// `clear=true` wipes the old value before typing — for entering a DIFFERENT
// card on a form still holding the just-rejected one; without it the new
// number is appended to the old.
export async function fillCard(page, human, card, { log = console.log, clear = false } = {}) {
  let fields = await openCardForm(page, human, { log });
  if (!fields.length) {
    const d = (await evalTimed(page, JS_CASHIER, 30000)) || {};
    fields = d.fields || [];
  }
  log(`    [i] ${fields.length} input field(s) on the cashier:`);
  for (const f of fields) {
    log(`       name=${JSON.stringify((f.name || '').slice(0, 22))} ` +
        `ph=${JSON.stringify((f.ph || '').slice(0, 24))} ` +
        `max=${String(f.max ?? '').padEnd(4)} inView=${f.inView}`);
  }

  const fNum = pickField(fields,
    { names: ['card_number', 'cardnumber', 'cardno'], phs: ['số thẻ', 'card number', '1234'] });
  if (!fNum) return false;
  const fExp = pickField(fields,
    { names: ['expiration_date', 'expdate'], phs: ['mm/yy', 'mm / yy'] });
  const fMm = pickField(fields,
    { names: ['expiration_month', 'expmonth'], phs: ['mm'] });
  const fYy = pickField(fields,
    { names: ['expiration_year', 'expyear'], phs: ['yy'] });
  const fCvv = pickField(fields,
    { names: ['cvv', 'cvc', 'securitycode'], phs: ['cvv', 'cvc'], maxlen: '3' });
  const fName = pickField(fields,
    { names: ['holder_name', 'holdername', 'cardholder'], phs: ['họ và tên', 'holder name', 'name on card'] });

  await typeIntoField(page, human, fNum, card.number, log, 'card number', clear);
  if (fExp) {
    await typeIntoField(page, human, fExp, `${card.mm}/${card.yy}`, log, 'expiry', clear);
  } else {
    if (fMm) await typeIntoField(page, human, fMm, card.mm, log, 'month', clear);
    if (fYy) await typeIntoField(page, human, fYy, card.yy, log, 'year', clear);
  }
  if (fCvv) await typeIntoField(page, human, fCvv, card.cvv, log, 'cvv', clear);
  // Missing this field leaves the confirm button disabled (measured on the
  // VN cashier).
  if (fName) {
    await typeIntoField(page, human, fName, card.holder || 'NGUYEN VAN A', log, 'holder name', clear);
  }
  return true;
}

// Wait for the confirm button to become ENABLED, then return it.
// The button only enables after the form is valid AND pipo has validated the
// BIN, so it must be polled. Wallet buttons are skipped: they are always
// enabled and their label contains "Pay", which would mismatch.
export async function findConfirm(page, { seconds = 60, shouldStop = null } = {}) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    await sleep(3000);
    const d = (await evalTimed(page, JS_CASHIER, 30000)) || {};
    for (const b of d.buttons || []) {
      if (b.disabled || !b.inView) continue;
      const t = String(b.text || '').trim();
      if (!t) continue;
      const low = t.toLowerCase();
      if (WALLET_KW.some((w) => low.includes(w))) continue;
      if (CONFIRM_KW.some((k) => low.includes(k))) return b;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

// Close onboarding overlays — they cover the top-bar "Upgrade" button.
export async function closeOverlays(page, human, { log = console.log, rounds = 4 } = {}) {
  for (let round = 0; round < rounds; round++) {
    let got = null;
    try {
      got = await evalTimed(page, JS_CLOSE_OVERLAY, 20000);
    } catch (e) {
      if (e && e.name === 'TimeoutException') throw e; // Python parity: transport timeout escapes
      got = null;
    }
    if (!got) return;
    log(`    [i] closing overlay ${JSON.stringify(got.text)}`);
    await human.clickXY(got.x, got.y);
    await sleep(2500);
  }
}

// Widen the viewport so the plan-card button is inside the screen.
// The old GPM window was ~1264x805 and the Pro card's "Upgrade" button sat at
// y≈838, so CDP Input clicks landed OFF screen and NOTHING happened (measured:
// no init_trade in the netlog) — that was the real cause, not a wrong
// selector. Node note: browser.js launches at 1280x900, same trap, so this
// override is still mandatory. (Python used Emulation.setDeviceMetricsOverride;
// the Playwright equivalent is page.setViewportSize.)
export async function setViewport(tab, { log = console.log, width = VIEW_W, height = VIEW_H } = {}) {
  try {
    await tab.setViewportSize({ width, height });
    return true;
  } catch (e) {
    log(`    [!] Could not set the viewport to ${width}x${height}: ${e?.message || e}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Opening the order via API (~25s faster than clicking through)
// ---------------------------------------------------------------------------

// Same server as the credit API the tool already calls via in-page fetch, so
// the page SDK signs the `sign` header for us — never sign by hand (that
// breaks it).
const AID = 348188;

const PRICE_LIST_URL = 'https://commerce-api-sg.capcut.com/commerce/v1/subscription/cc_price_list';
const INIT_TRADE_URL = 'https://commerce-api-sg.capcut.com/commerce/v3/trade/init_trade';
const BATCH_GET_URL = 'https://commerce-api-sg.capcut.com/commerce/v1/subscription/batch_get';

// Parameters of the 0₫ trial plan, copied verbatim from a SUCCESSFUL claim at
// 02:11 on 31/08/2026. The price table usually does not expose this plan
// (CapCut seems to attach the promotion only when the upgrade page is open),
// but `init_trade` may still accept it — worth a try, and if the order comes
// out wrong the "amount must be 0" gate later blocks it: no paid order can be
// created by accident.
export const DEFAULT_TRIAL_PLAN = {
  sku_id: 'SKU176641536273',
  product_id: 'capcut_pro_monthly_discount2',
  pms_trade: '{"sku_plan_id":"1541136422660","sku_plan_uniq_id":"599610158084","display_price":"0","currency_code":"VND"}',
};

// Peel the {"ret":"0","response":"<json string>"} shell of commerce-api.
// Returns [data, err]; err is '' on success. Empty ret ('' or '0') passes —
// some endpoints omit it entirely.
function unwrapCommerce(r) {
  const j = (r || {}).json || {};
  const ret = String(j.ret ?? '');
  if (ret !== '0' && ret !== '') {
    return [null, `ret=${fmt(j.ret)} ${String(j.errmsg ?? '').slice(0, 80)}`];
  }
  const raw = j.response;
  if (typeof raw === 'string') {
    try {
      return [JSON.parse(raw), ''];
    } catch {
      return [null, 'response is not JSON'];
    }
  }
  return [raw || {}, ''];
}

// The Pro plan price table (`scene='vip'`). Returns the plan list, [] on
// failure.
//
// Ask via `batch_get` EXACTLY like the upgrade page does, do not call
// `cc_price_list` directly: the direct call only returns the 4 base plans,
// without the account's personal trial offer (measured 02:27 31/08/2026 — 4
// direct asks, no trial plan, while the UI showed one). The direct call is
// kept as a fallback.
//
// This is also a much faster way to check "is this account invited to the
// offer" than opening /ai-design and reading the card text.
export async function proPriceTable(page, { region = 'VN', log = console.log, timeout = 45 } = {}) {
  const body = { data_optimize: true, request_param_list: [
    { path: '/commerce/v1/subscription/cc_price_list',
      key: '/commerce/v1/subscription/cc_price_list_vip',
      body: { aid: AID, region, scene: 'vip' } },
  ] };
  let [d, err] = unwrapCommerce(await postJson(page, BATCH_GET_URL, body, timeout * 1000));
  if (Array.isArray(d)) {
    for (const item of d) {
      if (!String(item.key ?? '').includes('vip')) continue;
      const data = ((item.response || {}).data) || {};
      const ds = data.all_price_list || [];
      if (ds.length) return ds;
    }
  }
  if (err) log(`    [i] batch_get price table error: ${err}`);

  // Fallback: ask directly.
  [d, err] = unwrapCommerce(await postJson(
    page, PRICE_LIST_URL, { aid: AID, region, scene: 'vip' }, timeout * 1000));
  if (err || d == null) {
    log(`    [i] could not read the Pro price table: ${err || 'empty'}`);
    return [];
  }
  return (d && d.all_price_list) || [];
}

// Pick the 0₫ trial plan out of the `scene='vip'` price table.
//
// Do NOT trust the displayed price: the trial plan still shows
// `price_tips=45000` (the first month's price AFTER the trial) — the amount
// due TODAY = 0 lives inside the `pms_trade` string the same row returns.
// The surest signal is `trial_tips` ("7 ngày dùng thử miễn phí") — accounts
// not invited only get *_base/_onemonth/_oneyear rows, none with trial_tips.
// Returns the plan object, or null.
export function pickTrialPlan(list, { log = console.log } = {}) {
  for (const it of list || []) {
    if (String(it.trial_tips ?? '').trim()) {
      log(`    [i] trial plan: ${it.product_id} (${it.trial_tips})`);
      return it;
    }
  }
  // Backup: the wording may change but pms_trade still says pay 0 today.
  for (const it of list || []) {
    if (String(it.pms_trade ?? '').split(' ').join('').includes('"display_price":"0"')) {
      log(`    [i] trial plan (by pms_trade): ${it.product_id}`);
      return it;
    }
  }
  return null;
}

// Bring the tab back to a commerce page before calling init_trade.
// Called from the login page, CapCut returns ret=36010117; the same
// parameters from the upgrade page work. The page only needs to be OPEN,
// nothing needs clicking.
export async function openCommercePage(page, { log = console.log, url = 'https://www.capcut.com/ai-design' } = {}) {
  let here = '';
  try {
    here = (await evalTimed(page, 'location.href', 10000)) || '';
  } catch {
    here = '';
  }
  // Do NOT skip just because we are on capcut.com: measured 02:45 31/08/2026,
  // a tab on a plain capcut.com page (CapCut itself navigates away from
  // /login after sign-in) still got 36010117 from init_trade. It must be the
  // commerce page specifically.
  if (here.includes(url.split('?')[0])) return true;
  log('    [i] bringing the tab back to a commerce page before opening the order');
  try {
    await page.goto(url);
    await waitForDomReady(page, { timeout: 40, settle: [2.0, 3.0] });
    return true;
  } catch (e) {
    log(`    [i] could not open ${url}: ${e?.name || 'Error'}: ${e?.message || e}`);
    return false;
  }
}

// Open the trial order with 2 requests; returns [order_id, cashier_url].
//
// Replaces the chain: open /ai-design -> close overlays -> click top-bar
// 'Upgrade' -> wait 9s -> read the Pro card -> click 'Upgrade' in the card.
// Measured 31/08/2026: that chain costs ~28s, these two requests ~3s.
//
// Returns ['', ''] when the API path does not work — the caller falls back
// to clicking. (Python's docstring mentioned a '' + 'khong-duoc-moi' sentinel
// for "not invited", but the actual code never returned it: when the price
// table hides the trial plan it still tries init_trade with the known default
// parameters and lets the caller judge via the click fallback. Ported as the
// CODE behaves.) Only ONE price-table ask by default: asking more is slower
// than the old click path. The `tries` option keeps Python's re-ask hook —
// the 0₫ offer can appear a few seconds after the account does.
export async function openOrderViaApi(page, { region = 'VN', locale = 'vi-VN', log = console.log, shouldStop = null, tries = 1 } = {}) {
  checkStop(shouldStop);
  await openCommercePage(page, { log });

  let plan = null;
  const triesN = Math.trunc(Number(tries) || 0);
  for (let ask = 0; ask < triesN; ask++) {
    const list = await proPriceTable(page, { region, log });
    plan = list.length ? pickTrialPlan(list, { log }) : null;
    if (plan) break;
    if (ask + 1 < triesN) {
      log('    [i] price table has no 0₫ plan yet — asking again in 5s');
      await sleep(5000);
    }
  }
  if (!plan) {
    // Not in the price table -> still try the known parameters. If it misses,
    // the caller falls back to the click path as before.
    log('    [i] price table does not expose the trial offer — trying init_trade directly');
    plan = { ...DEFAULT_TRIAL_PLAN };
  }

  // The price table ships a ready `pms_trade` — use it verbatim like the
  // front-end does, do not rebuild it: `sku_plan_uniq_id` only exists inside
  // that string, there is no separate key.
  let pmsTrade = String(plan.pms_trade ?? '');
  if (!pmsTrade) {
    pmsTrade = JSON.stringify({
      sku_plan_id: String(plan.sku_plan_id ?? ''),
      sku_plan_uniq_id: String(plan.sku_plan_uniq_id ?? ''),
      display_price: '0',
      currency_code: String(plan.currency_code ?? 'VND'),
    });
  }
  if (!plan.sku_id || !pmsTrade.includes('sku_plan_id')) {
    log(`    [i] price table row lacks sku_id/pms_trade — keys present: ${Object.keys(plan).sort().slice(0, 14)}`);
    return ['', ''];
  }

  const body = {
    app_id: AID, aid: AID, region,
    scene: 'vip', type: 'vip', benefit_target: {},
    trade_type: 'subscription',
    sku_id: String(plan.sku_id),
    product_id: String(plan.product_id ?? ''),
    pms_trade: pmsTrade,
    pay_channel: 'aggregate',
    pipo_aggregate_info: {
      color_theme: 'light', gp_unavailable: true,
      language: locale, request_id: String(Date.now()),
      return_url: 'https://www.capcut.com/commerce/pay_result',
    },
  };
  const r = await postJson(page, INIT_TRADE_URL, body, 60000);
  const [d, err] = unwrapCommerce(r);
  if (err || !isFilled(d)) {
    log(`    [i] init_trade via API did not go through (${err || 'empty'}) — clicking manually`);
    return ['', ''];
  }
  const curl = ((d.pipo_aggregate_pay_info || {}).cashier_url) || '';
  const oid = String(d.order_id ?? '');
  if (!curl) {
    log('    [i] init_trade returned no cashier_url');
    return ['', ''];
  }
  log(`    [ok] order opened via API: order_id=${oid}`);
  return [oid, curl];
}

// Claim the 7-day (0₫) Pro trial for the account currently logged in on
// `page`. `tab` is the same tab used for the viewport override (Python kept
// page/tab separate for CDP; Playwright uses one object for both).
//
// Requirement: `netlogPath` is the .jsonl file a NetworkRecorder is CURRENTLY
// writing for THIS SAME tab — the function re-reads that file to get the
// `cashier_url` and the amount. `card` takes one card object or a LIST of
// cards — when pipo rejects one, the payment page is reloaded and the next
// card is tried on the SAME order.
//
// Returns [kind, payload]:
//   ['done', obj]    claimed; obj carries order_id/charge_id/pay_status...
//   ['retry', str]   account not invited to the offer -> switch account + IP
//   ['card', str]    every card was declined -> card problem, not account
//   ['stop', str]    stop entirely (amount != 0, or the form is unusable)
export async function claimTrial(page, human, tab, netlogPath, card,
  { log = console.log, shouldStop = null, localePath = 'vi-vn' } = {}) {
  // Python kept a locale_path parameter that the body never used — kept for
  // signature parity so future call sites port 1:1.
  void localePath;
  const stop = shouldStop || defaultShouldStop;
  await setViewport(tab, { log });

  log('[>] Opening the workspace page');
  await page.goto('https://www.capcut.com/ai-design');
  await waitForDomReady(page, { timeout: 40, settle: [3.0, 4.0] });
  await closeOverlays(page, human, { log });
  checkStop(stop);

  let cands = [];
  const topDeadline = Date.now() + 70000;
  while (Date.now() < topDeadline && !cands.length) {
    checkStop(stop);
    cands = (await evalTimed(page, JS_ANY_UPGRADE, 20000)) || [];
    if (!cands.length) await sleep(2000);
  }
  if (!cands.length) {
    return ['retry', "top bar has no 'Upgrade' button (account not invited to the offer)"];
  }
  log(`[>] clicking ${JSON.stringify(cands[0].text.slice(0, 36))} (top bar)`);
  await human.clickXY(cands[0].x, cands[0].y);

  // Wait for the plan table to mount, max 45s. This used to be a hard 9s
  // sleep + one read: a slow mount wrongly burned the account. Poll on the
  // POSITIVE signal (card seen), not on the clock.
  let info = {};
  const cardDeadline = Date.now() + 45000;
  while (Date.now() < cardDeadline) {
    checkStop(stop);
    try {
      info = (await evalTimed(page, JS_PRO_BTN, 25000)) || {};
    } catch (e) {
      if (e && e.name === 'TimeoutException') throw e; // Python parity: transport timeout escapes
      info = {};
    }
    if (info && !info.error) break;
    await sleep(1500);
  }
  if (!info || info.error) {
    return ['retry', info ? info.error : 'could not read the plan table'];
  }
  const ct = String(info.cardText ?? '');
  log(`[i] Pro card: ${ct.slice(0, 170)}`);
  if (!ct.includes('0₫') || (!ct.includes('7 ngày') && !ct.includes('7 days'))) {
    return ['retry', 'Pro card has no 0₫ / 7-day trial offer'];
  }
  if (!info.inView) {
    return ['retry', 'Pro button outside the viewport'];
  }

  log("[>] clicking 'Upgrade' inside the Pro card");
  await human.clickXY(info.x, info.y);
  if (!(await waitNetlogNeedle(netlogPath, 'trade/init_trade', 50, stop))) {
    return ['retry', 'init_trade was not called'];
  }
  await sleep(3000);
  let trade = scanNetlog(netlogPath);
  const curl = trade.cashier_url || '';
  log(`[i] order_id=${fmt(trade.order_id)}`);
  if (!curl) {
    return ['retry', 'no cashier_url'];
  }

  log('[>] Opening the payment page');
  await page.goto(curl);
  await waitForDomReady(page, { timeout: 45, settle: [4.0, 6.0] });
  await waitNetlogNeedle(netlogPath, 'pre_order_details', 45, stop);
  await sleep(6000);

  // SAFETY GATE — the one and only place deciding whether a card gets typed.
  trade = scanNetlog(netlogPath);
  const amt = trade.amount;
  log('[i] Verifying the amount before filling the card:');
  log(`    due now = ${fmt(amt)} ${fmt(trade.currency)} | discount_type=${fmt(trade.discount_type)}`);
  log(`    sku=${fmt(trade.sku_name)} intro=${fmt(trade.intro_amount)} standard=${fmt(trade.standard_amount)}`);
  if (amt === undefined || amt === null) {
    return ['stop', 'could not read the amount -> not filling the card'];
  }
  if (String(amt) !== '0') {
    return ['stop', `amount ${amt} ${fmt(trade.currency)} is not 0 -> not filling the card`];
  }
  log('    => 0₫, safe to fill the card');

  // Try the cards one by one on the SAME order: pipo keeps the pre-order in
  // SUBMITTED state after a rejection, so reloading the cashier accepts
  // another card.
  const cards = (card && typeof card === 'object' && !Array.isArray(card)) ? [card] : [...(card || [])];
  if (!cards.length) {
    return ['stop', 'no cards to fill'];
  }

  for (let i = 1; i <= cards.length; i++) {
    const cur = cards[i - 1];
    checkStop(stop);
    const retry = i > 1;
    if (retry) {
      // After a rejection pipo shows an error dialog ON TOP of the form; the
      // form itself is intact below. Closing the dialog and refilling is
      // enough — reloading the page collapses the card section again, harder
      // to reopen at the right spot.
      log(`[>] Closing the error dialog to try card ${i}/${cards.length}`);
      await closeOverlays(page, human, { log, rounds: 3 });
      await sleep(2500);
    }

    log(`[>] Filling card ${i}/${cards.length}: ...${cur.number.slice(-4)} (expires ${cur.mm}/${cur.yy})`);
    if (!(await fillCard(page, human, cur, { log, clear: retry }))) {
      // Form vanished (dialog would not close / page changed state) ->
      // reload the cashier and try once more.
      log('    [i] form not found — reloading the payment page');
      await page.goto(curl);
      await waitForDomReady(page, { timeout: 45, settle: [4.0, 6.0] });
      await waitNetlogNeedle(netlogPath, 'aggregate/basic_info', 40, stop);
      await sleep(8000);
      if (!(await fillCard(page, human, cur, { log }))) {
        return ['stop', 'card number input not found on the cashier'];
      }
    }

    const pay = await findConfirm(page, { seconds: 60, shouldStop: stop });
    if (!pay) {
      return ['stop', 'confirm button did not enable (form not valid?)'];
    }

    // Only look at netlog lines born AFTER this click: reading the whole file
    // would show the previous card's error and misread it as this card's.
    const mark = countLines(netlogPath);
    log(`[>] clicking ${JSON.stringify(String(pay.text || '').slice(0, 50))}`);
    await human.clickXY(pay.x, pay.y);

    const [kind, payload] = await waitNetlogResult(netlogPath, mark, { log, shouldStop: stop });
    if (kind === 'done') {
      // The caller needs to know how many cards were spent to return the
      // unused ones to the pool.
      payload.card_index = i;
      payload.card_tail = cur.number.slice(-4);
      return ['done', payload];
    }
    if (kind === 'card_bad') {
      const leftCount = cards.length - i;
      log(`    [!] card ...${cur.number.slice(-4)} declined: ${payload}`);
      if (leftCount) {
        log(`    [i] ${leftCount} card(s) left — trying the next one.`);
        continue;
      }
      return ['card', `all ${cards.length} cards were declined (${payload})`];
    }
    return ['stop', payload];
  }
  return ['stop', 'out of cards to try'];
}

// Wait for the result after pressing the confirm button. Returns [kind, payload]:
//   ['done', obj]     pay_status = SUCCESS
//   ['card_bad', str] pipo rejected the card -> the caller should try another
//   ['stop', str]     other error, or timeout
//
// Reads the netlog from `startLine` so a previous card attempt's error cannot
// leak into this one.
export async function waitNetlogResult(netlogPath, startLine, { log = console.log, shouldStop = null, seconds = 240 } = {}) {
  const deadline = Date.now() + seconds * 1000;
  let last = '';
  let trade = {};
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    await sleep(5000);
    trade = scanNetlog(netlogPath, startLine);

    // Catch the error BEFORE waiting more: pipo returns `result_code: error`
    // right at bind_and_active_agreement — there is nothing left to wait for.
    const ec = String(trade.err_code || '');
    if (ec) {
      const tip = trade.err_tip || trade.err_msg || '';
      const note = ec + (tip ? ` — ${String(tip).slice(0, 120)}` : '');
      if (CARD_ERRORS.some((k) => ec.toUpperCase().includes(k))) {
        return ['card_bad', note];
      }
      return ['stop', `pipo reported an error: ${note}`];
    }

    const note = `stage=${fmt(trade.stage)} agree=${fmt(trade.agree_status)} pay=${fmt(trade.pay_status)}`;
    if (note !== last) {
      log(`    ${note}`);
      last = note;
    }
    if (trade.pay_status === 'SUCCESS') return ['done', trade];
    if (['FAILED', 'CLOSED', 'CANCELLED'].includes(trade.pay_status)) {
      return ['stop', `payment failed: ${trade.pay_status}`];
    }
  }
  return ['stop', `timed out waiting: stage=${fmt(trade.stage)} pay=${fmt(trade.pay_status)}`];
}

// Read one card from the config. Returns a card object or null when unset.
// `PRO_CARD` is the compact hand-entry format: 'number|MM|YY|CVV'.
export function cardFromSettings(settings) {
  const raw = String(settings.PRO_CARD ?? '').trim();
  if (!raw) return null;
  const card = parseCard(raw);
  if (!card) return null;
  card.holder = settings.PRO_CARD_HOLDER || 'NGUYEN VAN A';
  return card;
}

// ---------------------------------------------------------------------------
// Card pool: paste many cards, deal them one per account
// ---------------------------------------------------------------------------

// Luhn-check a card number.
//
// Worth doing because a one-digit typo still "looks right": the tool would
// burn a mailbox + an account and only learn of the breakage at the very last
// step. Catching it here is far cheaper.
export function luhnOk(number) {
  const digits = [...String(number)].filter((c) => c >= '0' && c <= '9').map(Number);
  if (digits.length < 12) return false;
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    // Walk from the RIGHTmost digit, doubling every second one.
    let d = digits[digits.length - 1 - i];
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

// Split one card line -> {number, mm, yy, cvv}; null when invalid.
//
// Accepts the shapes usually met when pasting from elsewhere:
//   4111111111111111|04|29|186
//   4111111111111111|04|2029|186
//   4111111111111111 04/29 186
//   4111 1111 1111 1111|04|29|186
//
// A 4-digit year is cut to 2 (the cashier form only accepts YY).
export function parseCard(line) {
  const s = String(line ?? '').trim();
  if (!s || s.startsWith('#')) return null;
  let parts = s.replace(/\t/g, ' ').split('|').map((p) => p.trim());
  if (parts.length < 4) {
    // 'number MM/YY CVV' style, or space/comma separated.
    const flat = s.split(',').join(' ').split('/').join(' ').split(/\s+/);
    parts = flat.length >= 4 ? flat : [];
  }
  if (parts.length < 4) return null;

  const digit = (str) => [...str].filter((c) => c >= '0' && c <= '9').join('');
  const number = digit(parts[0]);
  let mm = digit(parts[1]);
  let yy = digit(parts[2]);
  const cvv = digit(parts[3]);

  if (!(number && mm && yy && cvv)) return null;
  if (yy.length === 4) yy = yy.slice(2);
  if (mm.length === 1) mm = '0' + mm;
  if (!(number.length >= 12 && number.length <= 19)) return null;
  const mmInt = Number.parseInt(mm, 10);
  if (!(mmInt >= 1 && mmInt <= 12)) return null;
  if (yy.length !== 2 || !(cvv.length >= 3 && cvv.length <= 4)) return null;
  return { number, mm, yy, cvv };
}

// Parse a card list, dropping bad and duplicate lines.
//
// `lines` may be an array or one multi-line string (the GUI paste box).
// Returns card objects with `holder` attached.
export function parseCards(lines, { log = null, holder = null } = {}) {
  const list = typeof lines === 'string' ? lines.split(/\r?\n/) : (lines || []);
  const out = [];
  const seen = new Set();
  let bad = 0;
  let i = 0;
  for (const line of list) {
    i += 1;
    if (!String(line ?? '').trim()) continue;
    const card = parseCard(line);
    if (!card) {
      bad += 1;
      if (log) log(`    [!] Card line ${i} is invalid — skipped.`);
      continue;
    }
    if (seen.has(card.number)) {
      if (log) log(`    [i] Card line ${i} duplicates ...${card.number.slice(-4)} — dropped.`);
      continue;
    }
    if (!luhnOk(card.number)) {
      bad += 1;
      if (log) log(`    [!] Card line ${i} fails the checksum (Luhn): ...${card.number.slice(-4)} — skipped.`);
      continue;
    }
    seen.add(card.number);
    card.holder = holder || 'NGUYEN VAN A';
    out.push(card);
  }
  if (log && (out.length || bad)) {
    log(`    [i] Card pool: ${out.length} usable card(s)` + (bad ? `, ${bad} bad line(s).` : '.'));
  }
  return out;
}

// Deal cards one per account, safe under concurrency.
//
// By default EACH CARD IS USED ONCE (`reuse=false`): reusing one card across
// trial accounts is exactly what payment gateways block, and one blocked card
// drags a whole trail of later accounts down with it. When the pool runs out,
// remaining accounts are still created fine — they just stay free (recorded
// as `free`).
//
// NOTE (Node deviation from Python, contract rule 6): the Python threading.Lock
// became makeMutex() from util.js, so the MUTATING methods (take, takeMany,
// giveBack, blockBin) are async and must be awaited; the read accessors
// (left, size, blockedBins, allBlocked, binSummary) stay synchronous.
export class CardPool {
  // `cards` = parsed card objects; `reuse` = allow dealing cards round-robin
  // more than once.
  constructor(cards = [], { reuse = false } = {}) {
    this._cards = [...(cards || [])];
    this._reuse = Boolean(reuse);
    this._i = 0;
    this._mutex = makeMutex();
    // BINs the payment gateway has rejected. Pipo blocks by BIN, not by
    // individual card (measured: 3 cards of BIN 434256 all RISK_REJECTED),
    // so remember them and spare later accounts the futile tries.
    this._blocked = new Set();
  }

  // Total cards in the pool (Python __len__).
  get size() {
    return this._cards.length;
  }

  // How many cards are still undealt (meaningless when reuse=true).
  get left() {
    if (this._reuse) return this._cards.length;
    return Math.max(0, this._cards.length - this._i);
  }

  // Record a rejected BIN; later deals skip cards of the same BIN.
  async blockBin(bin6) {
    if (!bin6) return;
    await this._mutex.run(() => {
      this._blocked.add(String(bin6).slice(0, 6));
    });
  }

  // Copy of the currently blocked BIN set.
  blockedBins() {
    return new Set(this._blocked);
  }

  // True when every remaining card belongs to an already-blocked BIN.
  allBlocked() {
    if (!this._blocked.size) return false;
    const pool = this._reuse ? this._cards : this._cards.slice(this._i);
    if (!pool.length) return false;
    return pool.every((c) => this._blocked.has(c.number.slice(0, 6)));
  }

  // Take the next card; null when empty (and no reuse allowed).
  // `skipBlocked`: skip cards whose BIN the gateway already rejected —
  // retrying the same BIN only burns time, measured to fail identically.
  async take(skipBlocked = true) {
    if (!this._cards.length) return null;
    return this._mutex.run(() => {
      const n = this._cards.length;
      for (let k = 0; k < n; k++) {
        let card;
        if (this._reuse) {
          card = this._cards[this._i % n];
          this._i += 1;
        } else {
          if (this._i >= n) return null;
          card = this._cards[this._i];
          this._i += 1;
        }
        if (skipBlocked && this._blocked.has(card.number.slice(0, 6))) continue;
        return card;
      }
      return null;
    });
  }

  // Take up to `n` DISTINCT cards — spares to fall back on when the gateway
  // rejects the first card.
  //
  // Prefer cards of DIFFERENT BINs (first 6 digits = issuing bank). Measured:
  // pipo answers RISK_REJECTED per BIN, not per card — 3 cards of BIN 434256
  // were all rejected identically. A spare batch of one BIN is three futile
  // tries.
  //
  // Under `reuse`, take() cycles and may hand back an already-taken card; the
  // duplicate filter keeps it from retrying the exact card just rejected.
  async takeMany(n) {
    const want = Math.max(1, Math.trunc(Number(n) || 0));
    const out = [];
    const seen = new Set();
    const spare = [];
    const seenBins = new Set();
    // Scan wider than `want` for a chance to meet another BIN.
    for (let k = 0; k < want * 6; k++) {
      if (out.length >= want) break;
      const c = await this.take();
      if (c == null) break;
      const num = c.number;
      if (seen.has(num)) continue;
      seen.add(num);
      const bin6 = num.slice(0, 6);
      if (seenBins.has(bin6)) {
        spare.push(c); // kept aside, used only when no other BIN exists
        continue;
      }
      seenBins.add(bin6);
      out.push(c);
    }
    // Not enough distinct BINs -> top up with same-BIN cards.
    while (out.length < want && spare.length) out.push(spare.shift());
    // Over-scanned cards that went unused go straight back to the pool.
    if (spare.length) await this.giveBack(spare);
    return out;
  }

  // {BIN: card count} — to warn when the whole pool is a single BIN.
  binSummary() {
    const out = {};
    for (const c of this._cards) {
      const b = c.number.slice(0, 6);
      out[b] = (out[b] || 0) + 1;
    }
    return out;
  }

  // Return UNUSED cards (over-scanned but the first card succeeded).
  // Without this, every successful claim still "burns" its spare cards.
  async giveBack(cards) {
    if (this._reuse || !cards || !cards.length) return;
    await this._mutex.run(() => {
      for (let k = cards.length - 1; k >= 0; k--) {
        if (this._i > 0) {
          this._i -= 1;
          this._cards[this._i] = cards[k];
        }
      }
    });
  }
}

// Build a CardPool from the config.
//
// Prefers `PRO_CARDS` (list, or one multi-line paste from the GUI); falls
// back to the single `PRO_CARD` so old configs keep working.
export function poolFromSettings(settings, { log = null } = {}) {
  const holder = settings.PRO_CARD_HOLDER || 'NGUYEN VAN A';
  let raw = settings.PRO_CARDS ?? null;
  if (!raw || raw.length === 0) {
    const one = String(settings.PRO_CARD ?? '').trim();
    raw = one ? [one] : [];
  }
  const cards = parseCards(raw, { log, holder });
  return new CardPool(cards, { reuse: Boolean(settings.PRO_CARD_REUSE) });
}
