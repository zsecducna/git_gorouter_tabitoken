// Headless daily credit claimer — NO browser.
//
// Discovery 2026-09-02: the whole credit flow works from plain Node fetches:
// passport email/login answers unsigned, hands back the full cookie set
// (sessionid + msToken among 19), and the luckycat task APIs accept those
// cookies without any SDK signature. So the daily pass per account is ~25 API
// calls ≈ 10-15s, instead of a browser session with minutes of ceremony.
//
// Flow per account: login → task_list → for each unfinished task: do_action
// (report) + grant_reward (claim; Shark may deny — logged distinctly) →
// user_credit read (needs an app-page GET first from Node too — the commerce
// session initializes on first /my-edit hit) → DB + export updated.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const QS = 'aid=348188&account_sdk_source=web&sdk_version=2.1.10-tiktok&language=vi';
const LOGIN_URL = 'https://login-row.www.capcut.com/passport/web/email/login/?' + QS;
const INFO_URL = 'https://www.capcut.com/passport/web/account/info/?' + QS;
const APP_URL = 'https://www.capcut.com/my-edit';
const TASK_LIST_URL = 'https://edit-api-sg.capcut.com/luckycat/i18n/capcut/task/v1/task_list';
const DO_ACTION_URL = 'https://edit-api-sg.capcut.com/luckycat/i18n/capcut/task/v1/do_action';
const GRANT_REWARD_URL = 'https://edit-api-sg.capcut.com/luckycat/i18n/capcut/task/v1/grant_reward';
const CREDIT_URL = 'https://commerce-api-sg.capcut.com/commerce/v1/benefits/user_credit';

const STATUS_DONE = 4;
const SKIP_KEYS = new Set(['capcut_web_newbie_register']);
const ERR_SHARK_BLOCKED = 8001003;

// XOR each char with 0x05 then hex — passport's email/password encoding.
export const xorHex = (t) => [...t].map((c) => (c.codePointAt(0) ^ 5).toString(16).padStart(2, '0')).join('');

// op_id per the web's formula: {action_key}_{user_id}_{YYYY-MM-DD} local.
const makeOpId = (actionKey, userId) => `${actionKey}_${userId}_${new Date().toISOString().slice(0, 10)}`;

// Log in from Node, return the cookie header string. Throws with the server's
// description on anything but success (rate-limit error_code 7 included).
export async function nodeLogin(email, password) {
  const r = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA, origin: 'https://www.capcut.com', referer: 'https://www.capcut.com/',
    },
    body: 'email=' + xorHex(email) + '&password=' + xorHex(password) + '&mix_mode=1&email_active_status=0',
  });
  const j = await r.json().catch(() => null);
  const uid = j?.data?.user_id_str;
  if (!uid) {
    const desc = j?.data?.description || j?.message || ('HTTP ' + r.status);
    throw new Error('login failed: ' + desc);
  }
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  return { uid, cookie: cookies.join('; ') };
}

// Authenticated JSON POST with the browser-shaped headers Node needs.
async function post(cookie, url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'user-agent': UA,
      origin: 'https://www.capcut.com', referer: 'https://www.capcut.com/', cookie,
    },
    body: JSON.stringify(payload ?? {}),
  });
  return r.json().catch(() => ({}));
}

// Claim everything claimable for one account. `db` (optional) collects the
// cookie jar between calls; revisit is internal. Returns
// { uid, tasks, done, sharkBlocked, credit, total }.
// Claim with an EXISTING session (e.g. the register_verify_login response's
// cookies) — avoids a second login, which matters on shared proxy exits:
// the passport login endpoint rate-limits per IP ("too frequent") and the
// redundant call killed an otherwise-complete account (measured 2026-09-02).
export async function claimWithSession(uid, cookie, {
  log = () => {}, rounds = 1, gapSeconds = 45,
  grantedToday = null, recordGrant = null, concurrency = 5,
} = {}) {

  // Initialize the commerce session (same trick as the browser's app visit —
  // user_credit serves a decoy 0 envelope until /my-edit has been hit once).
  await fetch(APP_URL, { method: 'GET', headers: { 'user-agent': UA, cookie }, redirect: 'manual' }).catch(() => {});

  const list = await post(cookie, TASK_LIST_URL, { scene: 'capcut_web_task' });
  const tasks = list?.data?.task_list || [];
  if (!tasks.length) {
    log('no task list (not provisioned?)');
    return { uid, tasks: [], done: [], sharkBlocked: 0, credit: {}, total: 0 };
  }
  const todo = tasks.filter((t) => t.task_status !== STATUS_DONE && !SKIP_KEYS.has(t.task_key));
  log(`${tasks.length} tasks, ${todo.length} to claim`);

  const done = [];
  let grantSum = 0;
  let sharkBlocked = 0;

  // Small-concurrency map — the calls are independent (user: why not
  // parallel?). 5 keeps the burst browser-like instead of a 11-wide spike.
  const mapPool = async (items, worker) => {
    const out = [];
    for (let i = 0; i < items.length; i += concurrency) {
      out.push(...(await Promise.all(items.slice(i, i + concurrency).map(worker))));
    }
    return out;
  };
  // One do_action per task, then ROUNDS of grant_reward: task instances
  // complete asynchronously server-side ("no completed unrewarded instance
  // found", measured 2026-09-02) — the browser flow covered this with a slow
  // sweep; headless just re-grants after a short gap until the sum stops
  // growing (grantRounds caps the wait).
  await mapPool(todo, async (t) => {
    const rep = await post(cookie, DO_ACTION_URL, { action_key: t.task_key, op_id: makeOpId(t.task_key, uid) });
    if (rep.err_no && rep.err_no !== 0) {
      log(`  [i] ${t?.task_view?.title || t.task_key}: do_action err_no=${rep.err_no} ${(rep.err_tips || '').slice(0, 50)}`);
    }
  });
  for (const t of todo) done.push(t.task_key);
  // Grant targets: EVERY task with an id not yet in today's local ledger —
  // ripened-but-unrewarded tasks sit at status=4 and must not be skipped
  // (that gap left 9/11 rewards unclaimed, caught 2026-09-02).
  const grantedIds = new Set(grantedToday || []);
  const grantable = tasks.filter((t) => t.task_id != null && !grantedIds.has(t.task_id) && !SKIP_KEYS.has(t.task_key));
  // Grant rounds are ledger-idempotent: grant_reward re-acknowledges an
  // already-granted task with err_no=0 (measured live — a naive retry loop
  // double-counted +160/round), so only NEW ids count. Rounds chase the async
  // instance ripening ("no completed unrewarded instance"), which takes
  // minutes; `rounds`/`gapSeconds` tune patience (make-account uses 1 round
  // to stay fast; bin/claim.js harvests the rest later).
  const grantRound = async (roundNo) => {
    let gained = 0;
    await mapPool(grantable, async (t) => {
      if (grantedIds.has(t.task_id)) return;
      const title = t?.task_view?.title || t.task_key;
      const reward = t?.task_reward_view?.reward_amount || 0;
      const g = await post(cookie, GRANT_REWARD_URL, { task_id: t.task_id });
      if (g.err_no === ERR_SHARK_BLOCKED) {
        sharkBlocked++;
        grantedIds.add(t.task_id); // a Shark denial will not change on retry
        log(`  [!] ${title}: SHARK-BLOCKED`);
      } else if (g.err_no && g.err_no !== 0) {
        if (roundNo === 1) log(`  [.] ${title}: not complete yet (instance ripens async)`);
      } else {
        grantedIds.add(t.task_id);
        grantSum += reward;
        gained += reward;
        recordGrant?.(t.task_id, reward);
        log(`  [ok] +${reward} — ${title}`);
      }
    });
    return gained;
  };
  const maxRounds = Number(rounds ?? 1) || 1;
  const gapMs = (Number(gapSeconds ?? 45) || 45) * 1000;
  await grantRound(1);
  for (let r = 2; r <= maxRounds; r++) {
    await new Promise((res) => setTimeout(res, gapMs));
    const gained = await grantRound(r);
    if (!gained) { log(`  [i] grant round ${r}: no new grants — stopping`); break; }
  }

  // user_credit needs the SDK signature (Node gets a decoy "login error"
  // 0-envelope no matter the priming — measured 2026-09-02). The ledger truth
  // headless is the SUM OF SUCCESSFUL GRANTS: on the validated gmail account
  // every err_no=0 grant eventually landed (11 x rewards = exactly 1540).
  // `credit` stays empty from Node; `total` = sum of granted rewards.
  // Sum of NEW grants this pass (ledger already holds the history).
  log(`claimed-sum: ${grantSum}`);
  return { uid, tasks, done, sharkBlocked, credit: {}, total: grantSum };
}


// Login + claim (the standalone daily-harvest entry point).
export async function claimAll(email, password, opts = {}) {
  const { uid, cookie } = await nodeLogin(email, password);
  (opts.log || (() => {}))(`logged in user_id=${uid}`);
  return claimWithSession(uid, cookie, opts);
}
