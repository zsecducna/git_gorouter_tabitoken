// Client for the ZaloPay QR Queue Server (https://zalo-qr.onrender.com).
// Port of zaloqr_client.py (worker F). Uses native fetch — no HTTP library.
//
// The CapCut tool grabs the QR image from binding.zalopay.vn and pushes it
// here; the human scanner opens the queue on the server and scans top-down.
//
// Usage inside capcut-zalopay.claimTrialZalopay:
//
//     const api = new ZaloQRClient();
//     await api.register(email);                   // -> user_id
//     await api.setBinding(url);                   // binding URL, for cross-check
//     await api.uploadPngB64(b64, { expiresIn });  // push image, expiry from countdown
//     ...
//     await api.confirm({ chargeId, agreementId }); // or api.fail('...')
//
// Every call is SOFT: a network error never breaks the claim flow — it logs
// and returns false/null. The server has NO authentication; never send
// anything sensitive beyond the binding_url.

import { readFile } from 'node:fs/promises';

// Queue server base URL (override with the ZALOQR_HOST env var).
export const DEFAULT_HOST = process.env.ZALOQR_HOST ?? 'https://zalo-qr.onrender.com';

// The server may enable a write lock (its env var QR_TOKEN). When we have a
// token, every WRITE request must carry the header; reading the queue does
// not need it. (Python read ZALOQR_TOKEN on the client side.)
const DEFAULT_TOKEN = process.env.ZALOQR_TOKEN ?? '';

// Default lifetime of a ZaloPay code when the on-page countdown cannot be read.
const DEFAULT_EXPIRES_IN = 900;

// Largest image the server accepts. It also rejects under 100 bytes ("image
// too small"), requires a real PNG signature, and bumps expiry below 30s up
// to 30s. (Mirrors python; MIN_PNG_BYTES is kept for parity/documentation —
// the server enforces it, the client never needs to check.)
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MIN_PNG_BYTES = 100;

// Read the remaining seconds from text lines on the ZaloPay page.
//
// Catches `04:37`, `4 phút 37 giây`, `còn 5 phút`. Returns `defaultSeconds`
// when nothing matches — but a wrong guess misorders the queue, so always
// prefer feeding the real countdown text in here. (The patterns match
// Vietnamese page copy, so they stay Vietnamese.)
export function parseExpiresIn(texts, defaultSeconds = DEFAULT_EXPIRES_IN) {
  for (const t of texts || []) {
    const s = String(t);
    let m = /\b(\d{1,2}):([0-5]\d)\b/.exec(s);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    m = /(\d{1,3})\s*ph[uú]t(?:\s*(\d{1,2})\s*gi[aâ]y)?/i.exec(s);
    if (m) return Number(m[1]) * 60 + Number(m[2] || 0);
    m = /(\d{1,4})\s*gi[aâ]y/i.exec(s);
    if (m) return Number(m[1]);
  }
  return defaultSeconds;
}

// Accept bare base64 or a dataURL, return PNG bytes. Empty Buffer when the
// decode fails. (Node's base64 decoder never throws, unlike python's
// b64decode — undecodable input just yields an empty/short buffer, which the
// callers treat exactly like python's b''.)
export function pngBytes(data) {
  let s = String(data ?? '');
  const m = /^data:image\/\w+;base64,([\s\S]+)$/.exec(s);
  if (m) s = m[1];
  if (!s) return Buffer.alloc(0);
  return Buffer.from(s, 'base64');
}

// One slot in the scanner queue, tied to one CapCut account.
export class ZaloQRClient {
  // `host` defaults to DEFAULT_HOST; `timeout` is per-request seconds;
  // `token` overrides the ZALOQR_TOKEN env var (write-lock header).
  constructor(host = DEFAULT_HOST, { log = console.log, timeout = 30, token = null } = {}) {
    this.host = String(host || DEFAULT_HOST).replace(/\/+$/, '');
    this.token = String(token === null || token === undefined ? DEFAULT_TOKEN : (token || ''));
    this.log = log || (() => {});
    this.timeout = timeout;
    this.userId = '';
    this.email = '';
    this.bindingUrl = '';
    this.generation = 0;
    this.expiresAt = 0;
    this.lastStatus = 0;
  }

  // Call the API. Returns the parsed JSON object (or {} for non-JSON 2xx,
  // null on any failure) — never throws outward.
  // `json` sends a JSON body; `form` sends multipart form-data.
  async _call(method, path, { json, form } = {}) {
    const url = `${this.host}${path}`;
    const headers = {};
    if (this.token) headers['X-QR-Token'] = this.token;
    this.lastStatus = 0;
    let res;
    try {
      const init = { method, headers, signal: AbortSignal.timeout(this.timeout * 1000) };
      if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(json);
      } else if (form) {
        init.body = form; // fetch sets the multipart boundary itself
      }
      res = await fetch(url, init);
    } catch (e) {
      this.log(`    [!] QR API ${path}: ${e?.name || 'Error'}: ${e?.message || e}`);
      return null;
    }
    this.lastStatus = res.status;
    if (res.status >= 400) {
      let body = '';
      try { body = await res.text(); } catch { /* body read failed — status alone is enough */ }
      this.log(`    [!] QR API ${path}: HTTP ${res.status} ${body.slice(0, 160)}`);
      return null;
    }
    try {
      return await res.json();
    } catch {
      return {}; // 2xx with a non-JSON body — python: json() ValueError -> {}
    }
  }

  // Guard for endpoints that need a registered slot; logs and returns false
  // when register() has not run/succeeded yet.
  _needUser() {
    if (!this.userId) {
      this.log('    [!] QR API: not registered yet, skipping');
      return false;
    }
    return true;
  }

  // Liveness/status probe: `{status, timestamp, queue_size}` or null.
  async healthcheck() {
    return this._call('GET', '/healthcheck');
  }

  // Open a queue slot for `email`. Returns the user_id, '' on failure.
  async register(email) {
    const d = await this._call('POST', `/api/register/${email}`);
    if (!d || !d.user_id) return '';
    this.email = email;
    this.userId = d.user_id;
    this.log(`[ok] QR API: user_id=${this.userId} (${email})`);
    return this.userId;
  }

  // Store the ZaloPay binding URL for cross-checking. Not mandatory.
  async setBinding(bindingUrl) {
    if (!this._needUser() || !bindingUrl) return false;
    this.bindingUrl = bindingUrl;
    const d = await this._call('POST', `/api/set-binding/${this.userId}`, {
      json: { binding_url: bindingUrl },
    });
    return d !== null;
  }

  // Re-open the queue slot after the server forgot us.
  //
  // Server state lives in RAM (spilled to /tmp), so a Render redeploy or a
  // wake-from-sleep makes the old user_id vanish and every call return 404.
  // Re-register with the SAME email, then resend the binding_url. Returns
  // true when done.
  async _recover() {
    if (!this.email) return false;
    this.log('    [i] QR API: server forgot user_id — re-registering');
    const old = this.userId;
    this.userId = '';
    if (!(await this.register(this.email))) {
      this.userId = old;
      return false;
    }
    this.generation = 0;
    if (this.bindingUrl) {
      await this._call('POST', `/api/set-binding/${this.userId}`, {
        json: { binding_url: this.bindingUrl },
      });
    }
    return true;
  }

  // Push a QR image (multipart). `b64` is bare base64 OR a dataURL.
  //
  // `expiresIn` should be read from the on-page countdown — don't guess: an
  // off value misorders the queue. Returns true/false.
  async uploadPngB64(b64, { expiresIn = DEFAULT_EXPIRES_IN, note = '' } = {}) {
    if (!this._needUser()) return false;
    const raw = pngBytes(b64);
    if (!raw.length) {
      this.log('    [!] QR API: could not decode image');
      return false;
    }
    if (raw.length > MAX_PNG_BYTES) {
      this.log(`    [!] QR API: image ${raw.length} bytes > 2MB, server will reject it`);
      return false;
    }
    return this.uploadPngBytes(raw, { expiresIn, note });
  }

  // Push raw PNG bytes via multipart.
  async uploadPngBytes(raw, { expiresIn = DEFAULT_EXPIRES_IN, note = '' } = {}) {
    if (!this._needUser()) return false;
    const secs = Math.max(1, Math.trunc(Number(expiresIn) || DEFAULT_EXPIRES_IN));

    // Build the multipart body fresh per attempt — a FormData cannot be
    // reused after the first fetch consumed its stream.
    const send = () => {
      const form = new FormData();
      form.append('qr_image', new Blob([raw], { type: 'image/png' }), 'qr.png');
      form.append('expires_in', String(secs));
      form.append('note', String(note || ''));
      return this._call('POST', `/api/qr/${this.userId}/upload`, { form });
    };

    let d = await send();
    // 404 = the server forgot our user_id (restart/wake). Re-register then
    // send again, otherwise this code stays missing from the queue until it
    // expires.
    if (d === null && this.lastStatus === 404 && (await this._recover())) {
      d = await send();
    }
    if (d === null) return false;
    this.generation = Math.trunc(Number(d.generation)) || this.generation + 1;
    this.expiresAt = Math.trunc(Number(d.expires_at)) || (Date.now() / 1000 + secs);
    this.log(`[ok] QR uploaded to server: gen=${this.generation} ${Math.trunc(Number(d.remaining) || secs)}s left | ${this.host}/qr/${this.userId}`);
    return true;
  }

  // Push a PNG file already on disk.
  async uploadPngFile(filePath, { expiresIn = DEFAULT_EXPIRES_IN, note = '' } = {}) {
    let raw;
    try {
      raw = await readFile(filePath);
    } catch (e) {
      this.log(`    [!] QR API: cannot read ${filePath}: ${e?.message || e}`);
      return false;
    }
    return this.uploadPngBytes(raw, { expiresIn, note });
  }

  // JSON variant of the upload — for call sites where multipart is awkward.
  async uploadJson(b64, { expiresIn = DEFAULT_EXPIRES_IN } = {}) {
    if (!this._needUser()) return false;
    const raw = pngBytes(b64);
    if (!raw.length) return false;
    const secs = Math.max(1, Math.trunc(Number(expiresIn) || DEFAULT_EXPIRES_IN));
    const d = await this._call('POST', `/api/qr/${this.userId}/upload-json`, {
      json: { png_b64: raw.toString('base64'), expires_in: secs },
    });
    if (d === null) return false;
    this.generation = Math.trunc(Number(d.generation)) || this.generation + 1;
    this.expiresAt = Math.trunc(Number(d.expires_at)) || (Date.now() / 1000 + secs);
    return true;
  }

  // The sorted queue: closest to expiry first. Returns an array.
  async queue() {
    const d = (await this._call('GET', '/api/qr-queue')) || {};
    return d.items || [];
  }

  // The code that should be scanned next; null when the queue is empty
  // (server answers 404 -> _call null).
  async nextQr() {
    return this._call('GET', '/api/qr-queue/next');
  }

  // Our slot's status in the queue ('' when not present).
  async status() {
    for (const it of await this.queue()) {
      if (it.user_id === this.userId) return String(it.status || '');
    }
    return '';
  }

  // Seconds left according to the expiry the server recorded.
  remaining() {
    if (!this.expiresAt) return 0;
    return Math.max(0, Math.trunc(this.expiresAt - Date.now() / 1000));
  }

  // URL of the current QR PNG.
  qrUrl() {
    return this.userId ? `${this.host}/qr/${this.userId}` : '';
  }

  // Mark the slot `needs_new` — the client will fetch a fresh QR and upload
  // it again.
  async reset(reason = '') {
    if (!this._needUser()) return false;
    const d = await this._call('POST', `/api/qr/${this.userId}/reset`, {
      json: { reason: String(reason || '') },
    });
    return d !== null;
  }

  // Tell the server "the tool is still alive" while waiting for the scanner.
  //
  // Without the check-in the server treats the code as orphaned and drops it
  // from /api/qr-queue/next — the scanner then never wastes a scan on a code
  // nobody reads anymore (seen: 3 GPM tabs left hanging after the process
  // was killed).
  async alive() {
    if (!this.userId) return false;
    return (await this._call('POST', `/api/qr/${this.userId}/alive`)) !== null;
  }

  // Report "someone scanned this, waiting for CapCut to confirm".
  //
  // Call the moment the page leaves binding.zalopay.vn. The code leaves the
  // to-scan list (no double scans) but stays on the board for monitoring.
  async scanned(reason = '') {
    if (!this._needUser()) return false;
    const d = await this._call('POST', `/api/qr/${this.userId}/scanned`, {
      json: { reason: String(reason || '') },
    });
    return d !== null;
  }

  // Report the payment as completed.
  async confirm({ chargeId = '', agreementId = '', amount = 0, currency = 'VND' } = {}) {
    if (!this._needUser()) return false;
    const d = await this._call('POST', `/api/qr/${this.userId}/confirm`, {
      json: {
        charge_id: String(chargeId || ''),
        agreement_id: String(agreementId || ''),
        amount,
        currency,
      },
    });
    return d !== null;
  }

  // Report a failure / skip.
  async fail(reason = '', { chargeId = '', agreementId = '' } = {}) {
    if (!this._needUser()) return false;
    const d = await this._call('POST', `/api/qr/${this.userId}/fail`, {
      json: {
        reason: String(reason || ''),
        charge_id: String(chargeId || ''),
        agreement_id: String(agreementId || ''),
      },
    });
    return d !== null;
  }

  // Remove this slot from the queue.
  async delete() {
    if (!this.userId) return false;
    return (await this._call('DELETE', `/api/qr/${this.userId}`)) !== null;
  }
}
