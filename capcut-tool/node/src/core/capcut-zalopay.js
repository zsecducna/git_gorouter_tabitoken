// Claim the 7-day Pro trial paid with ZALOPAY — scan the QR with the phone app.
// Port of capcut_zalopay.py (worker H).
//
// Why this path works while the card path does not: pipo returns RISK_REJECTED
// for the CARD method ("For your safety this payment method is currently
// unavailable"), but picking ZaloPay goes straight to binding.zalopay.vn and
// shows a QR — no risk error. Measured live, same account, same session.
//
// Two traps already stepped in, do not repeat them:
//
// 1. Clicking the "ZaloPay" TEXT does not switch the method. That text is just
//    a label; the click target is the ROW containing it (with an
//    input[type=radio]). Click the label, leave "Payment method" reading
//    "Credit / debit card", hit confirm, and you pay by CARD — and eat the
//    card RISK_REJECTED. This bug once led to the wrong conclusion that
//    "ZaloPay is blocked too".
//
// 2. Therefore ALWAYS verify the ZaloPay radio's `checked` state before hitting
//    confirm. If it cannot be verified, stop — do not click.
//
// The QR lives in a <canvas> (not an <img>), so grab it via a screenshot clip.

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { checkStop, defaultShouldStop, waitForDomReady } from '../browser/browser.js';
import { DEFAULT_HOST, ZaloQRClient, parseExpiresIn } from '../infra/zaloqr-client.js';
import { APP_URL, creditTotal, getCredit } from './capcut-tasks.js';
import { readLines, sleep } from '../util/util.js';

// The wallet binding page of ZaloPay, shown after clicking confirm.
export const BINDING_HOST = 'binding.zalopay.vn';

// Host inside the QR content: the QR image points at
// https://zlp-agp.zalopay.vn/oauthbe/agreement/<binding_token>?s=web
// (cross-checked on two real sessions: the token here matches the binding
// page's `binding_token`). Used as the fallback reload URL when the binding
// page refuses to draw a new code.
export const AGREEMENT_HOST = 'zlp-agp.zalopay.vn';

// One entry per wallet: the LABEL on the CapCut cashier page and the wallet
// pages' HOSTS. Split out so adding a wallet is one line, not a flow change.
// `qr` = needles that must appear in the QR CONTENT; empty means the format of
// that wallet has not been measured yet — then only demand non-empty content
// that is long enough (the placeholder frame decodes to an EMPTY string, so
// that still filters it).
export const WALLETS = {
  zalopay: {
    label: 'ZaloPay',
    hosts: ['binding.zalopay.vn', 'zlp-agp.zalopay.vn'],
    qr: ['zlp-agp.zalopay.vn'],
  },
  momo: {
    label: 'MoMo',
    hosts: ['momo.vn', 'payment.momo.vn', 'business.momo.vn'],
    qr: [],
  },
};

// Life cycle of one ZaloPay code: 15:00, and EVERY page reload restarts the
// clock from zero (measured: a code born at 00:12:23 counted 14:59; reloaded
// at 00:13:28 it read 14:54, not 13:54). So this tool counts from ITS OWN
// load time, never the server number the queue returns — that number drifts
// on server restarts or network hiccups.
export const ZALO_QR_TTL = 900;

// Minimum "density" of a QR image (black/white flips on one middle row).
// Measured: a real ZaloPay code is 29-33, the placeholder frame 13. Only used
// as a diagnostic now that jsQR is always available (python used it as the
// fallback when pyzbar was missing).
export const QR_MIN_FLIPS = 20;

// Deviation vs python: capcut-pro.js (worker G) has not landed and its
// contract does not export JS_ANY_UPGRADE / JS_PRO_BTN / _wait_netlog, so they
// are inlined below module-private, byte-identical to capcut_pro.py — same
// approach as the landed capcut-login.js took for the engine helpers.
// capcut-pro.js itself is loaded LAZILY inside the functions that need it
// (mirroring python's in-function `import capcut_pro as cp`), which keeps this
// module import-safe while worker G's file is still landing.

// ---------------------------------------------------------------------------
// Wallet tables
// ---------------------------------------------------------------------------

// Parameters of one wallet; unknown names fall back to ZaloPay.
export function walletInfo(name) {
  return WALLETS[String(name || '').toLowerCase()] || WALLETS.zalopay;
}

// 'momo,zalopay' -> [momo entry, zalopay entry]. Unknown names dropped, empty
// defaults to ZaloPay. The order in the string is the PRIORITY order.
export function walletList(name) {
  const out = [];
  const seen = new Set();
  for (const t of String(name || '').replace(/ /g, '').split(',')) {
    const k = t.toLowerCase();
    if (k in WALLETS && !seen.has(k)) {
      seen.add(k);
      out.push(WALLETS[k]);
    }
  }
  return out.length ? out : [WALLETS.zalopay];
}

// Does this URL belong to one of the wallets in the list? Returns the matching
// wallet entry, or null.
export function onWalletPageAny(url, wallets) {
  for (const w of wallets || []) {
    if (onWalletPage(url, w)) return w;
  }
  return null;
}

// Does this URL belong to this wallet's pages?
export function onWalletPage(url, wallet) {
  const u = String(url || '');
  return (wallet.hosts || []).some((h) => u.includes(h));
}

// ---------------------------------------------------------------------------
// Page-reading JS ( needles / page copy stay Vietnamese on purpose )
// ---------------------------------------------------------------------------

// Find the wallet's option row on the cashier: climb from the label to an
// ancestor that has the radio / looks like a selectable row.
const JS_PICK_WALLET = `
(() => {
    const norm = s => (s||"").replace(/\\s+/g," ").trim();

    // Payment methods currently on the page — to report when the wanted one is missing.
    const options = [];
    document.querySelectorAll("input[type=radio]").forEach(r => {
        let lab = r.closest("label") || r.parentElement;
        for (let i = 0; i < 4 && lab && norm(lab.innerText).length < 2; i++)
            lab = lab.parentElement;
        const t = norm(lab ? lab.innerText : "").slice(0, 40);
        if (t) options.push(t);
    });

    // WIDE match: "MoMo", "Vi MoMo", "MoMo Wallet" are all MoMo. Still require a
    // LEAF node (few children) so we do not grab the block with many methods.
    const can = s => norm(s).toLowerCase()
        .replace(/^v[ií]\\s+/, "").replace(/\\s*(e-?)?wallet$/, "").trim();
    const want = can("%NHAN%");
    let label = null;
    document.querySelectorAll("*").forEach(n => {
        if (label) return;
        if (can(n.innerText) !== want) return;
        if (n.children.length > 2) return;   // take the leaf, not the whole block
        label = n;
    });
    if (!label) return {error: "label %NHAN% not found", options: options};

    let node = label, best = null;
    for (let i = 0; i < 6 && node; i++) {
        const r = node.getBoundingClientRect();
        if (r.width > 220 && r.height >= 32 && r.height < 140) best = node;
        if (node.querySelector && node.querySelector("input[type=radio]")) {
            best = node; break;
        }
        node = node.parentElement;
    }
    const target = best || label;
    const r = target.getBoundingClientRect();
    const radio = target.querySelector ? target.querySelector("input[type=radio]") : null;
    const rr = radio ? radio.getBoundingClientRect() : null;
    return {
        x: (rr && rr.width > 4 ? rr.left + rr.width/2
                               : r.left + Math.min(60, r.width/2)),
        y: (rr && rr.height > 4 ? rr.top + rr.height/2 : r.top + r.height/2),
        w: Math.round(r.width), h: Math.round(r.height),
        hasRadio: !!radio, inView: r.top >= 0 && r.bottom <= innerHeight,
        options: options
    };
})()
`;

// Read the CURRENTLY selected method — the safety latch before clicking confirm.
const JS_SELECTED = `
(() => {
    const norm = s => (s||"").replace(/\\s+/g," ").trim();
    const out = {selected: "", radios: []};
    document.querySelectorAll("input[type=radio]").forEach(r => {
        let lab = r.closest("label") || r.parentElement;
        for (let i = 0; i < 4 && lab && norm(lab.innerText).length < 2; i++)
            lab = lab.parentElement;
        out.radios.push({checked: !!r.checked,
                         text: norm(lab ? lab.innerText : "").slice(0, 50)});
    });
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let prev = "";
    while (w.nextNode()) {
        const t = norm(w.currentNode.nodeValue);
        if (!t) continue;
        if (prev.indexOf("Phương thức thanh toán") > -1 && t.length < 60) {
            out.selected = t; break;
        }
        prev = t;
    }
    return out;
})()
`;

// Position + size of the QR canvas/img. Does NOT call toDataURL(): the ZaloPay
// page paints a cross-origin logo into the canvas, so the canvas is "tainted"
// and toDataURL throws SecurityError. Read coordinates, screenshot that region
// via CDP instead. `sx`/`sy` (scroll offset) are captured for the Playwright
// screenshot fallback, whose clip is viewport-relative.
const JS_QR_BOX = `
(() => {
    const out = {url: location.href, found: false, texts: []};
    let best = null, area = 0;
    // MoMo draws the QR as an <img>, ZaloPay as a <canvas> — accept both, take
    // the largest near-square one (a QR is always square, decoration is not).
    document.querySelectorAll("canvas, img").forEach(c => {
        const r = c.getBoundingClientRect();
        if (r.width < 80 || r.height < 80) return;
        const ratio = r.width / r.height;
        if (ratio < 0.8 || ratio > 1.25) return;
        const a = r.width * r.height;
        if (a > area) { area = a; best = c; }
    });
    if (best) {
        best.scrollIntoView({block: "center", inline: "center"});
        const r = best.getBoundingClientRect();
        out.found = true;
        // PAGE coordinates (plus scroll) because CDP takes clip in page coords.
        out.x = r.left + (window.scrollX || 0);
        out.y = r.top + (window.scrollY || 0);
        out.sx = (window.scrollX || 0);
        out.sy = (window.scrollY || 0);
        out.w = r.width; out.h = r.height;
        out.inView = r.top >= 0 && r.bottom <= innerHeight;
    }
    // The countdown ("Confirm expires after: 14:59") sits at the END of the DOM
    // even though shown at the top, so the text collector below hits its cap
    // before reaching it. Search it separately and put it FIRST in 'texts' so
    // parseExpiresIn reads the REAL deadline instead of guessing 900s — a wrong
    // guess misorders the queue.
    out.countdown = "";
    for (const n of document.querySelectorAll("*")) {
        const s = (n.innerText || "").replace(/\\s+/g, " ").trim();
        if (!s || s.length > 60) continue;
        const m = s.match(/(\\d{1,2}):([0-5]\\d)/);
        if (!m) continue;
        if (/hết hạn|hiệu lực|còn lại/i.test(s)) { out.countdown = m[0]; break; }
        if (!out.countdown) out.countdown = m[0];
    }
    if (out.countdown) out.texts.push(out.countdown);

    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
        const t = (w.currentNode.nodeValue || "").replace(/\\s+/g, " ").trim();
        // ZaloPay's countdown lives in its OWN text node ("14:16", 5 chars),
        // separate from the "Confirm expires after:" label. Filtering by
        // length > 8 loses it, and the deadline sent to the queue becomes the
        // 900s guess.
        const isClock = /^\\d{1,2}:[0-5]\\d$/.test(t);
        if ((isClock || (t.length > 8 && t.length < 160))
            && out.texts.indexOf(t) < 0)
            out.texts.push(t);
        if (out.texts.length > 20) break;
    }
    return out;
})()
`;

// ZaloPay page state read from the VISIBLE TEXT. States of interest
// (python names thanh_cong/that_bai/co_qr translated):
//   'success' — "Xác thực thành công": the wallet binding is done
//   'failed'  — "Xác thực thất bại / Hết hạn liên kết. Vui lòng thử lại!"
//               (waited too long, link dead; the page counts down then returns)
//   'has_qr'  — there is still a code to scan
const JS_ZALO_STATE = `
(() => {
    const t = (document.body ? (document.body.innerText || "") : "")
        .replace(/\\s+/g, " ").toLowerCase();
    const has = s => t.indexOf(s) >= 0;
    if (has("xác thực thành công") || has("liên kết thành công")) return "success";
    if (has("xác thực thất bại") || has("hết hạn liên kết")) return "failed";
    let canvas = false;
    document.querySelectorAll("canvas").forEach(c => {
        const r = c.getBoundingClientRect();
        if (r.width >= 80 && r.height >= 80) canvas = true;
    });
    if (canvas) return "has_qr";
    return "";
})()
`;

// ZaloPay page state ('' when it cannot be read). `timeout` is kept for python
// parity — Playwright's evaluate has no per-call timeout knob.
export async function zaloState(page, { timeout = 10 } = {}) {
  try {
    return (await page.evaluate(JS_ZALO_STATE)) || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Choosing ZaloPay
// ---------------------------------------------------------------------------

// Pick the wallet method on the cashier. Returns true only when it REALLY
// switched. Verified via `radio.checked`, never trusting the click: hitting
// the label but not the radio leaves the page on "Credit / debit card", and
// the confirm click after that pays by card.
export async function chooseWallet(page, human, { label = 'ZaloPay', log = console.log, shouldStop = null, tries = 3 } = {}) {
  for (let i = 0; i < Math.max(1, tries); i++) {
    checkStop(shouldStop);
    const pick = (await page.evaluate(JS_PICK_WALLET.replaceAll('%NHAN%', label))) || {};
    if (pick.error) {
      const co = (pick.options || []).filter((x) => x);
      log(`    [!] ${pick.error}` +
          (co.length ? ` — gateway currently offers: ${co.slice(0, 6).join('; ')}` : ''));
      return false;
    }
    log(`    [i] ${label} option ${pick.w}x${pick.h} radio=${pick.hasRadio} -> clicking`);
    await human.clickXY(pick.x, pick.y);
    // Wait until the radio REALLY changes instead of counting 4 seconds and hoping.
    const st = (await waitUntil(async () => {
      const x = (await page.evaluate(JS_SELECTED)) || {};
      return isZalopaySelected(x, label) ? x : null;
    }, { seconds: 8.0, pulse: 0.4, shouldStop })) || {};
    if (isZalopaySelected(st, label)) {
      // Report by the CHECKED radio, not by `selected`: `selected` grabs the
      // text right after the "Payment method" heading, and the card row is
      // always first in the list, so it always reads "Credit card" — printing
      // it makes it look like the switch failed.
      log(`    [ok] switched to ${label} (radio: '${checkedLabel(st)}')`);
      return true;
    }
    log(`    [i] try ${i + 1}: not switched (radio now: '${checkedLabel(st)}') — retrying`);
  }
  return false;
}

// Old name kept for compatibility. Use `chooseWallet` for any wallet.
export function selectZalopay(page, human, { log = console.log, shouldStop = null, tries = 3 } = {}) {
  return chooseWallet(page, human, { label: 'ZaloPay', log, shouldStop, tries });
}

// Label of the currently checked radio ('' when none).
export function checkedLabel(state) {
  for (const r of ((state || {}).radios) || []) {
    if (r.checked) return String(r.text || '').trim();
  }
  return '';
}

// True when the wallet's radio is `checked`, or the selected row names the
// wallet. Compared lowercase: the cashier shows "ZaloPay", "MoMo"...
export function isZalopaySelected(state, label = 'ZaloPay') {
  const head = String(label || '').toLowerCase().slice(0, 4); // "zalo" / "momo"
  if (head && String(((state || {}).selected) || '').toLowerCase().includes(head)) return true;
  for (const r of ((state || {}).radios) || []) {
    if (r.checked && head && String(r.text || '').toLowerCase().includes(head)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Grabbing the QR and moving it to the phone
// ---------------------------------------------------------------------------

// Short fingerprint of a QR image — tells whether a reload returned the OLD
// code or a different one.
export function qrFingerprint(b64) {
  return crypto.createHash('sha1').update(String(b64 || '')).digest('hex').slice(0, 12);
}

// Wait for the page to navigate to a wallet page. Returns the URL, or ''.
// Takes a LIST so ANY wallet in it is accepted: CapCut sometimes pushes to a
// different wallet than the one just picked (gateway swap); waiting for one
// exact host would miss it.
export async function waitBindingPage(page, { log = console.log, seconds = 90, shouldStop = null, wallet = null, walletList = null } = {}) {
  const list = walletList || [wallet || walletInfo('zalopay')];
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    let url = '';
    try {
      url = (await page.evaluate('location.href')) || '';
    } catch {
      url = ''; // navigating right now — retry next pulse
    }
    if (onWalletPageAny(url, list)) return url;
    await sleep(2000);
  }
  return '';
}

// Wait until the ZaloPay page has MOUNTED before running DOM-reading JS.
// Needed because waitBindingPage returns the moment the URL changes — the
// document is still loading, `document.body` can be null and every DOM read
// throws. The page is a React app ("You need to enable JavaScript to run this
// app"), so wait until it has painted content too.
export async function waitPageReady(page, { log = console.log, seconds = 60, shouldStop = null } = {}) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    let ok = false;
    try {
      ok = await page.evaluate(
        "(() => document.readyState !== 'loading' && !!document.body " +
        '&& document.body.childElementCount > 0)()');
    } catch {
      ok = false; // context navigating -> retry
    }
    if (ok) return true;
    await sleep(1500);
  }
  log('    [i] ZaloPay page never reported ready — still trying to read the QR.');
  return false;
}

// Race a promise against a deadline — python used pychrome's _timeout=30.
function withTimeout(promise, ms, label) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  timer.unref?.();
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

// One cached CDP session per tab (Playwright equivalent of python's always-on
// pychrome tab session). Dropped on error so the next capture reconnects.
const cdpSessions = new WeakMap();

// Screenshot the QR canvas region. Primary path is the same CDP
// `Page.captureScreenshot` call python made (page-coordinate clip, scale=2 for
// a double-sharp image the phone camera locks onto); falls back to Playwright's
// own screenshot when no CDP session can be opened (clip in VIEWPORT
// coordinates, scroll subtracted). Returns raw base64 ('' on failure).
// Screenshotting is the only way: canvas.toDataURL() throws SecurityError
// because the page paints a cross-origin logo into the canvas (tainted).
export async function captureClip(tab, box, { log = console.log, pad = 10, scale = 2 } = {}) {
  const x = Math.max(0.0, Number(box.x || 0) - pad);
  const y = Math.max(0.0, Number(box.y || 0) - pad);
  const width = Number(box.w || 0) + pad * 2;
  const height = Number(box.h || 0) + pad * 2;
  try {
    let cdp = cdpSessions.get(tab);
    if (!cdp) {
      cdp = await tab.context().newCDPSession(tab);
      cdpSessions.set(tab, cdp);
    }
    const r = await withTimeout(
      cdp.send('Page.captureScreenshot',
        { format: 'png', clip: { x, y, width, height, scale }, captureBeyondViewport: true }),
      30000, 'Page.captureScreenshot');
    return (r && r.data) || '';
  } catch (e) {
    // CDP path failed (no session support / capture error) — try Playwright's
    // screenshot with a viewport-relative clip before giving up.
    try {
      const clip = {
        x: Math.max(0, x - Number(box.sx || 0)),
        y: Math.max(0, y - Number(box.sy || 0)),
        width,
        height,
      };
      const buf = await withTimeout(
        tab.screenshot({ type: 'png', clip }),
        30000, 'page.screenshot');
      return buf ? buf.toString('base64') : '';
    } catch (e2) {
      log(`    [!] Could not capture the QR: ${e2 && e2.message ? e2.message : e2}`);
      return '';
    }
  }
}

// Call `doc()` every `pulse` seconds until it returns a "truthy" value, at
// most `seconds` total. Replacement for a fixed time.sleep(N): N had to be
// sized for the SLOWEST case, so every run waited too long. Conditional
// waiting means fast pages finish fast and slow pages still get their time.
// Returns the read value, or the last (null) value on timeout.
export async function waitUntil(doc, { seconds = 20.0, pulse = 0.5, shouldStop = null } = {}) {
  const deadline = Date.now() + Math.max(0.0, seconds) * 1000;
  let last = null;
  for (;;) {
    checkStop(shouldStop);
    try {
      last = await doc();
    } catch {
      last = null; // page navigating: retry next pulse
    }
    if (last) return last;
    if (Date.now() >= deadline) return last;
    await sleep(pulse * 1000);
  }
}

// Decode PNG bytes to a grayscale buffer (ITU-R 601-2 luma, same as PIL's
// convert("L")). Returns {g, w, h}; throws on a corrupt PNG (caller decides).
function grayFromPng(rawPng) {
  const png = PNG.sync.read(Buffer.from(rawPng));
  const w = png.width;
  const h = png.height;
  const data = png.data;
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = Math.trunc((data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000);
  }
  return { g, w, h };
}

// Replicate a grayscale buffer into the RGBA Uint8ClampedArray jsQR eats.
function rgbaFromGray(g, w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    const v = g[i];
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
  }
  return rgba;
}

// QR content decode over image VARIANTS, ORIGINAL FIRST. Port of python
// bien_the_giai + its pyzbar loop (merged because jsQR, unlike pyzbar, is the
// only decoder here). Order matters: the original image is tried first and is
// NEVER modified. Measured on 13 real ZaloPay codes: 13/13 decoded on the
// original, 0/13 after white-padding (700x700 -> 840x840). ZBar scanned with
// fixed row strides so resizing broke it; jsQR behaves the same way. The later
// variants only exist to rescue an image that ALREADY failed.
// Variants: original -> 2x NEAREST upscale -> white margins at 10% and 25%
// (a code painted flush to the edge — suspected on MoMo — lacks its quiet
// zone). Returns the decoded payload string, '' when nothing decoded.
export function decodeQrVariant(rawPng) {
  const { g, w, h } = grayFromPng(rawPng);
  const variants = [{ g, w, h }];
  try {
    const w2 = w * 2;
    const h2 = h * 2;
    const up = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      const sy = (y >> 1) * w;
      const dy = y * w2;
      for (let x = 0; x < w2; x++) up[dy + x] = g[sy + (x >> 1)];
    }
    variants.push({ g: up, w: w2, h: h2 });
  } catch { /* upscale is best-effort, like python */ }
  for (const ratio of [0.10, 0.25]) {
    try {
      const m = Math.max(16, Math.trunc(Math.min(w, h) * ratio));
      const wn = w + 2 * m;
      const hn = h + 2 * m;
      const padded = new Uint8Array(wn * hn).fill(255);
      for (let y = 0; y < h; y++) padded.set(g.subarray(y * w, (y + 1) * w), (y + m) * wn + m);
      variants.push({ g: padded, w: wn, h: hn });
    } catch { /* padding is best-effort, like python */ }
  }
  for (const v of variants) {
    let payload = '';
    try {
      const got = jsQR(rgbaFromGray(v.g, v.w, v.h), v.w, v.h);
      // The waiting frame still makes pyzbar RECOGNIZE a QR symbol whose
      // content is an EMPTY string — seen live. Demand real content.
      payload = (got && got.data ? String(got.data) : '').trim();
    } catch {
      payload = '';
    }
    if (payload) return payload;
  }
  return '';
}

// Is the captured image a REAL QR code? Returns [ok, description].
//
// The ZaloPay page pre-paints a fake QR frame (gray background, sparse
// modules) while the real code is being fetched. The canvas already exists so
// grabQr would grab it and push a non-scannable image to the queue — seen
// live, a 6.4KB image pyzbar accepted.
//
// Decoded content decides (jsQR = the pyzbar of this port, always available;
// python's "no pyzbar -> density-only" branch is gone). The row-flip density
// is still computed for the failure message: a real code (long agreement URL)
// is always dense, the waiting frame is sparse.
export function qrIsScannable(b64, { log = null, wallet = 'zalopay' } = {}) {
  const s = String(b64 || '').replace(/^data:image\/\w+;base64,/, '');
  const raw = Buffer.from(s, 'base64');
  if (!raw.length) return [false, 'empty image'];

  let img = null;
  try {
    img = grayFromPng(raw);
  } catch {
    // Deviation vs python: a corrupt PNG crashed the whole flow there; here it
    // just counts as "not a real code yet" so the wait loop keeps polling.
    return [false, 'cannot decode the PNG image'];
  }
  const { g, w, h } = img;

  const flips = [];
  for (const f of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const y = Math.min(h - 1, Math.trunc(h * f));
    let prev = g[y * w] > 128;
    let n = 0;
    for (let x = 1; x < w; x++) {
      const cur = g[y * w + x] > 128;
      if (cur !== prev) n++;
      prev = cur;
    }
    flips.push(n);
  }
  flips.sort((a, b) => a - b);
  const mid = flips[Math.trunc(flips.length / 2)];

  let payload = '';
  try {
    payload = decodeQrVariant(raw);
  } catch {
    payload = '';
  }
  const needles = walletInfo(wallet).qr || [];
  if (payload && needles.some((k) => payload.includes(k))) {
    return [true, `decoded (${payload.slice(0, 48)}...)`];
  }
  if (payload && !needles.length) {
    // Wallet format not measured yet: the waiting frame decodes to an EMPTY
    // string, so non-empty and long enough is already a real code. Print it
    // to pin down the signature.
    if (payload.length >= 20) return [true, `content ${payload.length} chars (${payload.slice(0, 60)})`];
    return [false, `content too short (${payload.slice(0, 48)})`];
  }
  if (payload) return [false, `decoded strange content (${payload.slice(0, 48)})`];
  return [false, `jsQR read no content (density ${mid})`];
}

// Grab the QR image from the ZaloPay page. Returns the JS_QR_BOX dict plus a
// `b64` key (base64 PNG). A missing `b64` means the canvas has not painted yet
// or the capture failed.
export async function grabQr(page, tab, { log = console.log, seconds = 60, shouldStop = null, wallet = 'zalopay' } = {}) {
  const deadline = Date.now() + seconds * 1000;
  let last = {};
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    // Wrapped in try: while the page mounts/navigates the JS read throws —
    // one failed read must not kill the whole wait loop.
    let d;
    try {
      d = (await page.evaluate(JS_QR_BOX)) || {};
    } catch {
      await sleep(2000);
      continue;
    }
    last = d;
    if (d.found && (Number(d.w) || 0) >= 80) {
      const b64 = await captureClip(tab, d, { log });
      if (b64) {
        const [ok, why] = qrIsScannable(b64, { log, wallet });
        if (ok) {
          d.b64 = b64;
          return d;
        }
        log(`    [i] not the real code yet (${why}) — waiting for it to finish drawing`);
      }
    }
    await sleep(2500);
  }
  return last;
}

// Write the QR image to a PNG file. Accepts a bare base64 string or a
// dataURL. Returns the absolute path ('' on nothing written).
export function saveQrPng(data, filePath, { log = console.log } = {}) {
  let s = String(data || '');
  const m = /^data:image\/\w+;base64,(.+)$/s.exec(s);
  if (m) s = m[1];
  if (!s) return '';
  s = s.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    log('    [!] Could not decode the QR base64 payload');
    return '';
  }
  const raw = Buffer.from(s, 'base64');
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, raw);
  return path.resolve(filePath);
}

// Tiny LAN HTTP server so the phone can open the QR in its browser.
// Much simpler than copying a file to another machine: a phone on the same
// Wi-Fi opens `http://<lan-ip>:<port>/` and sees the code, scans it with the
// ZaloPay app right there. Serves from node:http (python: http.server in a
// daemon thread). start() resolves with the LAN URL, rejects when the port
// cannot be bound.
export class QrServer {
  // pngPath: PNG to serve; port: LAN port (default 8765); deadlineText: the
  // countdown note shown under the heading.
  constructor(pngPath, { port = 8765, deadlineText = '' } = {}) {
    this.pngPath = pngPath;
    this.port = Math.trunc(Number(port) || 8765);
    this.deadlineText = String(deadlineText || '');
    this._srv = null;
  }

  // LAN IP of this machine. UDP "connect" trick (no packet is sent — it only
  // makes the routing table pick an interface); falls back to 127.0.0.1.
  static lanIp() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ip) => {
        if (settled) return;
        settled = true;
        try { s.close(); } catch { /* already closed */ }
        resolve(ip);
      };
      const s = dgram.createSocket('udp4');
      s.once('error', () => done('127.0.0.1'));
      try {
        s.connect(80, '8.8.8.8', () => {
          const a = s.address();
          done(a && a.address ? a.address() : '127.0.0.1');
        });
      } catch {
        done('127.0.0.1');
      }
    });
  }

  // Bind on 0.0.0.0 and start serving. GET /qr.png -> the PNG (no-store);
  // anything else -> a dark mobile-friendly page showing the image. Returns
  // the URL to open on the phone.
  async start(log = console.log) {
    const pngPath = this.pngPath;
    const note = this.deadlineText;
    const server = http.createServer((req, res) => {
      const u = req.url || '/';
      if (u.startsWith('/qr.png')) {
        let body;
        try {
          body = fs.readFileSync(pngPath);
        } catch {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }
      const html =
        '<!doctype html><meta charset=utf-8>' +
        "<meta name=viewport content='width=device-width,initial-scale=1'>" +
        '<title>Scan with ZaloPay</title>' +
        "<body style='margin:0;background:#111;color:#eee;" +
        "font-family:system-ui,sans-serif;text-align:center'>" +
        '<h2 style=\'margin:16px 0 4px\'>Scan with the ZaloPay app</h2>' +
        `<p style='margin:0 0 12px;color:#9ad'>${note}</p>` +
        "<img src='/qr.png' style='width:min(88vw,420px);" +
        "background:#fff;padding:12px;border-radius:12px'>" +
        '<p style=\'color:#888;font-size:14px;padding:0 16px\'>' +
        'Open ZaloPay or Zalo &rarr; Scan code &rarr; point the camera at the image above.' +
        '</p></body>';
      const body = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
      });
      res.end(body);
    });
    this._srv = server;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: this.port, host: '0.0.0.0' }, resolve);
    });
    const url = `http://${await QrServer.lanIp()}:${this.port}/`;
    log(`    [ok] Open on your phone (same Wi-Fi): ${url}`);
    return url;
  }

  // Stop serving. Never throws; safe to call twice.
  stop() {
    try {
      if (this._srv) this._srv.close();
    } catch { /* already down */ }
  }
}

// ---------------------------------------------------------------------------
// Waiting for the payment to finish
// ---------------------------------------------------------------------------

// Helper tab per page object, so the whole wait opens it ONCE: constantly
// opening/closing tabs breaks the main tab's CDP connection.
const HELPER_TABS = new WeakMap();

// Open (or reuse) a helper tab to ask CapCut questions without touching the
// payment tab. Returns the tab, or null when the context is gone.
export async function openHelperTab(page, log = console.log) {
  const existing = HELPER_TABS.get(page);
  if (existing) return existing;
  let tab = null;
  try {
    tab = await page.context().newPage();
  } catch {
    return null;
  }
  HELPER_TABS.set(page, tab);
  log('    [i] opened a helper tab to read credits');
  return tab;
}

// Close the helper tab when done. Safe to call repeatedly. (A tab closed by
// closeExtraTabs stays a dead entry here, exactly like python's stale
// `page._tab_phu` — the next proActive read fails, is caught, and returns
// [false, 0], same behavior.)
export async function closeHelperTab(page, log = console.log) {
  const tab = HELPER_TABS.get(page);
  if (!tab) return;
  HELPER_TABS.delete(page);
  try {
    await tab.close();
  } catch { /* already closed elsewhere */ }
}

// Ask CapCut whether the account is Pro yet (`vip_credit` > 0). ALWAYS in the
// HELPER TAB — never navigate the paying tab: after the wallet reports success
// that very tab must finish the `get_pay_result` loop — that is the step where
// CapCut grants the plan (measured: keep it and the account goes Pro, drag it
// away and it never does). Returns [isPro, totalCredits]. `locale` kept for
// python parity (the python body ignored it too).
export async function proActive(page, { log = console.log, locale = 'vi-vn' } = {}) {
  let cred = {};
  try {
    const tab = await openHelperTab(page, log);
    if (!tab) {
      log('    [i] could not open a helper tab — skipping the vip_credit check');
      return [false, 0];
    }
    await tab.goto(APP_URL);
    await waitForDomReady(tab, { timeout: 40, settle: [2.0, 3.0] });
    await sleep(2000);
    cred = (await getCredit(tab)) || {};
  } catch (e) {
    log(`    [!] could not ask CapCut: ${e && e.constructor && e.constructor.name}: ${e && e.message ? e.message : e}`);
    return [false, 0];
  }
  const vip = Math.trunc(Number(cred.vip_credit) || 0);
  const total = creditTotal(cred);
  log(`    [i] CapCut (helper tab): vip_credit=${vip}, total ${total}`);
  return [vip > 0, total];
}

// Close every other tab in the profile, keep only the one being driven.
//
// Clicking "Start trial" on the CapCut payment page usually leaves an extra
// checkout window (`cashier-*.pipopay.com`) behind while the QR lives in this
// tab. That other tab is unused: wasted RAM, and in multi-thread runs every
// account carries a spare window.
//
// Only call AFTER the QR has been captured on this tab — that is the point
// where the keep-tab is certain. Returns the number of tabs closed.
export async function closeExtraTabs(page, keepTab, { log = console.log } = {}) {
  let pages;
  try {
    pages = page.context().pages();
  } catch (e) {
    log(`    [i] could not list tabs (${e && e.constructor && e.constructor.name}) — skipping`);
    return 0;
  }
  let closed = 0;
  for (const p of pages) {
    if (p === keepTab) continue;
    try {
      await p.close();
      closed++;
    } catch { /* tab closed itself already — not an error */ }
  }
  if (closed) log(`    [i] closed ${closed} extra tab(s), keeping only the QR tab`);
  return closed;
}

// Wait until the scan is done and ZaloPay confirms. Returns
// ['done', trade] | ['failed', reason] | ['stop', reason] | ['timeout', reason].
// Reads the netlog for `pay_status`, and watches the page leave
// binding.zalopay.vn (the sign the binding finished and it returned to CapCut).
//
// `onTick` (optional) runs every pulse — used to refresh the QR image on the
// server when the code nears expiry. `onLeft` runs EXACTLY ONCE when the page
// leaves binding.zalopay.vn (someone finished scanning). Errors inside them
// never break the wait loop.
export async function waitPaid(page, netlogPath, {
  log = console.log, seconds = 300, shouldStop = null, startLine = 0,
  onTick = null, onLeft = null, state = null, graceAfterSuccess = 45,
} = {}) {
  const cp = await import('./capcut-pro.js');
  const deadline = Date.now() + seconds * 1000;
  let last = '';
  let leftBinding = false;
  let asks = 0;        // vip_credit checks made after the wallet said success
  const maxAsks = 3;   // more than this with nothing there means it is not coming
  let successAt = 0;
  let dead = 0;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    await sleep(5000);

    // Read the page state FIRST: ZaloPay shows "Authentication failed / Link
    // expired" when the wait was too long. Waiting for the clock's grace mark
    // is pointless then — reload NOW.
    const trang = leftBinding ? '' : await zaloState(page);
    if (trang === 'success' && !leftBinding) {
      leftBinding = true;
      successAt = Date.now();
      log('    [i] ZaloPay reports AUTHENTICATION SUCCEEDED — waiting for CapCut to confirm ...');
      // Do NOT reopen cashier_url here. Tried at 03:39 on 31/08/2026: the
      // order was already bound, and reopening the payment page made pipo
      // return PIPO_PARAMETER_ERROR — the netlog wait then saw err_code and
      // concluded FAILED, killing an account that was on its way to Pro.
      if (onLeft) {
        try {
          await onLeft();
        } catch (e) {
          log(`    [!] 'scanned' report slipped: ${e && e.constructor && e.constructor.name}: ${e && e.message ? e.message : e}`);
        }
      }
    }
    // Check in on EVERY pulse, even after the scan finished: the tool is still
    // waiting for CapCut's confirmation, and stopping the check-ins makes the
    // board show "lost connection" for a perfectly healthy code (seen live at
    // 03:34 while running 10 threads).
    if (state && state.api) {
      try {
        await state.api.alive();
      } catch { /* soft-fail, like the client itself */ }
    }

    if (onTick && !leftBinding) {
      try {
        await onTick(trang === 'failed' ? 'expired' : '');
      } catch (e) {
        log(`    [!] QR refresh slipped: ${e && e.constructor && e.constructor.name}: ${e && e.message ? e.message : e}`);
      }
      // onTick can detect the account already went Pro even though the
      // ZaloPay page says failed — then stop waiting right away.
      const done = state ? state.done : null;
      if (done) return ['done', done];
    }

    // Opening a new order mid-flight moves the netlog read mark; otherwise an
    // OLD order's error gets picked up and misread as this attempt failing.
    const base = state && state.mark !== undefined && state.mark !== null ? state.mark : startLine;
    const markLine = Math.trunc(Number(base)) || 0;
    const tr = (await cp.scanNetlog(netlogPath, markLine)) || {};
    let ec = String(tr.err_code || '');
    if (ec && successAt) {
      // The wallet already reported success: errors appearing after that are
      // usually from the surplus actions (reopening the payment page,
      // reloading...), not a broken order. Log and move on — let vip_credit
      // decide.
      log(`    [i] ignoring late error after authentication: ${ec}`);
      ec = '';
    }
    if (ec) {
      const tip = String(tr.err_tip || tr.err_msg || '');
      return ['failed', `${ec} — ${tip.slice(0, 140)}`];
    }
    if (tr.pay_status === 'SUCCESS') return ['done', tr];
    if (tr.pay_status === 'FAILED' || tr.pay_status === 'CLOSED' || tr.pay_status === 'CANCELLED') {
      return ['failed', `pay_status=${tr.pay_status}`];
    }

    let url = '';
    try {
      url = (await page.evaluate('location.href')) || '';
      dead = 0;
    } catch (e) {
      // One flaky JS read is skipped. But a fully dead tab (browser closed,
      // websocket gone) will never answer: bail out cleanly so the caller can
      // report 'fail' to the queue, instead of dumping a stacktrace mid-flow
      // and leaving a 'pending' code for someone to scan a dead QR.
      url = '';
      dead += 1;
      // Generous threshold: helper-tab work can cause a momentary CDP error,
      // and concluding "browser dead" too early kills a paying account (lost
      // 2 accounts at 03:56 to a threshold of 3).
      if (dead >= 8) {
        return ['failed', `browser connection lost (${e && e.constructor && e.constructor.name})`];
      }
    }
    if (url && !leftBinding && !onWalletPage(url, walletInfo(state ? state.wallet : 'zalopay'))) {
      leftBinding = true;
      log('    [i] left the ZaloPay page — waiting for CapCut to confirm ...');
      if (onLeft) {
        try {
          await onLeft();
        } catch (e) {
          log(`    [!] 'scanned' report slipped: ${e && e.constructor && e.constructor.name}: ${e && e.message ? e.message : e}`);
        }
      }
    }

    // The wallet agreement reports BROKEN: stop now, more waiting is useless.
    // "AUTHENTICATION SUCCEEDED" on the page only says the wallet login
    // finished, not that the agreement was created — `agree_status=FAILED` is
    // the verdict.
    const agree = String(tr.agree_status || '').toUpperCase();
    if (agree === 'FAILED' || agree === 'FAIL' || agree === 'CANCELLED' ||
        agree === 'CANCELED' || agree === 'REJECTED') {
      return ['stop', `wallet reports agreement ${agree} — the scan did not succeed`];
    }

    // Page says success but CapCut writes nothing: the ZaloPay page does NOT
    // return to capcut.com by itself, so the netlog can stay empty until the
    // deadline. Go ask `vip_credit` instead of hanging.
    if (successAt && Date.now() - successAt > graceAfterSuccess * 1000) {
      const [daPro, total] = await proActive(page, { log });
      if (daPro) {
        log(`    [ok] CapCut confirms Pro is active (${total} credits total).`);
        return ['done', { pay_method: 'ZaloPay', credits: total, vip_ok: true, note: 'confirmed via vip_credit' }];
      }
      asks += 1;
      // Successful accounts get vip_credit within a minute of the wallet
      // reporting done (measured: 11 and 12 seconds). If ask number
      // `maxAsks` still sees nothing it is not slowness — it is absent.
      if (asks >= maxAsks) {
        return ['stop',
          `wallet reported success but CapCut never granted the plan after ${asks} checks ` +
          `(vip_credit still 0, total ${total})`];
      }
      log(`    [!] No vip_credit yet after ZaloPay reported success (check ${asks}/${maxAsks}) — waiting more.`);
      // Touch nothing on the payment tab: it is still finishing the order
      // flow on its own. Just ask again after one more grace pulse.
      successAt = Date.now();
    }

    const note = `stage=${tr.stage} agree=${tr.agree_status} pay=${tr.pay_status}`;
    if (note !== last) {
      log(`    ${note}`);
      last = note;
    }
  }
  return ['timeout', 'ran out of time waiting for the QR scan'];
}

// ---------------------------------------------------------------------------
// QR queue server
// ---------------------------------------------------------------------------

// Prepare a slot in the queue on the QR server.
//
// `qrApi` accepts: null/false (skip), true (default host), a host string, or
// an already-built ZaloQRClient. Returns the registered client, or null —
// failing to register never stops the claim flow, it just runs on the LAN
// server alone.
export async function openQrApi(qrApi, email, bindingUrl, { log = console.log } = {}) {
  if (!qrApi) return null;
  let api = qrApi;
  if (api === true) {
    api = new ZaloQRClient(DEFAULT_HOST, { log });
  } else if (typeof api === 'string') {
    api = new ZaloQRClient(api, { log });
  }
  if (!api.userId) {
    if (!email) {
      log('    [!] QR API: no email — cannot open a queue slot');
      return null;
    }
    if (!(await api.register(email))) return null;
  }
  await api.setBinding(bindingUrl);
  log(`[i] QR queue: ${api.qrUrl()}`);
  return api;
}

// ---------------------------------------------------------------------------
// The full flow
// ---------------------------------------------------------------------------

// (inlined from capcut_pro.py — see the deviation note near the top)
// Visible 'Nâng cấp' / 'Upgrade' buttons on the current page, top-first.
const JS_ANY_UPGRADE = `
(() => {
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
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
})()
`;

// (inlined from capcut_pro.py) The Pro trial card + its Upgrade button.
const JS_PRO_BTN = `
(() => {
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
    let card = null;
    document.querySelectorAll('div, section, li').forEach(n => {
        const t = norm(n.innerText);
        if (!t || t.length < 40 || t.length > 700) return;
        if (!/(₫|VND)/.test(t) || !/\\bPro\\b/.test(t)) return;
        if (!/(7 ngày|7 days)/.test(t)) return;
        const r = n.getBoundingClientRect();
        if (r.width < 150 || r.height < 200) return;
        let inner = false;
        n.querySelectorAll('div, section, li').forEach(c => {
            const ct = norm(c.innerText);
            if (ct.length > 40 && /\\bPro\\b/.test(ct)
                && /(7 ngày|7 days)/.test(ct) && ct.length > t.length * 0.8)
                inner = true;
        });
        if (inner) return;
        if (!card) card = n;
    });
    if (!card) return {error: 'khong thay card Pro co uu dai 0d'};
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
    if (!btn) return {error: 'khong thay nut trong card Pro'};
    btn.scrollIntoView({block: 'center', inline: 'center'});
    const r = btn.getBoundingClientRect();
    return {cardText: norm(card.innerText).slice(0, 400),
            text: norm(btn.innerText),
            x: r.left + r.width / 2, y: r.top + r.height / 2,
            inView: r.top >= 0 && r.bottom <= innerHeight};
})()
`;

// (inlined from capcut_pro.py `_wait_netlog`) Poll the netlog file until a
// raw line contains `needle`. The netlog is line-JSON, so a substring match on
// the raw line is enough and never needs parsing.
async function waitNetlogNeedle(filePath, needle, seconds, shouldStop = null) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    checkStop(shouldStop);
    try {
      for (const line of readLines(filePath)) {
        if (line.includes(needle)) return true;
      }
    } catch { /* file unreadable this round — retry next pulse */ }
    await sleep(1500);
  }
  return false;
}

// Normalize capcut-pro.js openOrderViaApi()'s return into {oid, curl}.
// Worker G's exact return shape is not pinned by the contract yet, so accept
// the python tuple [oid, curl] AND an {orderId|oid|order_id,
// cashierUrl|curl|cashier_url} object.
function normalizeOrder(r) {
  if (Array.isArray(r)) {
    return { oid: String(r[0] ?? ''), curl: String(r[1] ?? '') };
  }
  if (r && typeof r === 'object') {
    return {
      oid: String(r.orderId ?? r.oid ?? r.order_id ?? ''),
      curl: String(r.cashierUrl ?? r.curl ?? r.cashier_url ?? ''),
    };
  }
  return { oid: '', curl: '' };
}

// From `cashierUrl` to the QR image: open the payment page, VERIFY the amount
// is 0, pick the wallet, click confirm, capture the code. Shared by the API
// path and the manual-click path so the two can never drift on safety latches.
// Returns ['done', {url, qr, mark, cashier, wallet}] | ['stop', reason].
export async function openCashier(page, human, tab, netlogPath, cashierUrl, mark, { log = console.log, shouldStop = null, wallet = 'zalopay' } = {}) {
  const cp = await import('./capcut-pro.js');

  log('[>] Opening the payment page');
  await page.goto(cashierUrl);
  await waitForDomReady(page, { timeout: 45, settle: [1.0, 2.0] });
  await waitNetlogNeedle(netlogPath, 'pre_order_details', 45, shouldStop);

  // Safety latch: only continue when the due amount is 0. Wait until the
  // amount can be READ — that is what the old 6-second sleep was waiting for.
  const trade = (await waitUntil(async () => {
    const t = await cp.scanNetlog(netlogPath);
    return t && t.amount != null ? t : null;
  }, { seconds: 20.0, pulse: 0.5, shouldStop })) || {};
  const amt = trade.amount;
  log(`[i] due now = ${amt} ${trade.currency} | ${trade.discount_type}`);
  log(`    sku=${trade.sku_name} intro=${trade.intro_amount} standard=${trade.standard_amount}`);
  if (amt == null) return ['stop', 'could not read the amount'];
  if (String(amt) !== '0') return ['stop', `amount ${amt} is not 0 — stopping`];

  const wallets = walletList(wallet);
  let chosen = null;
  for (const cand of wallets) {
    log(`[>] Choosing payment method ${cand.label}`);
    if (await chooseWallet(page, human, { label: cand.label, log, shouldStop })) {
      chosen = cand;
      break;
    }
    log(`    [i] could not pick ${cand.label} — trying another wallet`);
  }
  if (!chosen) {
    const names = wallets.map((w) => w.label).join(' / ');
    return ['stop', `could not switch to any wallet (${names})`];
  }

  const pay = await cp.findConfirm(page, { seconds: 45, shouldStop });
  if (!pay) return ['stop', 'the confirm button never enabled'];

  mark = await cp.countLines(netlogPath);
  log(`[>] clicking ${JSON.stringify(String(pay.text || '').slice(0, 40))}`);
  await human.clickXY(pay.x, pay.y);

  const url = await waitBindingPage(page, {
    log, seconds: 90, shouldStop, wallet: chosen, walletList: wallets,
  });
  if (!url) {
    const tr = (await cp.scanNetlog(netlogPath, mark)) || {};
    const ec = String(tr.err_code || '');
    if (ec) return ['stop', `${ec} — ${String(tr.err_tip || '').slice(0, 140)}`];
    return ['stop', `never reached the ${chosen.label} page`];
  }
  // The REAL wallet is the one whose page just opened, not necessarily the one
  // clicked: the gateway sometimes pushes to a different wallet. Everything
  // after this (QR capture, payment wait, reloads) follows THIS one.
  const vi = onWalletPageAny(url, wallets) || chosen;
  log(`[i] ${vi.label} page: ${url.slice(0, 110)}`);
  // URL changed but React has not mounted — reading the DOM right now throws.
  await waitPageReady(page, { log, seconds: 60, shouldStop });

  const d = await grabQr(page, tab, { log, seconds: 90, shouldStop, wallet: vi.label.toLowerCase() });
  if (!d.b64) return ['stop', 'could not grab the QR image'];
  log(`[ok] got the QR ${Math.trunc(Number(d.w) || 0)}x${Math.trunc(Number(d.h) || 0)}` +
      ` | page deadline: ${d.countdown || 'not seen'}`);
  await closeExtraTabs(page, tab, { log });
  return ['done', { url, qr: d, mark, cashier: cashierUrl, wallet: vi.label.toLowerCase() }];
}

// Open ONE new Pro trial order and grab its wallet QR.
//
// Split out because a ZaloPay code CANNOT be refreshed in place: reloading the
// binding page (or the very link inside the code) only returns the SAME old
// image — measured in the 23:55 run, three reload paths gave byte-identical
// images. A different code needs the whole flow again so CapCut opens another
// order with a different `binding_token`.
//
// Returns ['done', {url, qr, mark, cashier, wallet}] | ['retry', reason] |
// ['stop', reason]. `mark` is this order's netlog line mark, so the caller
// only reads THIS order's result.
export async function openNewQr(page, human, tab, netlogPath, { log = console.log, shouldStop = null, apiFirst = false, wallet = 'zalopay' } = {}) {
  const cp = await import('./capcut-pro.js');

  // Fast path: 2 requests to a cashier_url. The manual-click path below stays
  // as the fallback — if CapCut changes the API the claim still works, just
  // slower.
  let oid = '';
  let curl = '';
  let mark = await cp.countLines(netlogPath);
  try {
    if (!apiFirst) throw new Error('off'); // python forced the manual path with RuntimeError('tat')
    const region = String(cp.REGION || 'VN') || 'VN';
    ({ oid, curl } = normalizeOrder(await cp.openOrderViaApi(page, { region, log, shouldStop })));
  } catch (e) {
    if (apiFirst) {
      log(`    [i] opening the order via API failed (${e && e.constructor && e.constructor.name}: ${e && e.message ? e.message : e}) — clicking manually`);
    }
    oid = '';
    curl = '';
  }
  if (curl === 'khong-duoc-moi') {
    // Do NOT conclude yet: the API path is new, a misread would burn a valid
    // account. Let the manual path below judge by the Pro card's text.
    log('    [i] price table shows no 0đ plan — double-checking on the upgrade page');
    curl = '';
  }
  if (curl) {
    log(`[i] order_id=${oid}`);
    return openCashier(page, human, tab, netlogPath, curl, mark, { log, shouldStop, wallet });
  }

  log('[>] Opening the workspace page');
  await page.goto('https://www.capcut.com/ai-design');
  await waitForDomReady(page, { timeout: 40, settle: [3.0, 4.0] });
  await cp.closeOverlays(page, human, { log });
  checkStop(shouldStop);

  let cands = [];
  const deadline = Date.now() + 70000;
  while (Date.now() < deadline && !cands.length) {
    checkStop(shouldStop);
    cands = (await page.evaluate(JS_ANY_UPGRADE)) || [];
    if (!cands.length) await sleep(2000);
  }
  if (!cands.length) return ['retry', "top bar has no 'Upgrade' button"];
  log(`[>] clicking ${JSON.stringify(String(cands[0].text || '').slice(0, 36))} (top bar)`);
  await human.clickXY(cands[0].x, cands[0].y);
  // Wait for the Pro card to appear instead of counting 9 seconds. Accept
  // only a POSITIVE result: right after the click the card is not mounted and
  // the JS returns {"error": "no Pro card..."} — taking that as the answer
  // concludes "not invited" after 1 second and burns a valid account (seen
  // live at 02:52 on 31/08/2026).
  let info = await waitUntil(async () => {
    const x = (await page.evaluate(JS_PRO_BTN)) || {};
    return x.cardText ? x : null;
  }, { seconds: 20.0, pulse: 0.6, shouldStop });
  if (!info) {
    // 20 seconds and still no card: read once more to get the exact reason.
    info = (await page.evaluate(JS_PRO_BTN)) || {};
  }
  if (info.error) return ['retry', info.error];
  const cardText = String(info.cardText || '');
  log(`[i] Pro card: ${cardText.slice(0, 150)}`);
  if (!cardText.includes('0₫') || (!cardText.includes('7 ngày') && !cardText.includes('7 days'))) {
    return ['retry', 'Pro card has no 0đ/7-day offer'];
  }
  if (!info.inView) return ['retry', 'Pro button outside the viewport'];

  log("[>] clicking 'Upgrade' inside the Pro card");
  await human.clickXY(info.x, info.y);
  if (!(await waitNetlogNeedle(netlogPath, 'trade/init_trade', 50, shouldStop))) {
    return ['retry', 'init_trade was not called'];
  }
  const trade = (await waitUntil(async () => {
    const t = await cp.scanNetlog(netlogPath);
    return t && t.cashier_url ? t : null;
  }, { seconds: 15.0, pulse: 0.4, shouldStop })) || {};
  curl = trade.cashier_url || '';
  log(`[i] order_id=${trade.order_id}`);
  if (!curl) return ['retry', 'no cashier_url'];

  return openCashier(page, human, tab, netlogPath, curl, mark, { log, shouldStop, wallet });
}

// Claim the 7-day Pro trial, paid with ZaloPay (QR scan).
//
// Reuses the whole order-opening part of capcut-pro claimTrial (Upgrade click
// -> Pro card -> init_trade -> cashier -> VERIFY amount = 0), replacing only
// the tail: pick ZaloPay instead of typing a card.
//
// `qrTtl` forces the code's lifetime (seconds) over the page-read countdown —
// test-only hook for the auto-refresh loop.
//
// `qrApi` pushes the QR image to the queue server (a ZaloQRClient, a host
// string, or true for the default host). Needs `email` to open the slot. When
// the code nears expiry it re-captures and pushes the new one automatically.
//
// Returns [kind, payload]:
//   ['done', dict]   payment finished
//   ['retry', str]   account not invited to the offer -> rotate account + IP
//   ['stop', str]    stop entirely (amount not 0, could not pick ZaloPay, ...)
export async function claimTrialZalopay(page, human, tab, netlogPath, {
  log = console.log, shouldStop = null, qrPng = 'netlog/zalopay-qr.png',
  qrPort = 8765, waitSeconds = 300, serve = true, qrApi = null, email = '',
  qrRefreshBefore = 60, qrTtl = 0, qrReloadTries = 12, apiFirst = false,
  wallet = 'zalopay',
} = {}) {
  const cp = await import('./capcut-pro.js');
  shouldStop = shouldStop || defaultShouldStop;
  await cp.setViewport(tab, { log });

  // Credits BEFORE the claim, so the end can tell whether they really rose.
  // Read right now because the page is on capcut.com and the SDK has the
  // signing loaded.
  let creditBefore = 0;
  try {
    creditBefore = creditTotal(await getCredit(page)) || 0;
  } catch { /* not on capcut.com anymore — keep 0 */ }

  const [openKind, got] = await openNewQr(page, human, tab, netlogPath, { log, shouldStop, apiFirst, wallet });
  if (openKind !== 'done') return [openKind, got];
  const url = got.url;
  const d = got.qr;
  const mark = got.mark;
  const png = saveQrPng(d.b64, qrPng, { log });
  if (!png) return ['stop', 'could not write the QR file'];
  log(`[ok] QR saved: ${png}`);

  // Push the image to the queue server (when asked to).
  const api = await openQrApi(qrApi, email, url, { log });
  // Internal wait state. Keys (python: nap_luc/xong/vi translated):
  //   fp fingerprint of the current image; url/mark current order marks;
  //   loadedAt/ttl our own reload clock (server numbers drift); api the queue
  //   client; done set when Pro was confirmed out-of-band; wallet in play.
  const state = {
    fp: qrFingerprint(d.b64), url, mark,
    loadedAt: Date.now(), ttl: ZALO_QR_TTL, api: null,
    cashier: got.cashier || '', wallet: got.wallet ?? wallet,
  };
  state.api = api;
  if (api) {
    const secs = Math.trunc(qrTtl) || parseExpiresIn(d.texts, ZALO_QR_TTL);
    state.ttl = secs;
    const label = walletInfo(state.wallet).label;
    await api.uploadPngB64(d.b64, { expiresIn: secs, note: email ? `${label} | ${email}` : label });
  }

  // Near expiry, reload the QR link — ZaloPay extends the SAME code by 15
  // more minutes (the code itself does not change; a different code needs a
  // different order). Re-read the page countdown, push over the queue entry
  // with the new deadline. Only when a reload yields no image do we open a new
  // order — the expensive path, CapCut must create another order.
  // Runs only while still on the wallet page: leaving it means someone
  // finished scanning, reloading then would wreck it.
  const refreshQr = async (reason = '') => {
    const expired = reason === 'expired';
    if (!api) return;
    const left = Math.trunc(state.ttl - (Date.now() - state.loadedAt) / 1000);
    if (!expired && left > Math.max(0, Math.trunc(qrRefreshBefore))) return;
    let here = '';
    try {
      here = (await page.evaluate('location.href')) || '';
    } catch {
      return;
    }
    const wi = walletInfo(state.wallet ?? wallet);
    if (!onWalletPage(here, wi)) return;

    const dest = onWalletPage(here, wi) ? here : state.url;
    let nd = {};
    if (expired) {
      log('    [i] ZaloPay reports the link expired — reloading every 5s');
      // Do NOT reset yet: a reload often flips the page to "success"; resetting
      // then would report a wrong status to the scanner.
      for (let i = 0; i < Math.max(1, Math.trunc(qrReloadTries)); i++) {
        checkStop(shouldStop);
        await page.goto(dest);
        await waitForDomReady(page, { timeout: 40, settle: [1.0, 2.0] });
        if ((await zaloState(page)) === 'success') {
          log('    [i] after the reload the page reports AUTHENTICATION SUCCEEDED');
          return;
        }
        nd = await grabQr(page, tab, { log, seconds: 25, shouldStop, wallet: state.wallet ?? wallet });
        if (nd.b64) break;
        await sleep(5000);
      }
      if (!nd.b64) {
        // Still stuck on the error page. The page text cannot be trusted —
        // ask CapCut: the wallet may have finished binding long ago.
        const [daPro, total] = await proActive(page, { log });
        if (daPro) {
          log(`    [ok] Account IS PRO already (${total} credits total) — the ZaloPay page misreported.`);
          state.done = { pay_method: 'ZaloPay', credits: total, note: 'confirmed via vip_credit' };
          return;
        }
      }
      await api.reset('link expired — fetching a new code');
    } else {
      log(`    [i] ${left}s left — reloading the link to extend`);
      await api.reset('near expiry — extending now');
      await page.goto(dest);
      await waitForDomReady(page, { timeout: 40, settle: [2.0, 3.0] });
      await waitPageReady(page, { log, seconds: 45, shouldStop });
      nd = await grabQr(page, tab, { log, seconds: 60, shouldStop, wallet: state.wallet ?? wallet });
    }

    if (!nd.b64) {
      // Out of extension paths: open a new order for a different binding_token.
      log('    [i] reload produced no code — opening a new order');
      const [k2, got2] = await openNewQr(page, human, tab, netlogPath, { log, shouldStop, apiFirst, wallet });
      if (k2 !== 'done') {
        log(`    [!] could not open a new order (${got2})`);
        await api.fail(`could not get a new code: ${got2}`);
        return;
      }
      nd = got2.qr;
      state.url = got2.url;
      state.mark = got2.mark;
      state.cashier = got2.cashier ?? state.cashier ?? '';
      await api.setBinding(got2.url);
    }

    const same = qrFingerprint(nd.b64) === state.fp;
    state.fp = qrFingerprint(nd.b64);
    const fresh = String(nd.url || '');
    if (fresh.includes('binding_token=') && fresh !== state.url) {
      state.url = fresh;
      await api.setBinding(fresh);
    }
    saveQrPng(nd.b64, qrPng, { log });
    const secs = Math.trunc(qrTtl) || parseExpiresIn(nd.texts, ZALO_QR_TTL);
    // A finished reload is a fresh 15:00 — reset the mark so the next
    // extension counts from here.
    state.loadedAt = Date.now();
    state.ttl = secs;
    log(`    [ok] ${same ? 'extended the old code' : 'a new code'} — expires in ${secs}s (countdown: ${nd.countdown || 'not seen'})`);
    const label = walletInfo(state.wallet ?? wallet).label;
    await api.uploadPngB64(nd.b64, { expiresIn: secs, note: email ? `${label} | ${email}` : label });
  };

  let srv = null;
  if (serve) {
    let hint = '';
    for (const t of (d.texts || [])) {
      if (String(t).toLowerCase().includes('hết hạn')) { // page copy, stays Vietnamese
        hint = t;
        break;
      }
    }
    srv = new QrServer(png, { port: qrPort, deadlineText: hint });
    try {
      await srv.start(log);
    } catch (e) {
      log(`    [!] Could not start the QR server (${e && e.message ? e.message : e}) — use the file above.`);
      srv = null;
    }
  }

  log('[>] Waiting for you to scan the code with the ZaloPay app ...');
  let kind;
  let payload;
  try {
    [kind, payload] = await waitPaid(page, netlogPath, {
      log, seconds: waitSeconds, shouldStop, startLine: mark, state,
      onTick: api ? refreshQr : null,
      onLeft: api ? () => api.scanned('scanned in the ZaloPay app') : null,
    });
  } catch (e) {
    // The browser died mid-flow (closed, tab lost): the code would sit
    // 'pending' in the queue while someone scans a dead QR.
    if (api) await api.fail(`${e && e.constructor && e.constructor.name}: ${e && e.message ? e.message : e}`);
    throw e;
  } finally {
    if (srv) srv.stop();
    await closeHelperTab(page, log);
  }

  if (kind === 'done') {
    payload.qr_png = png;
    payload.pay_method = payload.pay_method || 'ZaloPay';
    // After a successful scan the ZaloPay page does NOT return to CapCut, so
    // the credits held are the ones read BEFORE the claim — missing the Pro
    // plan's vip_credit. Go read them again, and confirm Pro really is active.
    let daPro;
    let total;
    if (payload.credits) {
      daPro = Boolean(payload.vip_ok);
      total = payload.credits;
    } else {
      [daPro, total] = await proActive(page, { log });
      payload.credits = total;
      payload.vip_ok = daPro;
    }
    const grew = Boolean(total) && total > creditBefore;
    payload.credit_before = creditBefore;
    payload.credit_grew = grew;
    if (total) {
      log(`[ok] Credits after going Pro: ${creditBefore} -> ${total}${daPro ? '' : ' (no vip_credit seen yet)'}`);
    }
    // Only dare to call it a MISS when credits were READ. `total == 0` means
    // the read itself failed (helper-tab CDP error, network blip) — an account
    // that reached this step always has some credit, never a true zero.
    // Reporting a miss then throws away an account someone already scanned
    // and paid for.
    if (!total) {
      log('    [!] Could not read credits after going Pro — keeping the success result, re-check with kiem_pro.py.');
    } else if (!daPro && !grew) {
      // The wallet said done but CapCut added nothing: not Pro yet. Recording
      // Pro here would push a free account into the Pro list nobody rechecks.
      const reason = `credits on the dashboard did not rise (${creditBefore} -> ${total}) and no vip_credit`;
      log(`    [!] ${reason} — counting it as a MISS.`);
      if (api) await api.fail(reason);
      return ['stop', reason];
    }
    if (api) {
      await api.confirm({ chargeId: payload.charge_id || '', agreementId: payload.agreement_id || '' });
      payload.qr_user_id = api.userId;
    }
    return ['done', payload];
  }
  if (api) await api.fail(`${kind}: ${payload}`);
  return ['stop', `${kind}: ${payload}`];
}
