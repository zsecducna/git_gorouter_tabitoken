// UPGRADE FREE ACCOUNTS TO PRO — Node port of len_pro.py (step 2 final wiring).
//
// Log back into registered `free` accounts and claim the 7-day Pro trial on
// each. Run AFTER a signup batch finishes. Python read its targets from the
// free-accounts text file (doc_nick); this port is DB-DRIVEN: targets are
// accounts.db rows with status 'registered' whose plan column is not 'pro'
// (listCapcutUpgradeTargets), and success writes capcut='pro' back via
// updateCapcutCredits. The DB is the primary record; the python
// `email|password|credits|plan` export line in ACCOUNTS_FILE is ALSO rewritten
// in place when that file exists (chuyen_sang_pro / ghi_ket_qua parity).
//
// Why this exists (python docstring): a `free` nick is not a broken nick.
// Most of them just had nobody scanning the QR during the batch, or the scan
// came after expiry — the account still works, only the last step is missing.
// Logging back in and claiming again works; the nick must not be thrown away.
//
// EVERY ACCOUNT NEEDS ONE SCAN (QR wallets): open the scan board BEFORE
// running, and remember the worker count = how many codes sit waiting for a
// scan at the same time.
//
// This module also owns the REAL claim implementation the signup engine
// delegates to (capcut-engine.js claimProIfEnabled -> claimPro here) — the
// step-1 stub's replacement. Import direction is engine -> upgrade-pro only,
// never back, so no cycle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StopRequested, defaultShouldStop, openBrowser, closeBrowser,
} from '../browser/browser.js';
import { HumanInput } from '../browser/human-input.js';
import { NetworkRecorder } from '../browser/netlog.js';
import { warmUp } from './capcut-api.js';
import { login } from './capcut-login.js';
import { getCredit, creditTotal } from './capcut-tasks.js';
import { claimTrial, cardFromSettings } from './capcut-pro.js';
import { claimTrialZalopay, walletList } from './capcut-zalopay.js';
import { DEFAULT_HOST } from '../infra/zaloqr-client.js';
import { updateCapcutCredits } from '../infra/db.js';
import { normalizeAccountsLine, FULL_CREDIT_TARGET } from './redo-tasks.js';
import { makeMutex, readLines, sleep } from '../util/util.js';

// Credit an account holds when ALL 11 tasks are done (python DU_NHIEM_VU) —
// re-exported from redo-tasks so CLIs import the whole step-2 surface from
// one module.
export { FULL_CREDIT_TARGET };

// node/ package root (config file values are relative to it, like python's
// script-dir-relative netlog dir). This file is node/src/core/upgrade-pro.js.
const NODE_ROOT = path.dirname(fileURLToPath(new URL('../../', import.meta.url)));

// Netlog directory (python THU_MUC_NETLOG = BASE/netlog; here under node/data/
// per the repo layout). One .jsonl PER ACCOUNT: the claim functions read this
// file back for `cashier_url` and to verify the amount due is 0 — share one
// path across workers and the next worker reads the previous worker's order.
const NETLOG_DIR = path.join(NODE_ROOT, 'data', 'netlog');

// Serializes export-file rewrites across concurrent workers (python
// _khoa_file threading.Lock). Re-read from disk inside the lock every time —
// holding an in-memory copy would overwrite another worker's change.
const FILE_MUTEX = makeMutex();

// ----------------------------------------------------------------------------
// The real Pro claim (python capcut_engine.claim_pro_if_enabled body)
// ----------------------------------------------------------------------------

// Claim the 7-day 0-VND Pro trial, wallet or card path chosen by
// CLAIM_METHOD. Returns the success payload object, or null when not claimed.
// Claim errors never throw outward (except StopRequested): the account and
// its credits already exist — losing them over a claim hiccup is worse than
// staying free (python parity).
//
// Guards (DO_CLAIM_PRO / SIGNUP_MODE='api' / netlog present) live in the
// engine's claimProIfEnabled — python checked them there too; len_pro always
// satisfied them (DO_CLAIM_PRO forced on, netlog always recorded).
export async function claimPro(page, human, tab, settings, netlogPath,
  log = console.log, shouldStop = null, email = '') {
  const method = String(settings.CLAIM_METHOD || 'zalopay').toLowerCase();
  // Every method OTHER than 'card' is a scan-the-QR wallet: 'momo',
  // 'zalopay', or the priority list 'momo,zalopay'. Enumerating names one by
  // one would go stale the moment a new wallet is added (python note).
  if (method !== 'card') {
    return claimProWallet(page, human, tab, settings, netlogPath, email, log, shouldStop);
  }
  return claimProCard(page, human, tab, settings, netlogPath, log, shouldStop);
}

// Wallet path (python _claim_pro_zalopay): push the QR to the queue server
// and wait for a human to scan it. Unlike the card path the money does not
// deduct itself — someone must hold a phone to the code. Each account holds
// its own slot in the queue (keyed by email), so parallel runs leave several
// codes waiting with near-expiry ones floated to the top.
async function claimProWallet(page, human, tab, settings, netlogPath, email, log, shouldStop) {
  const host = String(settings.ZALOQR_HOST || '') || DEFAULT_HOST;
  // The QR image rides along with THIS account's netlog (python: splitext):
  // share one path across workers and the next worker overwrites the previous
  // worker's image.
  const qrPng = netlogPath.replace(/\.jsonl$/, '') + '-qr.png';
  const walletName = String(settings.CLAIM_METHOD || 'zalopay') || 'zalopay';
  const doc = walletList(walletName).map((w) => w.label).join(' or ');
  log(`[>] Claiming the Pro trial via ${doc} (queue: ${host})`);
  try {
    const [kind, payload] = await claimTrialZalopay(page, human, tab, netlogPath, {
      log,
      shouldStop,
      qrPng,
      waitSeconds: Math.trunc(Number(settings.ZALOQR_WAIT) || 900),
      serve: false, // the queue server replaces the local PNG page (python passed serve=False here)
      qrApi: host,
      email,
      qrRefreshBefore: Math.trunc(Number(settings.ZALOQR_REFRESH_BEFORE) || 60),
      qrTtl: Math.trunc(Number(settings.ZALOQR_TTL) || 0),
      apiFirst: Boolean(settings.CLAIM_API_FIRST),
      wallet: walletName, // the CLAIM_METHOD string itself — claimTrialZalopay splits the priority list
    });
    if (kind === 'done') {
      const source = payload.charge_id || payload.note || '?';
      log(`    [ok] 7-day Pro trial via the wallet: ${source}`);
      return payload;
    }
    if (kind === 'retry') {
      log(`    [i] This account was not invited to the offer (${payload}).`);
      return null;
    }
    log(`    [!] Wallet claim stopped: ${payload}`);
    return null;
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    log(`    [!] Wallet claim error (${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}) — the account is kept.`);
    return null;
  }
}

// Card path (python claim_pro_if_enabled card branch). Cards come from
// `settings.CARD_POOL` when a bulk run dealt them out; a standalone run takes
// the single card straight from the config. Take SEVERAL: the gateway
// rejecting the first card (RISK_REJECTED) is routine, and with a spare the
// claim continues on the SAME order instead of losing the account.
async function claimProCard(page, human, tab, settings, netlogPath, log, shouldStop) {
  // python quirk kept: `int(getattr(settings, "PRO_CARD_TRIES", 3) or 1)` —
  // unset defaults to 3, and 0/invalid falls to 1; never below 1.
  const rawTries = settings.PRO_CARD_TRIES ?? 3;
  const tries = Math.max(1, Math.trunc(Number(rawTries) || 1));
  const pool = settings.CARD_POOL ?? null;           // CardPool instance (bulk-assigned)
  const assigned = settings.PRO_CARD_ASSIGNED ?? null; // pre-dealt cards for this account
  let cards = [];
  if (assigned) {
    cards = Array.isArray(assigned) ? assigned : [assigned];
  } else if (pool) {
    cards = await pool.takeMany(tries);
  } else {
    const one = cardFromSettings(settings);
    cards = one ? [one] : [];
  }
  if (!cards.length) {
    log('[!] Out of cards in the pool (or none entered) — skipping the Pro claim.');
    return null;
  }
  log(`[i] ${cards.length} card(s) to try, first ...${cards[0].number.slice(-4)}`);

  // How many cards were actually SPENT; the surplus goes back to the pool.
  let used = 1;
  try {
    log('[>] Claiming the 7-day free Pro trial ...');
    const [kind, payload] = await claimTrial(page, human, tab, netlogPath, cards, {
      log,
      shouldStop,
      localePath: settings.CAPCUT_LOCALE || 'vi-vn',
    });
    if (kind === 'done') {
      used = Math.trunc(Number(payload.card_index) || 1);
      log(`    [ok] 7-day Pro trial: order=${payload.order_id} charge=${payload.charge_id}`);
      log(`    [!] IT WILL AUTO-CHARGE ${payload.intro_amount} ${payload.currency} on ${payload.next_payment_date} — cancel before then if unused.`);
      return payload;
    }
    if (kind === 'card') {
      used = cards.length;
      log(`    [!] Every card was declined (${payload}). The account is kept.`);
      return null;
    }
    if (kind === 'retry') {
      used = 0; // never reached the card step -> no card spent
      log(`    [i] This account was not invited to the offer (${payload}).`);
      return null;
    }
    log(`    [!] Claim stopped: ${payload}`);
    return null;
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    log(`    [!] Pro claim error (${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}) — the account is kept.`);
    return null;
  } finally {
    // Give the UNUSED cards back, or every claim burns its spares too.
    if (pool && !assigned && used < cards.length) {
      await pool.giveBack(cards.slice(used));
    }
  }
}

// ----------------------------------------------------------------------------
// Target selection (python doc_nick + filters, DB-driven)
// ----------------------------------------------------------------------------

// Keep only accounts that already finished their tasks (python --nguong:
// credit >= DU_NHIEM_VU by default). A low-credit nick is one CapCut has not
// fully unlocked benefits on — claimed or not it slips; run redo-tasks FIRST
// then go Pro for the higher hit rate. 0/null threshold = keep everything.
// NULL credits (never measured) count as 0, matching python's doc_nick which
// dropped lines whose credit column was not an integer.
export function filterUpgradeTargets(targets, minCredits = FULL_CREDIT_TARGET) {
  const need = Math.trunc(Number(minCredits) || 0);
  if (!need) return [...targets];
  return targets.filter((t) => Number.isInteger(t && t.capcut_credits) && t.capcut_credits >= need);
}

// Newest accounts first (python sorted by -line index: the file appends, so
// the last line is the newest nick — newest nicks get far better offers).
// The DB helper returns oldest-first (ORDER BY created ASC), so reverse.
export function sortUpgradeTargets(targets) {
  return [...targets].reverse();
}

// ----------------------------------------------------------------------------
// Export-file rewrite (python ghi_ket_qua / chuyen_sang_pro, combined file)
// ----------------------------------------------------------------------------

// Rewrite ONE account's credit AND plan column inside the export file, keyed
// by email prefix. Extends redo-tasks' rewriteAccountsCredit (which only
// rewrites credit) with the plan column — python's chuyen_sang_pro flipped
// the plan to 'Pro', and a credit-only rewrite would leave a Pro line
// labelled 'free'. Reuses normalizeAccountsLine so the credit column and the
// creation-date rules stay identical. Returns true when a line was updated.
export async function rewriteAccountsUpgrade(filePath, email, credits, plan = null) {
  return FILE_MUTEX.run(() => {
    let lines;
    try {
      lines = readLines(filePath); // [] when the file does not exist
    } catch {
      return false; // python: except OSError -> return False
    }
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith(email + '|')) continue;
      let out = normalizeAccountsLine(lines[i], credits);
      if (plan) {
        const parts = out.split('|');
        parts[3] = String(plan); // plan column: 'Pro' on success, kept 'free' otherwise
        out = parts.join('|');
      }
      lines[i] = out;
      changed = true;
      break; // first match only, like python
    }
    if (changed) {
      try {
        fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
      } catch {
        return false;
      }
    }
    return changed;
  });
}

// ----------------------------------------------------------------------------
// One account (python len_pro_mot_nick)
// ----------------------------------------------------------------------------

// Log in, claim Pro, write the results back. `account` is an accounts.db row
// (username/email/password/capcut_credits/capcut). Returns
// {email, pro, credits} on a completed attempt (pro=false = claim missed),
// null when the account was skipped (dead proxy, login failure, crash).
//
// Heavily guarded (python note): the account already exists — a claim-step
// error must never corrupt its record; better to keep the honest 'free' + old
// credit than to write a wrong number.
export async function upgradeOne(settings, {
  account, db, workerId = 1, proxy = null, accountsFile = null,
  keepNetlog = false, netlogDir = NETLOG_DIR,
  log = console.log, shouldStop = null,
} = {}) {
  shouldStop = shouldStop || defaultShouldStop;

  // Per-line log prefix so parallel workers' output stays attributable
  // (python wlog / "[#wid]").
  const wlog = (m) => log(`[#${workerId}] ${m}`);

  const username = String(account.username || '');
  const email = String(account.email || '');
  const oldCredits = Number.isInteger(account.capcut_credits) ? account.capcut_credits : 0;

  // Per-account settings: this worker's proxy lane, claim forced on, tasks
  // forced off (tasks have their own tool — redo-tasks; python set the same
  // two flags in main()).
  const ws = {
    ...settings,
    RAW_PROXY: proxy ?? settings.RAW_PROXY ?? null,
    DO_CLAIM_PRO: true,
    DO_TASKS: false,
  };

  // Netlog PER ACCOUNT (python: lenpro-{wid}-{email-prefix}.jsonl): the claim
  // reads it back for cashier_url and the amount=0 check — a shared path
  // would hand the next worker the previous worker's order.
  fs.mkdirSync(netlogDir, { recursive: true });
  const name24 = email.split('@')[0].slice(0, 24);
  const netlogPath = path.join(netlogDir, `lenpro-${workerId}-${name24}.jsonl`);

  let handle = null;
  let recorder = null;
  let wentPro = false;
  try {
    // Throwaway stealth profile per account, named after the username
    // (python opened a per-run GPM profile instead — GPM is gone).
    handle = await openBrowser(ws, { name: username, rawProxy: proxy, log: wlog, shouldStop });
    const human = new HumanInput(handle.page);

    recorder = new NetworkRecorder({ target: handle.page, outPath: netlogPath, log: wlog });
    await recorder.start();

    // Warm-up doubles as the reachability probe: on a dead proxy the SDK
    // never hooks fetch and the claim would misread everything downstream.
    if (!(await warmUp(handle.page, { localePath: ws.CAPCUT_LOCALE || 'vi-vn', log: wlog, shouldStop }))) {
      wlog('[!] Proxy/network cannot load capcut.com — dropping this account.');
      return null;
    }

    const ok = await login(handle.page, human, email, String(account.password || ''), {
      log: wlog,
      shouldStop,
      locale: ws.CAPCUT_LOCALE || 'vi-vn',
    });
    if (!ok) {
      wlog(`[!] Could not log in ${email}.`);
      return null;
    }

    const pro = await claimPro(handle.page, human, handle.page, ws, netlogPath, wlog, shouldStop, email);

    // Read credits AFTER going Pro (the plan's vip_credit is added); on a
    // missed claim re-read the current number so the row is not left stale.
    let credit = pro && typeof pro === 'object' && pro.credits ? pro.credits : null;
    if (!credit) {
      try {
        credit = creditTotal(await getCredit(handle.page)) || oldCredits;
      } catch {
        credit = oldCredits; // unreadable -> keep the old number (python parity)
      }
    }

    wentPro = Boolean(pro);
    const plan = wentPro ? 'pro' : (account.capcut || 'free');
    try {
      // DB is primary. plan write: 'pro' on success; on a miss keep the
      // existing value (default 'free') so the account stays an upgrade
      // target for the next run — python left the line in the free file too.
      updateCapcutCredits(db, username, credit, plan);
    } catch (e) {
      wlog(`[!] Could not update the DB row: ${e && e.message ? e.message : e}`);
    }

    // Export-file parity: rewrite the email-keyed line when the file exists.
    // Column 4 'Pro' matches the engine's saveAccount format.
    if (accountsFile) {
      const wrote = await rewriteAccountsUpgrade(accountsFile, email, credit, wentPro ? 'Pro' : null);
      if (!wrote) wlog(`[i] No line for ${email} in ${accountsFile} — DB updated only.`);
    }

    if (wentPro) {
      wlog(`[ok] ${email}: WENT PRO, credit ${oldCredits} -> ${credit}`);
    } else {
      wlog(`[--] ${email}: not Pro yet (credit ${credit})`);
    }
    return { email, pro: wentPro, credits: credit };
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    wlog(`[!] Error: ${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`);
    return null;
  } finally {
    if (recorder) {
      try { await recorder.stop(); } catch { /* best-effort */ }
    }
    // Netlog runs ~5MB/account. Once the claim SUCCEEDED nothing needs it
    // anymore; on a MISS keep it — it is the only way to see WHY it missed.
    if (wentPro && !keepNetlog) {
      try { fs.rmSync(netlogPath, { force: true }); } catch { /* already gone */ }
    }
    if (handle) {
      await closeBrowser(handle, { log: wlog, settings: ws });
    }
  }
}

// ----------------------------------------------------------------------------
// Worker pool (python main()'s thread pool)
// ----------------------------------------------------------------------------

// Upgrade the pre-selected targets with at most `concurrency` workers.
// `targets` are accounts.db rows (already filtered + sorted by the CLI); `db`
// is the shared open handle (node:sqlite statements are synchronous, so
// workers cannot interleave inside one). Each worker sticks to one
// round-robin proxy lane, pops targets off a shared queue, and stops cleanly
// on an empty queue or shouldStop (SIGINT). Returns the per-account results
// ({email, pro, credits}) in completion order — python collected ket_qua the
// same way and summarized only the pro ones.
export async function runUpgradeBulk(settings, {
  targets, db, concurrency = 2, proxyList = null, accountsFile = null,
  keepNetlog = false, netlogDir = NETLOG_DIR,
  log = console.log, shouldStop = null,
} = {}) {
  shouldStop = shouldStop || defaultShouldStop;
  concurrency = Math.max(1, Math.trunc(concurrency) || 1);

  // Proxy lanes dealt round-robin per WORKER SLOT (a lane sticks to its slot
  // for the whole run); empty list -> RAW_PROXY for everyone; neither ->
  // machine IP.
  const lanes = (Array.isArray(proxyList) ? proxyList : []).map((p) => String(p || '').trim()).filter(Boolean);
  if (!lanes.length) {
    const raw = String(settings.RAW_PROXY || '').trim();
    if (raw) lanes.push(raw);
  }
  if (!lanes.length) lanes.push(null); // placeholder lane = machine IP

  const queue = [...targets];
  const results = [];

  // One worker slot (python worker(wid)). queue.shift() is atomic on the JS
  // event loop — the python list-pop-under-lock needs no lock here.
  const worker = async (slot) => {
    const proxy = lanes[slot % lanes.length];
    const wid = slot + 1;
    while (queue.length && !shouldStop()) {
      const account = queue.shift();
      let res = null;
      try {
        res = await upgradeOne(settings, {
          account, db, workerId: wid, proxy, accountsFile, keepNetlog, netlogDir,
          log, shouldStop,
        });
      } catch (e) {
        if (e instanceof StopRequested) return; // python: worker returns on stop
        // upgradeOne already logged; unreachable, but never kill the pool.
        log(`[#${wid}] [!] Error: ${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`);
      }
      if (res) {
        results.push(res);
      } else {
        // Skipped before the claim ran (proxy/login). The row stays
        // 'registered' — never poisoned, a later run retries it.
        log(`[#${wid}] [i] ${account.username}: upgrade did not finish — row kept, re-run this tool later.`);
      }
    }
  };

  // Start workers staggered 2s apart (python time.sleep(2.0) between thread
  // starts) so N browsers do not all launch at the same instant.
  const workers = [];
  for (let slot = 0; slot < concurrency; slot++) {
    if (shouldStop()) break;
    workers.push(worker(slot));
    if (slot + 1 < concurrency) await sleep(2000);
  }
  await Promise.all(workers);
  return results;
}
