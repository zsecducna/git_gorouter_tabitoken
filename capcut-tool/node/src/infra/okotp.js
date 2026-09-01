// src/infra/okotp.js — client for OKOTP (okotp.com), a PAID gmail-rental
// service used to receive verification codes when MAIL_PROVIDER='okotp'.
// Faithful Node port of okotp.py (same endpoints, envelope semantics, code
// shapes, poll cadence and error taxonomy). Import-safe: nothing runs at
// import time; every method is explicit.
//
// Response envelope everywhere: {"code":0,"message":"success","data":...}
//   code == 0 -> SUCCESS (NOTE: different from GPM's "success": true)
//   code != 0 -> error, "message" explains (e.g. 525 "Invalid order item
//                signature", 603 "Sell stock insufficient").
//
// Usage for one signup (the engine's rentOkotpGmail does exactly this):
//   const otp = new OkotpClient(apiKey);
//   await otp.balance();                                     // free read
//   const order = await otp.createOrder({serviceId, emailTypeId}); // RENT
//   order.email;                                             // rented gmail
//   await otp.waitForCode(order, {timeout: 300});            // poll the code
//
// WARNING: createOrder SPENDS REAL MONEY (creates a real order, debits the
// balance). balance/services/price only read. Verification and tests must
// NEVER call createOrder against the live API — stub fetch instead.

import { sleep } from '../util/util.js';

// Default API base (python BASE_URL).
export const DEFAULT_BASE_URL = 'https://api.okotp.com';
// serviceId of GitHub in okotp's catalog (see GET /api/services) — kept from
// the python source for parity; the CapCut signup passes OTP_SERVICE_ID from
// config instead (serviceId 2070452724137512961, "Pippit Ai / capcut.com").
export const GITHUB_SERVICE_ID = '2047674598180433921';
// Default emailTypeId (mailbox type) — see GET /api/prices for the price.
export const DEFAULT_EMAIL_TYPE_ID = '2047660085469163521';

/**
 * The rented mailbox is DEAD — the service answered 'Email dead'. Mail will
 * NEVER arrive. Deliberately NOT a subclass of OkotpError so callers can tell
 * "no mail YET" (OkotpError, keep waiting) from "no mail EVER" (rent a fresh
 * box immediately — more waiting is wasted money).
 */
export class OkotpDead extends Error {
  constructor(message) {
    super(message);
    this.name = 'OkotpDead';
  }
}

/**
 * OKOTP API error: envelope code != 0, a non-JSON body, or a network failure
 * (python OKOTPError extends RuntimeError -> plain Error here).
 */
export class OkotpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OkotpError';
  }
}

// ---------------------------------------------------------------------------
// Extracting the verification code from a /api/order/code payload (the
// response shape has varied before — scan several shapes, python extract_code)
// ---------------------------------------------------------------------------

// Field NAMES that suggest the field holds the code itself.
const CODE_KEYS = new Set([
  'code', 'parsedcode', 'verifycode', 'verificationcode', 'otp', 'captcha', 'vcode',
]);
// Field NAMES that hold raw mail CONTENT — these get the regex scan; other
// string fields are NEVER scanned so ids/counts/expiry-years cannot be picked
// up as codes by accident.
const CONTENT_KEYS = new Set(['content', 'body', 'text', 'html', 'message', 'mail', 'raw']);

// True when the value looks like a typical 4-8 digit OTP.
function looksLikeCode(v) {
  return /^\d{4,8}$/.test(String(v).trim());
}

// Scan mail content: prefer an exact 8-digit code (GitHub), then 6, then any
// 4-8 digit run (python _code_from_content).
function codeFromContent(text) {
  const s = String(text);
  for (const pat of [/\b\d{8}\b/, /\b\d{6}\b/, /\b\d{4,8}\b/]) {
    const m = s.match(pat);
    if (m) return m[0];
  }
  return null;
}

// Pick the best code from candidates: exact 8 digits first (GitHub), then 6,
// then the longest (first occurrence wins ties — python max(key=len)).
function pickBest(cands) {
  if (!cands || !cands.length) return null;
  for (const n of [8, 6]) {
    for (const c of cands) {
      if (c.length === n) return c;
    }
  }
  return cands.reduce((best, c) => (c.length > best.length ? c : best));
}

// Collect values of fields NAMED like a code (code/verifyCode/...). Recurses
// everywhere: the code may sit nested under items[0].parsedCode etc.
function collectKeyed(node, out) {
  if (Array.isArray(node)) {
    for (const it of node) collectKeyed(it, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (CODE_KEYS.has(String(k).toLowerCase()) && looksLikeCode(v)) {
        out.push(String(v).trim());
      } else {
        collectKeyed(v, out);
      }
    }
  }
}

// Regex-scan fields that hold mail CONTENT (content/body/html/...). Returns
// the first code found (codeFromContent already prefers 8 -> 6 -> 4 digits).
// Other string fields are skipped on purpose (python _scan_content note:
// scanning them would pick up dates/timestamps).
function scanContent(node) {
  if (typeof node === 'string') return codeFromContent(node);
  if (Array.isArray(node)) {
    for (const it of node) {
      const got = scanContent(it);
      if (got) return got;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (CONTENT_KEYS.has(String(k).toLowerCase()) && typeof v === 'string') {
        const got = codeFromContent(v);
        if (got) return got;
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') {
        const got = scanContent(v);
        if (got) return got;
      }
    }
    return null;
  }
  return null;
}

// Collect EVERY value that looks like a code, regardless of field name —
// last-resort pass only (python _collect_any).
function collectAny(node, out) {
  if (node !== null && typeof node === 'object') {
    if (Array.isArray(node)) {
      for (const it of node) collectAny(it, out);
    } else {
      for (const v of Object.values(node)) collectAny(v, out);
    }
    return;
  }
  if (looksLikeCode(node)) out.push(String(node).trim());
}

/**
 * Find the verification code inside a /api/order/code `data` payload (any of
 * the shapes the service has returned so far). Returns the code string, or
 * null when no code has arrived yet. Priority order (so garbage numbers —
 * ids, counters, expiry years — never win over a real code in the mail body):
 *   1) fields NAMED like a code (code/verifyCode/...), exact 8 digits first;
 *   2) mail CONTENT fields (content/body/html/...) — 8 -> 6 -> 4 digits;
 *   3) last resort: any 4-8 digit value anywhere, exact 8 digits first.
 * Port of python extract_code.
 */
export function extractCode(data) {
  const keyed = [];
  collectKeyed(data, keyed);
  const best = pickBest(keyed);
  if (best) return best;

  const fromContent = scanContent(data);
  if (fromContent) return fromContent;

  const anyc = [];
  collectAny(data, anyc);
  return pickBest(anyc);
}

/**
 * Pull the `sign` query parameter out of the /api/order/code link returned at
 * order-creation time. Uses raw percent-decoding (decodeURIComponent) ON
 * PURPOSE: URLSearchParams would additionally turn '+' into a space and
 * corrupt base64 signatures containing '+', which the server answers with
 * 525 "Invalid order item signature" (python hit exactly that; keep the fix).
 */
export function signFromLink(link) {
  const m = /[?&]sign=([^&]*)/.exec(String(link || ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1]; // malformed escape — hand the raw value over, the server judges
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * OKOTP API client (python OKOTPClient). Plain GET with query parameters —
 * no auth header, the apiKey rides as a query param. Every method returns the
 * envelope's `data` and throws OkotpError on code != 0, non-JSON bodies, or
 * network failures. `timeout` is SECONDS (python parity; converted to ms for
 * fetch). `log` is an optional progress logger (default: silent).
 */
export class OkotpClient {
  constructor(apiKey, { baseUrl = DEFAULT_BASE_URL, timeout = 30, log = () => {} } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = timeout;
    this.log = log;
  }

  // Low-level GET -> parsed envelope. Throws ONLY on network error or a
  // non-JSON body (python _request); an envelope code != 0 is raised later
  // by _ok so wait loops can inspect the message. Null/undefined params are
  // dropped (python filtered None out of the query string).
  async _request(path, params = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(this.timeout * 1000) });
    } catch (e) {
      throw new OkotpError(
        `Cannot reach the OKOTP API at ${this.base}: ${e && e.message ? e.message : e}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new OkotpError(`Response is not JSON (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  // Envelope check (python _ok): return `data`, or throw OkotpError with the
  // envelope's message when code != 0.
  _ok(env) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
      throw new OkotpError(`Strange response: ${JSON.stringify(env)}`);
    }
    if (env.code !== 0) {
      throw new OkotpError(String(env.message || `code=${env.code}`));
    }
    return env.data;
  }

  // True when the API + apiKey are alive (probes via balance). Soft check:
  // any OkotpError maps to false; anything else still throws.
  async ping() {
    try {
      await this.balance();
      return true;
    } catch (e) {
      if (e instanceof OkotpError) return false;
      throw e;
    }
  }

  // Remaining account balance (free read; envelope data, usually a number).
  async balance() {
    return this._ok(await this._request('/api/balance', { apiKey: this.apiKey }));
  }

  // Supported service catalog (list of objects; free read — python sent no
  // params here, so neither does this port).
  async services() {
    return this._ok(await this._request('/api/services'));
  }

  // Current price for (service, mailbox type). Free read; returns a number
  // or null when the catalog answers with neither a known list nor object
  // shape.
  async price(serviceId = GITHUB_SERVICE_ID, emailTypeId = DEFAULT_EMAIL_TYPE_ID) {
    const data = this._ok(await this._request('/api/prices', {
      apiKey: this.apiKey,
      serviceId,
      emailTypeId,
    }));
    if (Array.isArray(data) && data.length) {
      const first = data[0];
      const p = first && typeof first === 'object' ? first.price : undefined;
      return p === undefined ? null : p;
    }
    if (data && typeof data === 'object') {
      return data.price === undefined ? null : data.price;
    }
    return null;
  }

  // RENT a mailbox — COSTS REAL MONEY (a real order, debits the balance).
  // Returns the FIRST mailbox item {orderItemId, email, link, sign} with
  // `sign` already parsed out of `link`. Throws when the order comes back
  // without mailboxes or without orderItemId/sign (python create_order).
  async createOrder({ serviceId = GITHUB_SERVICE_ID, emailTypeId = DEFAULT_EMAIL_TYPE_ID,
    quantity = 1, withPassword = false } = {}) {
    const data = this._ok(await this._request('/api/order/create', {
      apiKey: this.apiKey,
      serviceId,
      emailTypeId,
      quantity,
      format: 'json',
      withPassword: String(Boolean(withPassword)), // 'true'/'false', python parity
    })) || {};
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      throw new OkotpError('Order created but no mailbox came back.');
    }
    const raw = items[0];
    const item = raw && typeof raw === 'object' ? { ...raw } : {};
    item.sign = signFromLink(item.link || '');
    if (!item.orderItemId || !item.sign) {
      throw new OkotpError(`Missing orderItemId/sign in the order: ${JSON.stringify(item)}`);
    }
    return item;
  }

  // Fetch the mail/code of ONE order. parseCode=true lets the service parse
  // the code itself. Returns the raw `data` (shape varies; extractCode makes
  // sense of it); throws OkotpError when the envelope code != 0. lookBackHours
  // null = omitted from the query (python passed None the same way).
  async getCode(orderItemId, sign, { parseCode = true, limit = 1, lookBackHours = null } = {}) {
    return this._ok(await this._request('/api/order/code', {
      orderItemId,
      sign,
      parseCode: String(Boolean(parseCode)), // 'true'/'false', python parity
      limit,
      lookBackHours,
    }));
  }

  /**
   * Poll until the code arrives, the budget runs out, or shouldStop fires.
   * `order` is what createOrder returned (needs orderItemId + sign). Returns
   * the code string or null; THROWS OkotpDead when the service declares the
   * mailbox dead/expired/cancelled (waiting longer is wasted money) and
   * RETHROWS signature errors (configuration problem, not "no mail yet").
   *
   * Poll cadence EASES IN (python note kept): CapCut mail usually lands after
   * 10-25 s, so a flat 5 s interval wastes ~2.5 s per account on average.
   * Start dense (1 s) and stretch by 0.5 s per round up to `interval` so the
   * API is not hammered.
   */
  async waitForCode(order, { timeout = 300, interval = 5, log = null, shouldStop = null } = {}) {
    const say = log || this.log || (() => {});
    const stop = shouldStop || (() => false);
    const oid = order && order.orderItemId;
    const sign = order && order.sign;
    const deadline = Date.now() + timeout * 1000;
    let lastMsg = null;
    let round = 0; // python `lan` — drives the poll easing
    while (Date.now() < deadline) {
      if (stop()) return null;
      try {
        const data = await this.getCode(oid, sign, { parseCode: true, limit: 1 });
        const code = extractCode(data);
        if (code) return code;
      } catch (e) {
        if (!(e instanceof OkotpError)) throw e;
        const msg = String(e.message || e);
        // A bad signature is a CONFIG error — abort immediately; every other
        // error counts as "no mail yet".
        if (msg.toLowerCase().includes('signature')) throw e;
        // 'Email dead' is the service's FINAL verdict, not "not yet". It used
        // to fall into the keep-waiting branch and the tool sat the full 300 s
        // on a dead box — measured on the 01:30 batch of 2026-09-01: 7/10
        // accounts missed because of exactly this, each wasting 5 minutes and
        // a batch slot.
        const low = msg.toLowerCase();
        if (low.includes('dead') || low.includes('expired') || low.includes('cancel')) {
          throw new OkotpDead(msg);
        }
        if (msg !== lastMsg) {
          say(`    [i] OKOTP: ${msg} — still waiting ...`);
          lastMsg = msg;
        }
      }
      await sleep(Math.min(interval, 1.0 + 0.5 * round) * 1000);
      round += 1;
    }
    return null;
  }
}

/**
 * Adapt one rented order into the engine's mailbox seam (the mail.js shape
 * {waitForCode, release}) so signupViaApi / stepVerifyCode consume it without
 * knowing the provider. waitForCode's args and result map 1:1 onto
 * OkotpClient.waitForCode — EXCEPT it can throw OkotpDead (mail.js's IMAP
 * reader never throws; a dead RENTED box must fail the account fast instead
 * of burning the rest of the OTP budget). release() only marks the order used
 * in the log: okotp exposes no order-close endpoint (python had none either);
 * the mailbox simply expires service-side.
 */
export function makeOrderMailbox(client, order, { log = () => {} } = {}) {
  return {
    async waitForCode({ timeout = 300, interval = 5, log: waitLog = log, shouldStop = null } = {}) {
      return client.waitForCode(order, { timeout, interval, log: waitLog, shouldStop });
    },
    async release() {
      log(`    [i] OKOTP order ${order && order.orderItemId} marked used (mailbox expires service-side).`);
    },
  };
}
