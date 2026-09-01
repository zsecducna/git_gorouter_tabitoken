// Browserless signup — pure Node, no CloakBrowser.
//
// Every call here is proven to work without the page SDK (measured 2026-09-02):
// passport endpoints (check_email/send_code/register_verify_login) answer
// unsigned with cookie auth; luckycat task APIs accept the same cookies; okotp
// is plain REST. The SDK-signature-only endpoints (commerce user_credit, the
// /lv post-steps) are not needed for signup+claim — the ledger is the grant
// sum (see claim.js).
//
// Flow: prime cookies on the login page → check_email → send_code →
// wait OTP (okotp) → register_verify_login (creates the account + session) →
// claimAll for the 11 tasks. ~20 API calls + the OTP delivery wait.

import { xorHex, nodeLogin, claimAll } from './claim.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const QS = 'aid=348188&account_sdk_source=web&sdk_version=2.1.10-tiktok&language=vi';
const LOGIN_PAGE = 'https://www.capcut.com/vi-vn/login';
const CHECK_EMAIL_URL = 'https://login-row.www.capcut.com/passport/web/user/check_email_registered/?' + QS;
const SEND_CODE_URL = 'https://login-row.www.capcut.com/passport/web/email/send_code/?' + QS;
const REGISTER_URL = 'https://login-row.www.capcut.com/passport/web/email/register_verify_login/?' + QS;

// Browser-ish headers for passport form posts.
const formHeaders = (cookie) => ({
  'content-type': 'application/x-www-form-urlencoded',
  'user-agent': UA, origin: 'https://www.capcut.com', referer: 'https://www.capcut.com/',
  ...(cookie ? { cookie } : {}),
});

// Collect the server-set cookies from a plain GET of the login page (no JS
// runs — we only take what the server itself sets; passport issues msToken).
export async function primeCookies() {
  const r = await fetch(LOGIN_PAGE, { headers: { 'user-agent': UA }, redirect: 'manual' }).catch(() => null);
  if (!r) return '';
  return (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
}

// Is the email free? Returns true/false, null when the check itself failed.
export async function checkEmailFree(email, cookie) {
  const r = await fetch(CHECK_EMAIL_URL, {
    method: 'POST', headers: formHeaders(cookie),
    body: 'email=' + encodeURIComponent(email),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.message !== 'success') return null;
  return j?.data?.is_registered === 0;
}

// Send the verification code. Returns { ticket } | { error } — retried by the
// caller (python did ×3/3s).
export async function sendCode(email, password, cookie) {
  // Body EXACTLY as python/the web sends it: mix_mode=1 tells the server the
  // email/password are XOR-hex encoded — omitting it makes the hex string get
  // parsed as a literal address ("Lỗi địa chỉ email", hit live 2026-09-02).
  const r = await fetch(SEND_CODE_URL, {
    method: 'POST', headers: formHeaders(cookie),
    body: 'mix_mode=1&email=' + xorHex(email) + '&password=' + xorHex(password) + '&type=34&fixed_mix_mode=1',
  });
  const j = await r.json().catch(() => null);
  const ticket = j?.data?.email_ticket;
  if (j?.message === 'success' && ticket) return { ticket };
  return { error: (j?.data?.description || j?.message || 'HTTP ' + r.status) };
}

// Create the account with the OTP code. Birthday format: MM/DD/YYYY.
// Returns { uid, cookie } on success, { error } otherwise.
export async function register(email, password, code, birthday, cookie) {
  // Field-for-field python parity: xor'd email/code/password, birthday plain,
  // force_user_region + the pre-encoded empty biz_param, fixed_mix_mode=1.
  const r = await fetch(REGISTER_URL, {
    method: 'POST', headers: formHeaders(cookie),
    body: 'mix_mode=1&email=' + xorHex(email) + '&code=' + xorHex(code) + '&password=' + xorHex(password)
      + '&type=34&birthday=' + encodeURIComponent(birthday) + '&force_user_region=VN'
      + '&biz_param=%7B%22invite_code%22%3A%22%22%7D&fixed_mix_mode=1',
  });
  const j = await r.json().catch(() => null);
  const uid = j?.data?.user_id_str;
  if (j?.message === 'success' && uid) {
    const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
    return { uid, cookie: cookies.join('; ') };
  }
  return { error: (j?.data?.description || j?.message || 'HTTP ' + r.status) };
}

// Full browserless pipeline for one row. `mailbox` = okotp order mailbox
// ({ waitForCode, release }); settings supplies CAPCUT_REGION-agnostic bits.
// Returns the claimAll result (grant-sum ledger) or null on failure.
export async function signupAndClaim(email, password, mailbox, {
  log = () => {}, codeTimeout = 300, birthday = '06/02/1995', grantedToday = null, recordGrant = null,
} = {}) {
  const cookie = await primeCookies();
  const free = await checkEmailFree(email, cookie);
  if (free === false) { log('[!] email already registered'); return null; }

  let sent = null;
  for (let i = 0; i < 3 && !sent?.ticket; i++) {
    if (i) await new Promise((r) => setTimeout(r, 3000));
    sent = await sendCode(email, password, cookie);
    if (sent.error) log(`    [!] send_code try ${i + 1}: ${sent.error}`);
  }
  if (!sent?.ticket) { log('[!] could not send the code'); return null; }
  log(`    code sent (ticket ${String(sent.ticket).slice(0, 8)}...)`);

  const code = await mailbox.waitForCode({ timeout: codeTimeout, log: (m) => log('    ' + m) });
  if (!code) { log('[!] no OTP arrived in time'); return null; }
  log(`    code: ${code}`);

  const reg = await register(email, password, code, birthday, cookie);
  if (reg.error) { log(`[!] register failed: ${reg.error}`); return null; }
  log(`    created user_id=${reg.uid}`);

  // Claim with a fresh login session (register's session also works, but the
  // re-login keeps one code path with claim.js and costs one round-trip).
  const res = await claimAll(email, password, { log: (m) => log('    ' + m), grantedToday, recordGrant });
  return res;
}
