// config.example.js — configuration for the CapCut signup tool (Node port of
// capcut-tool). Copy to config.js and edit by hand; config.js is gitignored.
// Every key is a named UPPER_SNAKE export; the engine merges config with CLI
// overrides into the `settings` object every module receives.

// ---- Browser backend: CloakBrowser (stealth Chromium, Playwright API) ----
// One throwaway stealth profile per account (launchPersistentContext), deleted
// after the run when DELETE_PROFILE_AFTER=true. Replaced GPMLogin 2026-09-01.
export const HEADLESS = false;          // visible windows (anti-detect parity with the Python tool)
export const HUMANIZE = true;           // CloakBrowser built-in humanized input pacing
export const BROWSER_LOCALE = 'vi-VN';
export const BROWSER_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const PROFILE_ROOT = 'data/profiles'; // per-account profile dirs, relative to node/
export const RAW_PROXY = null;          // fallback proxy when a worker has none from PROXY_LIST

// ---- Mail source: own-domain IMAP catch-all (replaces okotp / tempmail) ----
// Why own domain — measured 04:02 2026-09-01: tempmail.lol signs accounts up
// fine (5/5, codes parsed 5/5, ~10 s/account) but CapCut BLOCKS CREDITS BY
// DOMAIN: all 5 accounts got 0 credits, 4 of them completed all 11 tasks and
// the server even recorded them as done — no credit landed. Tried 2 root
// domains (rainsase.com, foodhz.com), same result. OKOTP is pay-per-mailbox
// and 10/20 rented boxes arrived dead (measured 01:30 2026-09-01). An own
// domain nobody knows is on no block list.
// Mailboxes are READ here only; addresses are pre-provisioned in accounts.db
// (node bin/provision.js). The IMAP password NEVER goes in this file —
// put MAIL_PASS in the repo-root .env (loaded by src/util/util.js loadEnv()).
export const MAIL_PROVIDER = 'own';           // 'own' = own-domain IMAP catch-all (default) | 'okotp' = rent a paid gmail per account (see OTP_* below)
export const EMAIL_DOMAIN = 'thanhphuonglatoi.com'; // the only domain currently receiving mail (user-confirmed 2026-09-01)
export const MAIL_HOST = '';                  // '' = default 'mail.duke-kr.win' (measured working)
// Measured preflight 2026-09-01: ONLY me@duke-kr.win authenticates on that
// host — the naive 'me@<your-domain>' user fails auth (~8s per attempt). The
// catch-all still receives mail for every hosted domain; this user reads them all.
export const MAIL_CATCHALL_USER = 'me@duke-kr.win';
export const OTP_CODE_TIMEOUT = 300;          // seconds to wait for the 6-digit code

// ---- OKOTP paid gmail rental (only used when MAIL_PROVIDER='okotp') ----
// okotp.com RENTS a gmail per account (REAL MONEY per createOrder — measured
// 01:30 2026-09-01: 10/20 rented boxes arrived 'Email dead'; that is also why
// 'own' above is the default). Per signup the engine claims an order, the
// rented gmail REPLACES the row's placeholder email in accounts.db
// (setCapcutEmail), and the OTP code is read from okotp polling — never IMAP.
export const OTP_API_KEY = '';                      // okotp.com API key (REQUIRED in okotp mode)
export const OTP_BASE = 'https://api.okotp.com';    // API base (python okotp.py BASE_URL)
export const OTP_SERVICE_ID = '2070452724137512961';      // CapCut service in okotp's catalog
export const OTP_EMAIL_TYPE_ID = '2047660085469163521';  // mailbox type id (gmail) — see GET /api/prices

// ---- Account details ----
// Passwords live in the DB rows (provision.js generates them); this key is unused by the Node port (kept for python parity).
export const PASSWORD = ''; // unused — DB rows carry passwords (provision.js)
export const BIRTH_YEAR_MIN = 1988;
export const BIRTH_YEAR_MAX = 2003;
export const MARKETING_OPT_IN = true;

// ---- Signup page locale ----
export const CAPCUT_LOCALE = 'vi-vn';
// Login API host override ('' = built-in default https://login-row.www.capcut.com —
// the real flow always landed on login-row for VN).
export const CAPCUT_LOGIN_HOST = '';

// ---- Signup method ----
// 'api' = call CapCut's 4 APIs directly via in-page fetch (FAST).
// 'ui'  = type/click through the 9 screens like a human (slower, fallback
//         for when the APIs change).
export const SIGNUP_MODE = 'api';
// Post-steps in 'api' mode. If False: the two edit-api-sg APIs require a
// `sign` header a bare fetch cannot produce -> the account keeps the default
// workspace name.
export const API_DO_POST_STEPS = true;
export const CAPCUT_REGION = 'VN';

// ---- Auto-run credit tasks right after signup ----
// Only works with SIGNUP_MODE='api' (needs the page's SDK-loaded tab to sign
// requests).
export const DO_TASKS = true;
export const TASK_DELAY_MIN = 0.8;            // seconds, per-task delay range
export const TASK_DELAY_MAX = 1.6;

// ---- Claim the 7-day free Pro trial (0 VND) ----           [INACTIVE in step 1 — Pro flow is step 2]
// Cards are dealt one per account, in order. Out of cards -> later accounts
// are recorded as 'free'. WARNING: after 7 days it auto-charges 45,000 VND,
// then 222,000 VND/month.
export const DO_CLAIM_PRO = false;
// Payment wallet: 'momo', 'zalopay', 'momo,zalopay' (left-to-right priority)
// — all send a QR code to the queue server; 'card' = fill in a card form.
export const CLAIM_METHOD = 'zalopay';        // [INACTIVE in step 1]
export const ZALOQR_HOST = 'https://zalo-qr.onrender.com'; // [INACTIVE in step 1]
export const ZALOQR_WAIT = 900;               // [INACTIVE in step 1]
export const ZALOQR_REFRESH_BEFORE = 90;      // [INACTIVE in step 1]
export const ZALOQR_TTL = 0;                  // [INACTIVE in step 1]
export const PRO_CARDS = [];                  // [INACTIVE in step 1] list of card codes, one per account
export const PRO_CARD_REUSE = true;           // [INACTIVE in step 1]
export const PRO_CARD = '';                   // [INACTIVE in step 1]
export const PRO_CARD_HOLDER = '';            // [INACTIVE in step 1] name printed on the card

// ---- Fresh proxies continuously pulled from KiotProxy ----  [INACTIVE in step 1 — stub logs a notice, static PROXY_LIST is used]
// Each worker thread keeps its OWN key (one key holds one proxy at a time).
export const KIOT_ENABLED = true;             // [INACTIVE in step 1]
export const KIOT_KEYS = [];                  // [INACTIVE in step 1] one key per worker
export const KIOT_KEY = '';                   // [INACTIVE in step 1] single KiotProxy key (when not using KIOT_KEYS)
export const KIOT_REGION = 'bac';             // [INACTIVE in step 1]
export const KIOT_VERIFY = true;              // [INACTIVE in step 1]
export const KIOT_ATTEMPTS = 3;               // [INACTIVE in step 1]

// ---- Rotate proxy IP via ROTATION LINKS (one link per proxy) ---- [INACTIVE in step 1 — stub logs a notice]
export const ROTATE_PROXY = false;            // [INACTIVE in step 1]
export const ROTATE_LINKS = {};               // [INACTIVE in step 1] proxy -> rotation link
export const ROTATE_MIN_INTERVAL = 60;        // [INACTIVE in step 1] seconds between rotations of the same proxy
export const ROTATE_WAIT = 5;                 // [INACTIVE in step 1]
export const ROTATE_VERIFY = true;            // [INACTIVE in step 1]
export const ROTATE_VERIFY_TIMEOUT = 60;      // [INACTIVE in step 1]
export const ROTATE_METHOD = 'GET';           // [INACTIVE in step 1]
export const ROTATE_ON_FAIL_SKIP = false;     // [INACTIVE in step 1]

// ---- Concurrency ----
// Static proxies, one lane each (round-robin). Accepted formats per entry:
//   'ip:port'  |  'ip:port:user:pass'  |  'scheme://user:pass@ip:port'
// (parsed by src/util/proxy.js). Empty list = direct connection.
export const PROXY_LIST = [];
export const ACCOUNT_COUNT = 100;
export const THREAD_COUNT = 10;
export const DELETE_PROFILE_AFTER = true;
export const CLOSE_AFTER_DONE = true;

// ---- Results ----
// Pro and free accounts go to separate files; every account also goes to
// ACCOUNTS_FILE. Lines look like 'email|password|credits|plan'. The DB queue
// is the primary record — these files are export parity with the Python tool.
export const PRO_FILE = 'capcut_pro.txt';
export const FREE_FILE = 'capcut_free.txt';
export const ACCOUNTS_FILE = 'capcut_accounts.txt';

// ---- Account queue database ----
// Empty '' = default repo-root accounts.db (path resolved by src/infra/db.js).
// Set an absolute path only to point the tool at a different queue.
export const ACCOUNTS_DB = '';
