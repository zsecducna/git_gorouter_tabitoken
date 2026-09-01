// AUTO-COMPLETE CAPCUT WEB TASKS — claim free credits via API, no UI clicks.
// Port of capcut_tasks.py; every measured-behavior note from the Python file
// is kept (translated) — it is the real documentation of these endpoints.
//
// Why it works: the /luckycat/... group demands the `sign` + `device-time`
// headers and the `X-Bogus`/`X-Gnarly`/`msToken` query params. They cannot be
// computed locally (probing failed), BUT the page SDK hooks `fetch`, so
// calling fetch INSIDE a capcut.com tab makes the browser add the full
// signature itself — the same trick capcut-api.js uses for /passport/....
//
//   *** NEVER add X-Bogus / X-Gnarly / msToken / device-time / sign headers ***
//   *** by hand. The hooked fetch adds them itself; hand-adding them BREAKS  ***
//   *** the signature (measured).                                           ***
//
// Verified by a real experiment on a logged-in account: task_list returned 12
// tasks, do_action returned err_no=0.
//
// API chain (extracted from the netlog of one successful manual task run):
//     POST /luckycat/i18n/capcut/task/v1/task_list   {"scene":"capcut_web_task"}
//     POST /luckycat/i18n/capcut/task/v1/do_action   {"action_key":..,"op_id":..}
//     POST /commerce/v1/benefits/user_credit         {"aid":348188}   (read credit)
//
// `op_id` follows the web's exact formula: {action_key}_{user_id}_{YYYY-MM-DD}.
// The server is idempotent per op_id: replaying the same op_id returns err_no
// 8001001 "duplicate action op_id" — harmless, so re-running never
// double-credits.
//
// There is NO separate "claim reward" API: credit is granted immediately
// after do_action.

import { StopRequested, checkStop, waitForDomReady } from '../browser/browser.js';
import { randFloat, sleep, todayStr } from '../util/util.js';

const AID = 348188;

const LUCKYCAT = 'https://edit-api-sg.capcut.com/luckycat/i18n/capcut';
const TASK_LIST_URL = `${LUCKYCAT}/task/v1/task_list`;
const DO_ACTION_URL = `${LUCKYCAT}/task/v1/do_action`;
const CAMPAIGN_RES_URL = `${LUCKYCAT}/campaign/v1/capcut/web/resource`;
const CREDIT_URL = 'https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit';
const ACCOUNT_INFO_URL = 'https://www.capcut.com/passport/web/account/info/';

// The app page: opening it makes CapCut build the workspace for a new account.
export const APP_URL = 'https://www.capcut.com/my-edit';

const TASK_SCENE = 'capcut_web_task';

// task_status: 4 = done (read from real data). Any other status counts as
// unfinished and gets a do_action attempt.
export const STATUS_DONE = 4;

// Tasks auto-completed at signup — no do_action call needed for them.
export const SKIP_KEYS = new Set(['capcut_web_newbie_register']);

// Known err_no of do_action: 8001001 = "duplicate action op_id" (idempotent
// replay — the task was already counted, so treat it as success).
export const ERR_DUPLICATE = 8001001;

// Race page.evaluate against a hard timeout — parity with pychrome's
// Runtime.evaluate `_timeout=60` (playwright's evaluate has no per-call
// timeout). 60s, not 30s: with 10 worker threads the in-page call sometimes
// runs past 30s while a tab is busy (measured batch 00:55 2026-09-01: 7
// overruns across 48 accounts). (Duplicated in capcut-api.js on purpose: no
// shared contract slot.)
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

// Call fetch inside the page so the SDK signs it; `credentials:'include'`
// carries the session cookie. NEVER add the signature by hand — hand-adding
// only breaks it. Response body truncated to 1200 chars (as Python).
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

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

// user_id_str of the logged-in account ('' when not logged in).
export async function getUserId(page) {
  const r = await postJson(page, ACCOUNT_INFO_URL, {});
  const d = ((r.json || {}).data) || {};
  return String(d.user_id_str || d.user_id || '');
}

// Read the credit map {vip_credit, gift_credit, purchase_credit, ...}.
// The API wraps the real JSON in a `response` STRING field — a plain `data`
// field also exists in parallel; use `data` for brevity, fall back to parsing
// `response` only when `data` is missing.
// Session nuance (measured 2026-09-02): right after login the commerce API
// answers `ret:34010105 "login error"` with a DECOY 0-credit body — the
// commerce session only becomes valid after the page has visited an app page
// (/my-edit). On that error shape, visit the app once and re-read; never
// trust the decoy zeros.
export async function getCredit(page) {
  const readOnce = async () => {
    const r = await postJson(page, CREDIT_URL, { aid: AID });
    return r.json || {};
  };
  let j = await readOnce();
  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const parse = (jj) => {
    let d = jj.data;
    if (!isObj(d) && typeof jj.response === 'string') {
      try { d = JSON.parse(jj.response); } catch { d = null; }
    }
    return isObj(d) && isObj(d.credit) ? d.credit : null;
  };
  let credit = parse(j);
  if (credit) return credit;
  if (String(j.ret ?? '0') !== '0' || j.errmsg === 'login error') {
    // decoy envelope — initialize the commerce session, then re-read once
    try {
      await page.goto(APP_URL, { timeout: 90000 });
      await waitForDomReady(page, { settle: [1.5, 2.5] });
      j = await readOnce();
      credit = parse(j);
    } catch { /* navigation failed — fall through */ }
  }
  return credit || {};
}

// Total spendable credit — sum integer-valued fields, skip everything else.
export function creditTotal(credit) {
  return Object.values(credit || {}).reduce((s, v) => (Number.isInteger(v) ? s + v : s), 0);
}

// List the tasks of scene `capcut_web_task`. Each element keeps the API's raw
// shape: task_key, task_status, task_reward_view.reward_amount,
// task_view.title, task_relation, ... Returns [] on any API error.
export async function listTasks(page) {
  const r = await postJson(page, TASK_LIST_URL, { scene: TASK_SCENE });
  const j = r.json || {};
  if (j.err_no) return [];
  return ((j.data || {}).task_list) || [];
}

// Call the campaign resource — the real page calls it right before showing
// the task popup. Not required to earn rewards, but call it to mirror the
// real flow (and to read the total credit CapCut is currently offering).
export async function taskPopup(page) {
  const r = await postJson(page, CAMPAIGN_RES_URL, { resource_scene: TASK_SCENE });
  return (r.json || {}).data || {};
}

// ---------------------------------------------------------------------------
// Doing tasks
// ---------------------------------------------------------------------------

// Build the op_id with the web's exact formula:
// {action_key}_{user_id}_{YYYY-MM-DD} (local date).
export function makeOpId(actionKey, userId, day = null) {
  return `${actionKey}_${userId}_${day || todayStr()}`;
}

// Report one task as completed. Returns [ok, errNo, errTips].
// ok is true even when errNo === ERR_DUPLICATE: an already-used op_id means
// the task was already counted — not an error that needs handling.
export async function doAction(page, actionKey, userId, day = null) {
  const opId = makeOpId(actionKey, userId, day);
  const r = await postJson(page, DO_ACTION_URL, { action_key: actionKey, op_id: opId });
  const j = r.json || {};
  const errNo = j.err_no;
  const errTips = j.err_tips || '';
  if ((errNo === 0 || errNo == null) && r.ok) return [true, 0, ''];
  if (errNo === ERR_DUPLICATE) return [true, errNo, errTips];
  if (!r.ok) return [false, errNo, errTips || `HTTP ${r.status} ${String(r.text ?? '').slice(0, 160)}`];
  return [false, errNo, errTips];
}

// NEW step in the credit flow (discovered live 2026-09-02): CapCut split the
// credit grant out of do_action into a separate grant_reward call, gated by
// ByteDance's Shark risk engine. Observed on a real account: the task panel
// offers 1380 credits, do_action returns err_no=0 — but no credit moves until
// grant_reward is called, and Shark can deny it:
//   err_no 8001003 "[CapcutCreditGranter.CheckShark] check shark blocked"
// (toast: "you do not qualify for this reward yet"). When that happens the
// ACCOUNT failed risk screening — not a flow bug. task_id is the NUMERIC id
// from task_list entries (e.g. 100004), not the action_key.
export const ERR_SHARK_BLOCKED = 8001003;
const GRANT_REWARD_URL = `${LUCKYCAT}/task/v1/grant_reward`;

// Claim one task's credit reward. Returns [granted, errNo, errTips].
export async function grantReward(page, taskId) {
  const r = await postJson(page, GRANT_REWARD_URL, { task_id: taskId });
  const j = r.json || {};
  const errNo = j.err_no;
  const errTips = j.err_tips || '';
  const toast = ((j.data || {}).toast) || '';
  if ((errNo === 0 || errNo == null) && r.ok) return [true, 0, ''];
  return [false, errNo, toast || errTips];
}

// (was `cho_san_sang` — "wait until ripe".)
// Wait until CapCut has finished provisioning benefits for the new account.
// Not just re-asking the API: if the first ask comes back empty, OPEN THE APP
// (/my-edit) and then keep waiting. Measured: polling alone for 60s ripens
// only 1/18 accounts; the rest get 0 credit because their task list does not
// exist yet. Returns {tasks, credit}; empty tasks = timed out still unripe.
// `readyAfterSeconds` (0 = off, legacy behavior): once the task LIST exists,
// leave after this many extra seconds even with 0 credit — in the 2026-09
// grant_reward flow the ledger only moves AFTER the task actions, so waiting
// for credit>0 here just burns the full timeout (CAPCUT_FAST cuts ~110s/run).
export async function waitForReady(page, { log = console.log, shouldStop = null, seconds = 150, pulse = 5.0, readyAfterSeconds = 0 } = {}) {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  let tasks = [];
  let credit = {};
  let pulseNo = 0;
  let visitedApp = false;
  let firstSeenTasks = 0;
  while (true) {
    checkStop(shouldStop);
    tasks = (await listTasks(page)) || [];
    credit = (await getCredit(page)) || {};
    if (tasks.length && !firstSeenTasks) firstSeenTasks = Date.now();
    if (tasks.length && creditTotal(credit) > 0) {
      if (pulseNo) {
        log(`    [i] account ready after ${pulseNo} wait pulse(s)${visitedApp ? ' (after visiting the app)' : ''}.`);
      }
      return { tasks, credit };
    }
    if (
      readyAfterSeconds > 0 && firstSeenTasks && Date.now() - firstSeenTasks >= readyAfterSeconds * 1000
      && visitedApp
    ) {
      log(`    [i] task list ready ${readyAfterSeconds}s (credit lands after the actions now) — proceeding.`);
      return { tasks, credit };
    }
    if (Date.now() >= deadline) return { tasks, credit };

    if (!pulseNo) log('    [i] CapCut has not finished granting benefits — opening the app, then waiting ...');
    // Visit the app so CapCut builds the workspace. Redo every 4th pulse: a
    // single visit can land while the session is not ready yet.
    if (pulseNo % 4 === 0) {
      try {
        await page.goto(APP_URL, { timeout: 90000 });
        await waitForDomReady(page, { timeout: 40, settle: [2.0, 3.0] });
        visitedApp = true;
      } catch (e) {
        log(`    [i] could not open the app: ${e?.name || 'Error'}`);
      }
    }
    pulseNo += 1;
    await sleep(pulse * 1000);
  }
}

// (was `run_all`.)
// Complete ALL unfinished tasks for the currently logged-in account.
// `page` must be a tab already on capcut.com WITH the SDK loaded (call
// warmUp from capcut-api.js first) — otherwise requests go out unsigned.
// `retries` = number of extra SWEEP passes for tasks that failed round one.
// Returns {ok, done: [actionKey...], failed: [[key, errNo, tips], ...],
//          creditBefore: {}, creditAfter: {}, gained: int}.
export async function runAll(page, {
  log = console.log, shouldStop = null, userId = null,
  delayMin = 0.8, delayMax = 1.6, recheck = true, retries = 2, readySeconds = 150, readyAfterSeconds = 0,
} = {}) {
  const retriesN = Math.trunc(Number(retries) || 0); // int() parity for config strings
  const out = { ok: false, done: [], failed: [], creditBefore: {}, creditAfter: {}, gained: 0 };

  const uid = userId || (await getUserId(page));
  if (!uid) {
    log('[!] Not logged in (could not read user_id) — skipping tasks.');
    // Still read the existing credit: the caller stores `creditAfter` into
    // the accounts file — leaving it empty would write 0 for an account that
    // is actually holding 520.
    out.creditAfter = await getCredit(page);
    return out;
  }
  log(`[i] Running tasks for user_id=${uid}`);

  const { tasks, credit: before } = await waitForReady(page, {
    log, shouldStop, seconds: Math.trunc(Number(readySeconds) || 0), readyAfterSeconds: Math.trunc(Number(readyAfterSeconds) || 0),
  });
  out.creditBefore = before;
  log(`[i] Credit before: ${JSON.stringify(before)} (total ${creditTotal(before)})`);

  if (!tasks.length) {
    log('[!] Could not read the task list.');
    out.creditAfter = before;
    return out;
  }

  const todo = tasks.filter((t) => t.task_status !== STATUS_DONE && !SKIP_KEYS.has(t.task_key));
  log(`[i] ${tasks.length} tasks, ${todo.length} to do.`);

  const day = todayStr(); // op_id embeds the date — the web's own formula

  // Do one task. Returns true when it earned credit.
  const attempt = async (t, passNo) => {
    const key = t.task_key || '';
    const reward = ((t.task_reward_view || {}).reward_amount) || 0;
    const title = ((t.task_view || {}).title) || key;
    let res;
    try {
      res = await doAction(page, key, uid, day);
    } catch (e) {
      if (e instanceof StopRequested) throw e;
      // TRANSPORT error (CDP `Runtime.evaluate timeout` under many threads, a
      // busy tab) — NOT a CapCut rejection. It used to escape run_all and
      // abandon the WHOLE account at 520 credit — measured batch 00:55
      // 2026-09-01: 5/43 accounts stopped at 520 for exactly this reason.
      // Treat it as a failed task so the SWEEP pass below retries it.
      log(`    [!] ${title}: ${e?.name || 'Error'} — leaving it for the sweep pass`);
      return false;
    }
    const [ok, errNo, tips] = res;
    if (ok) {
      const note = errNo === ERR_DUPLICATE ? ' (already counted)' : '';
      const pass = passNo > 1 ? ` [pass ${passNo}]` : '';
      log(`    [ok] +${reward} — ${title}${note}${pass}`);
      out.done.push(key);
      // Claim the credit (2026-09-02 flow: do_action only REPORTS the action;
      // the grant is a separate, Shark-gated call). Only when the list entry
      // carries a numeric task_id; absent id = older flow, credit follows the
      // report directly.
      const taskId = t.task_id;
      if (taskId != null) {
        try {
          const [granted, gErrNo, gTips] = await grantReward(page, taskId);
          if (granted) {
            // err_no=0 from grant_reward is an ACK, not proof: measured
            // 2026-09-02, accounts with two acknowledged grants still read
            // 0 credit 10+ min later. The ledger re-read is the only truth.
            log(`        [i] grant_reward acknowledged (task_id ${taskId}) — ledger re-read will confirm`);
          } else if (gErrNo === ERR_SHARK_BLOCKED) {
            log(`        [!] SHARK-BLOCKED (task_id ${taskId}): ByteDance risk engine denied the credit — account/IP failed screening`);
          } else if (gErrNo === 0 || gErrNo == null) {
            log(`        [i] reward not claimable yet (task_id ${taskId}): ${gTips}`);
          } else {
            log(`        [!] grant_reward err_no=${gErrNo}: ${gTips}`);
          }
        } catch (e) {
          if (e instanceof StopRequested) throw e;
          log(`        [!] grant_reward transport error (${e?.name || 'Error'}) — leaving it for the sweep pass`);
        }
      }
      return true;
    }
    log(`    [!] ${title}: err_no=${errNo} ${tips}`);
    return false;
  };

  let remaining = [];
  for (const t of todo) {
    checkStop(shouldStop);
    if (!(await attempt(t, 1))) remaining.push(t);
    await sleep(randFloat(delayMin, delayMax) * 1000);
  }

  // Sweep pass: a network hiccup or a mid-run proxy switch drops a few tasks;
  // skipping them leaves the account stuck at 520 credit over a transient
  // error. Retry up to `retries` extra passes with growing pauses.
  for (let passNo = 2; passNo < Math.max(2, retriesN + 2); passNo++) {
    if (!remaining.length) break;
    checkStop(shouldStop);
    log(`[i] Retrying ${remaining.length} failed task(s) (pass ${passNo}) ...`);
    await sleep(2000 * (passNo - 1));
    const stillFailed = [];
    for (const t of remaining) {
      checkStop(shouldStop);
      if (!(await attempt(t, passNo))) stillFailed.push(t);
      await sleep(randFloat(delayMin, delayMax) * 1000);
    }
    remaining = stillFailed;
  }

  for (const t of remaining) {
    out.failed.push([t.task_key || '', null, 'failed after all retry passes']);
  }

  if (recheck) {
    // The server does not credit completely instantly; wait briefly, re-read.
    await sleep(2000);
    let after = await getCredit(page);
    // Reading 0 while credit existed BEFORE is a missed read, not lost
    // credit — really hit at 05:25 2026-08-31: "total 0 | gained -1540".
    // Trusting that number writes 0 to file for an account holding 1540.
    for (let i = 0; i < 3; i++) {
      if (creditTotal(after) || !creditTotal(before)) break;
      log('    [i] credit read as 0 although it was non-zero before — re-reading in 3s');
      await sleep(3000);
      after = await getCredit(page);
    }
    if (!creditTotal(after) && creditTotal(before)) {
      log('    [!] still cannot read credit — keeping the previous number.');
      after = before;
    }
    out.creditAfter = after;
    out.gained = creditTotal(after) - creditTotal(before);
    log(`[i] Credit after: ${JSON.stringify(after)} (total ${creditTotal(after)}) | gained ${out.gained}`);

    // Re-read the task list ONLY to REPORT. The tasks are done and the credit
    // was read above; letting one missed read throw away the freshly earned
    // result is not acceptable.
    try {
      const left = (await listTasks(page))
        .filter((t) => t.task_status !== STATUS_DONE && !SKIP_KEYS.has(t.task_key))
        .map((t) => t.task_key);
      if (left.length) log(`[i] Not done yet: ${left.join(', ')}`);
      else log('[i] All tasks done.');
    } catch (e) {
      if (e instanceof StopRequested) throw e;
      log(`    [i] could not re-read the task list (${e?.name || 'Error'}) — keeping the results above.`);
    }
  }

  out.ok = out.failed.length === 0;
  return out;
}
