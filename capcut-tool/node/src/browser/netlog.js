// netlog — port of netlog.py: record capcut.com network traffic to .jsonl.
//
// Watch capcut.com requests over CDP — to find ways to sign up via API
// instead of clicking through the UI step by step.
//
// Two ways to use it:
//
// 1) Record while the engine runs by itself (the engine wires it in, see
//    signupOne({netlogPath})):
//
//       node capcut-signup.js --netlog net.jsonl
//
// 2) Watch MANUALLY: open a GPM profile, you click around in the browser
//    yourself, everything is recorded:
//
//       node netlog.js                       # -> netlog/capcut-<timestamp>.jsonl
//       node netlog.js --out out.jsonl       # name the file
//       node netlog.js --all                 # also record img/css/font (skipped by default)
//       node netlog.js --seconds 600         # auto-stop after 10 minutes
//
// Then summarize the .jsonl:
//
//       node netlog.js --summary net.jsonl
//       node netlog.js --summary net.jsonl --show-body   # with payloads/bodies
//
// Each .jsonl line is an independent record, so the file can be inspected
// while recording is still running, and a file cut mid-line still yields
// every record before the cut.
//
// WARNING: the .jsonl file contains FULL headers (including cookies,
// Authorization) and request/response bodies — that is enough to impersonate
// the whole login session. Do NOT share it.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Static-asset file extensions — skipped by default: they are >90% of all
// requests and irrelevant to the signup flow.
export const STATIC_EXT = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.css', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.m4s',
  '.webm', '.avif',
];

// Resource types (CDP-style, capitalized as CDP reports them) skipped unless
// --all / includeStatic is set.
export const STATIC_TYPES = new Set(['Image', 'Font', 'Stylesheet', 'Media', 'Manifest', 'Other']);

// Truncate request/response bodies so the file stays small.
export const MAX_BODY = 20000;

// Playwright reports resourceType in lowercase; CDP (and therefore the python
// .jsonl records) capitalize them. Map back for byte-format parity.
const TYPE_MAP = {
  document: 'Document', stylesheet: 'Stylesheet', image: 'Image', font: 'Font',
  script: 'Script', xhr: 'XHR', fetch: 'Fetch', preflight: 'Preflight',
  eventsource: 'EventSource', websocket: 'WebSocket', manifest: 'Manifest',
  signedexchange: 'SignedExchange', ping: 'Ping',
  cspviolationreport: 'CSPViolationReport', other: 'Other',
};

// Static-asset filter: by resource type first, then by file extension of the
// URL path (query string stripped).
export function isStatic(url, rtype) {
  if (STATIC_TYPES.has(rtype)) return true;
  const p = (url || '').split('?', 1)[0].toLowerCase();
  return STATIC_EXT.some((e) => p.endsWith(e));
}

// Map a Playwright resourceType to the CDP-cased spelling the python records
// use ("xhr" -> "XHR"); unknown values pass through unchanged.
function cdpType(rtype) {
  return TYPE_MAP[rtype] || rtype || '';
}

// Module-global request id counter: Playwright does not expose CDP
// requestIds, so each Request object gets a stable synthetic id at first
// sight; records for the same request share it (python used the raw CDP id).
let nextReqId = 0;

// One .jsonl file SHARED by many tabs/pages.
// Kept separate from NetworkRecorder because the task / payment flows open
// extra tabs and popups: each tab gets its own recorder but all must write to
// the SAME file so replaying in chronological order works. Writes are
// serialized through a promise chain (python used a threading.Lock for the
// same guarantee against pychrome background threads).
export class JsonlWriter {
  // `path` is the .jsonl target; opens lazily via open().
  constructor(filePath) {
    if (!filePath) throw new Error('JsonlWriter: a file path is required');
    this.path = filePath;
    this.count = 0;
    this._fh = null;
    this._chain = Promise.resolve();
  }

  // Create the parent directory and open the file in append mode.
  // Idempotent (safe to call again after close for a new recording session).
  async open() {
    const dir = path.dirname(path.resolve(this.path));
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    if (this._fh == null) this._fh = await fsp.open(this.path, 'a');
    return this;
  }

  // Append one record as a single json line; stamps `t` (epoch seconds, 3
  // decimals) exactly like the python writer. Flushes (each append is its own
  // write) so the file is readable while recording runs. Never throws — a
  // recorder must not die on IO errors.
  write(rec) {
    rec.t = Math.round(Date.now()) / 1000;
    const line = JSON.stringify(rec) + '\n';
    this._chain = this._chain.then(async () => {
      if (this._fh == null) return; // closed -> drop late records
      try {
        await this._fh.write(line);
        this.count += 1;
      } catch { /* swallow: never fatal */ }
    });
    return this._chain;
  }

  // Flush and close the file; further write() calls are dropped.
  async close() {
    await this._chain;
    const fh = this._fh;
    this._fh = null;
    if (fh) {
      try { await fh.close(); } catch { /* already closed */ }
    }
  }
}

// Attach to a Playwright CONTEXT or PAGE and record every request to .jsonl.
// Can run alongside the engine: the engine keeps driving the page normally,
// the recorder only listens to network events and never touches the page.
//
// Records come in 3 `kind`s (same schema as python):
//   request  — url, method, headers, postData
//   response — status, headers, mime
//   body     — response body (only for API-ish JSON/text, static files skipped)
//
// `writer`: share one JsonlWriter when recording many tabs into one file.
// Leave null to own an exclusive writer on `outPath` (the engine's classic
// usage). `tabLabel`: short label so records reveal their source tab.
export class NetworkRecorder {
  // `target` must be a Playwright page or browser context (both emit
  // request/response/requestfinished). `fetchBodies=false` records only the
  // request/response headers trail (python parity).
  constructor({ target, outPath = null, includeStatic = false, fetchBodies = true, writer = null, tabLabel = '', log = console.log }) {
    if (!target || typeof target.on !== 'function') {
      throw new Error('NetworkRecorder: target must be a Playwright page or context');
    }
    if (!writer && !outPath) {
      throw new Error('NetworkRecorder: outPath is required when no shared writer is given');
    }
    this.target = target;
    this.log = log;
    this.includeStatic = includeStatic;
    this.fetchBodies = fetchBodies;
    this.tabLabel = tabLabel;
    this._ownWriter = writer == null;
    this._w = writer || new JsonlWriter(outPath);
    this.outPath = this._w.path;
    this._pending = new Map(); // reqId -> {url, type}
    this._reqIds = new WeakMap(); // Request object -> synthetic reqId
    this._inflight = new Set(); // pending body-fetch promises (drained on stop)
    this._started = false;
    this._handlers = [
      ['request', (req) => this._onRequest(req)],
      ['response', (resp) => this._onResponse(resp)],
      // Body fetch is async (response.body()); track it so stop() can drain
      // the last in-flight bodies before the writer closes — python could
      // drop a final record the same way when a listener fired late.
      ['requestfinished', (req) => {
        const p = this._onFinished(req).catch(() => {});
        this._inflight.add(p);
        p.then(() => this._inflight.delete(p), () => this._inflight.delete(p));
      }],
      // python had no loadingFailed handler (failed requests leaked their
      // pending entry); cleaning up here is a tiny fix with no format impact.
      ['requestfailed', (req) => this._onFailed(req)],
    ];
  }

  // Number of records written so far (shared across recorders on one writer).
  get count() {
    return this._w.count;
  }

  // Open the own writer (if any) and attach the event listeners. Idempotent —
  // a second start() is a no-op (Playwright .on() would double-register).
  async start() {
    if (this._started) return this;
    if (this._ownWriter) await this._w.open();
    for (const [ev, handler] of this._handlers) this.target.on(ev, handler);
    this._started = true;
    if (this._ownWriter) this.log(`[i] Recording network to: ${this.outPath}`);
    return this;
  }

  // Detach listeners first, then close the own writer (if any). Listeners are
  // removed BEFORE the file closes: a late event writing into a closed file
  // would blow up, python had the same ordering rule.
  async stop() {
    if (!this._started) return;
    this._started = false;
    for (const [ev, handler] of this._handlers) {
      try { this.target.off(ev, handler); } catch { /* target already gone */ }
    }
    // Give in-flight body fetches up to 2s to land before closing the file.
    await Promise.race([Promise.allSettled([...this._inflight]), new Promise((r) => setTimeout(r, 2000))]);
    if (this._ownWriter) {
      await this._w.close();
      this.log(`[i] Recorded ${this._w.count} network records -> ${this.outPath}`);
    }
  }

  // Convenience alias for stop() so callers can always `finally { await rec.close(); }`.
  async close() {
    await this.stop();
  }

  // Stamp the tab label (when set) and hand the record to the writer.
  _write(rec) {
    if (this.tabLabel) rec.tab = this.tabLabel;
    return this._w.write(rec);
  }

  // Assign (once) the synthetic request id shared by this request's
  // request/response/body records.
  _reqId(request) {
    let id = this._reqIds.get(request);
    if (id == null) {
      id = String(++nextReqId);
      this._reqIds.set(request, id);
    }
    return id;
  }

  // 'request' listener — record method/url/headers/postData and remember the
  // request for the later body fetch. Fully synchronous up to the queued
  // write so the id exists before any response event can arrive. Never
  // throws into the browser event dispatch.
  _onRequest(request) {
    try {
      const url = request.url() || '';
      if (!url.startsWith('http://') && !url.startsWith('https://')) return;
      const rtype = cdpType(request.resourceType());
      if (!this.includeStatic && isStatic(url, rtype)) return;
      const id = this._reqId(request);
      this._pending.set(id, { url, type: rtype });
      const body = request.postData();
      this._write({
        kind: 'request',
        id,
        type: rtype,
        method: request.method(),
        url,
        headers: request.headers() || {},
        postData: typeof body === 'string' ? body.slice(0, MAX_BODY) : null,
      });
    } catch { /* listener must never throw */ }
  }

  // 'response' listener — record status/url/mime/headers. Static and
  // non-http responses are filtered exactly like the request side.
  _onResponse(response) {
    try {
      const url = response.url() || '';
      if (!url.startsWith('http://') && !url.startsWith('https://')) return;
      const rtype = cdpType(response.request().resourceType());
      if (!this.includeStatic && isStatic(url, rtype)) return;
      const headers = response.headers() || {};
      this._write({
        kind: 'response',
        id: this._reqIds.get(response.request()) ?? null,
        type: rtype,
        status: response.status(),
        url,
        mime: headers['content-type'] ?? null,
        headers,
      });
    } catch { /* listener must never throw */ }
  }

  // 'requestfinished' listener — opportunistically fetch the response body
  // for XHR/Fetch/Document requests (that is where the API JSON lives).
  // Body fetch is best-effort and NEVER fatal: buffers can already be freed
  // or the page closing. Text bodies are stored as-is; non-UTF8 buffers are
  // stored base64-encoded with base64:true (mirrors CDP base64Encoded).
  async _onFinished(request) {
    if (!this.fetchBodies) return;
    try {
      const id = this._reqIds.get(request);
      if (id == null) return;
      const info = this._pending.get(id);
      this._pending.delete(id);
      if (!info) return;
      if (!['XHR', 'Fetch', 'Document'].includes(info.type)) return;
      const response = request.response();
      if (!response) return;
      const buf = await response.body(); // throws when evicted/closing — fine
      const text = buf.toString('utf8');
      const isText = Buffer.compare(Buffer.from(text, 'utf8'), buf) === 0;
      this._write({
        kind: 'body',
        id,
        url: info.url,
        base64: !isText,
        body: (isText ? text : buf.toString('base64')).slice(0, MAX_BODY),
      });
    } catch { /* body already freed or tab closing — never fatal */ }
  }

  // 'requestfailed' listener — just drop the pending entry (no record; python
  // recorded nothing for failed loads either).
  _onFailed(request) {
    try {
      const id = this._reqIds.get(request);
      if (id != null) this._pending.delete(id);
    } catch { /* never fatal */ }
  }
}

// ---------------------------------------------------------------------------
// Manual watch mode
// ---------------------------------------------------------------------------

// Open a GPM profile and record network traffic until Ctrl+C (or `seconds`
// elapses). You drive the browser yourself — this tool automates NOTHING, it
// only listens.
//
// NEW TABS AND POPUPS ARE CAPTURED TOO: the task / Pro-payment flows always
// open extra windows (payment gateway, 3-D Secure). Every new page gets its
// own recorder writing to the SAME file, labeled `tab` so you can tell them
// apart. Without this you lose exactly the most interesting part.
//
// `keepProfile=true`: keep the profile after stopping (so the next session is
// still logged in).
//
// NOTE: python's --email/--password pre-login shortcut is NOT ported yet — it
// needs the capcut-api login internals (`_form_post` + LOGIN_HOST constants)
// which are not part of src/core/capcut-api.js' step-1 contract export. Log in by
// hand in the Chrome window for now.
export async function watch(outPath, { seconds = 0, includeStatic = false, profile = null, startUrl = null, keepProfile = false, log = null } = {}) {
  // Lazy imports: keeps this module import-safe, mirrors python's in-function
  // imports, and tolerates sibling modules still landing from other agents.
  const { ts, sleep } = await import('../util/util.js');
  const browserMod = await import('./browser.js');
  let cfg;
  try {
    cfg = await import('../../config.js');
  } catch {
    throw new Error('config.js not found — copy config.example.js to node/config.js first');
  }
  // Uppercase keys only, like python's vars(config) upper filter.
  const settings = {};
  for (const k of Object.keys(cfg)) if (/^[A-Z][A-Z0-9_]*$/.test(k)) settings[k] = cfg[k];
  const profileName = profile || 'capcut-netlog';
  settings.RAW_PROXY = settings.RAW_PROXY ?? null; // manual watching: machine/proxy as configured
  settings.ROTATE_PROXY = false; // manual watching: don't burn proxy-rotation quota
  if (keepProfile) settings.DELETE_PROFILE_AFTER = false; // --keep-profile: stay logged in next session

  const say = log || ((m) => console.log(`[${ts()}] ${m}`));

  const writer = await new JsonlWriter(outPath).open();
  say(`[i] Recording network to: ${outPath}`);

  const recs = [];
  let handle = null;
  let interrupted = false;
  // First Ctrl+C stops gracefully; a second one force-exits (python just
  // crashed with a traceback mid-cleanup on a second Ctrl+C).
  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    say('[i] Ctrl+C received — stopping recording.');
  };
  process.on('SIGINT', onSigint);
  try {
    handle = await browserMod.openBrowser(settings, { name: profileName, log: say });
    const mainRec = new NetworkRecorder({ target: handle.page, log: say, includeStatic, writer, tabLabel: 'main' });
    await mainRec.start();
    recs.push(mainRec);

    const locale = settings.CAPCUT_LOCALE || 'vi-vn';

    const url = startUrl || `https://www.capcut.com/${locale}/login`;
    say(`[>] Opening ${url}`);
    await handle.page.goto(url);
    await browserMod.waitForDomReady(handle.page, { timeout: 30, settle: [1.0, 1.5] });

    // New-tab watcher. Python polled browser.list_tab() every 1.5s; Playwright
    // gives us push events instead: every existing context (plus any context
    // created later) emits 'page' for each new tab/popup — same coverage,
    // no polling.
    let extraTabs = 0;
    const onPage = async (page) => {
      if (handle && page === handle.page) return; // main tab has its recorder
      const u = page.url() || '';
      if (u.startsWith('devtools://')) return;
      extraTabs += 1;
      const label = `tab${extraTabs}`;
      try {
        const rec = new NetworkRecorder({ target: page, log: say, includeStatic, writer, tabLabel: label });
        await rec.start();
        recs.push(rec);
        say(`[i] Attached to new tab (${label}): ${u.slice(0, 90) || '(empty)'}`);
      } catch (e) {
        say(`[i] Could not attach to new tab: ${e.constructor.name}: ${e.message}`);
      }
    };
    for (const ctx of handle.browser.contexts()) ctx.on('page', onPage);
    handle.browser.on('context', (ctx) => ctx.on('page', onPage));

    say('='.repeat(68));
    say(' NOW WORK IN THE CHROME WINDOW YOURSELF:');
    say('   - do tasks, collect rewards');
    say('   - buy the Pro plan (payment)');
    say(' Every request is recorded, including new tabs/popups.');
    say(' When done press Ctrl+C here to stop.');
    say('='.repeat(68));

    const deadline = seconds ? Date.now() + seconds * 1000 : 0;
    let lastReport = Date.now();
    for (;;) {
      await sleep(1000);
      if (interrupted) break;
      // Progress heartbeat every 30s so you know it is still recording.
      if (Date.now() - lastReport >= 30000) {
        lastReport = Date.now();
        say(`[i] Recorded ${writer.count} records (${recs.length} tabs being watched) ...`);
      }
      if (deadline && Date.now() >= deadline) {
        say(`[i] ${seconds}s elapsed — stopping recording.`);
        break;
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    for (const rec of recs) {
      try { await rec.stop(); } catch { /* best-effort */ }
    }
    const n = writer.count;
    await writer.close();
    say(`[i] Total ${n} records -> ${outPath}`);
    if (handle) {
      // Closing wipes the profile dir unless --keep-profile set
      // DELETE_PROFILE_AFTER=false above; keeping it means the next session
      // is still logged in.
      try {
        await handle.close();
        if (keepProfile) say(`[i] Browser closed, profile KEPT: ${handle.profileDir}`);
      } catch (e) {
        say(`[!] Could not close browser: ${e.message}`);
      }
    }
  }
  return outPath;
}

// ---------------------------------------------------------------------------
// .jsonl summary
// ---------------------------------------------------------------------------

// Print a summary of the recorded APIs in chronological order. Malformed
// lines (a crash mid-write cuts the last line) are skipped, so partial files
// still summarize. `only` filters URLs by case-insensitive substring.
export async function summarize(path_, { showBody = false, only = null } = {}) {
  if (!fs.existsSync(path_)) throw new Error(`No such file: ${path_}`);
  const { readLines } = await import('../util/util.js');

  const reqs = new Map(), resps = new Map(), bodies = new Map();
  const order = [];
  for (const raw of await readLines(path_)) {
    const line = raw.trim();
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // last line cut mid-write
    }
    const rid = r.id, kind = r.kind;
    if (kind === 'request') {
      reqs.set(rid, r);
      order.push(rid);
    } else if (kind === 'response') {
      resps.set(rid, r);
    } else if (kind === 'body') {
      bodies.set(rid, r);
    }
  }

  const onlyLc = only ? only.toLowerCase() : null;
  console.log(`=== ${path_} — ${order.length} request ===\n`);
  let shown = 0;
  for (const rid of order) {
    const rq = reqs.get(rid) || {};
    const url = rq.url || '';
    if (onlyLc && !url.toLowerCase().includes(onlyLc)) continue;
    const rs = resps.get(rid) || {};
    shown += 1;
    const status = rs.status;
    console.log(`[${String(shown).padStart(3)}] ${(rq.method || '?').padEnd(6)} ${status || '   '} ${url}`);

    // Headers worth grabbing when replaying a request from code.
    const hdr = {};
    for (const [k, v] of Object.entries(rq.headers || {})) hdr[k.toLowerCase()] = v;
    for (const k of ['authorization', 'cookie', 'x-tt-token', 'content-type', 'x-secsdk-csrf-token', 'device-time', 'sign']) {
      if (k in hdr) {
        const v = String(hdr[k]);
        console.log(`       ${k}: ${v.slice(0, 120)}${v.length > 120 ? '...' : ''}`);
      }
    }

    if (showBody) {
      const pd = rq.postData;
      if (pd) console.log(`       -> payload: ${pd.slice(0, 600)}`);
      const bd = (bodies.get(rid) || {}).body;
      if (bd) console.log(`       <- body   : ${bd.slice(0, 600)}`);
    }
    console.log();
  }

  if (!shown) {
    console.log('(no matching requests)');
    return;
  }

  // Group by endpoint to quickly spot the core APIs.
  console.log('=== Grouped by endpoint ===');
  const counts = new Map();
  for (const rid of order) {
    const u = (reqs.get(rid) || {}).url || '';
    if (onlyLc && !u.toLowerCase().includes(onlyLc)) continue;
    const base = u.split('?', 1)[0];
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  for (const [u, n] of entries) console.log(`  ${String(n).padStart(3)}x  ${u}`);
}
