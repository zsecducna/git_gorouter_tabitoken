// REDO CREDIT TASKS for existing accounts — log back in and finish the tasks.
// Port of lam_lai_nhiem_vu.py (step 3).
//
// Why this exists: every signup run burns a FRESH account, so an account whose
// task run stalled mid-way (credit stuck at 520 or 1540 instead of 2060) had
// no path back — the missing credit was lost forever. Measured on 117
// accounts: 39 stopped at 520 and 23 at 0 — over half only ever received the
// gift credit. Run this AFTER a signup batch finishes.
//
// Python read its targets from a text file (doc_nick); this port is
// DB-DRIVEN: targets are accounts.db rows with status 'registered' and
// capcut_credits below the full-credit target (listCapcutRedoTargets), and
// the fresh count is written back with updateCapcutCredits. The DB is the
// primary record; the python `email|password|credits|plan` export line is
// ALSO rewritten in place in ACCOUNTS_FILE when that file exists
// (ghi_credit parity).
//
// Failure handling (python parity): python never deleted a hopeless nick from
// the file — it logged and moved on. DB equivalent: the row STAYS
// 'registered'. Task/login failures are NEVER poisoned here; the account
// still exists and a later re-run can try again.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StopRequested, defaultShouldStop, openBrowser,
} from '../browser/browser.js';
import { HumanInput } from '../browser/human-input.js';
import { warmUp } from './capcut-api.js';
import { login } from './capcut-login.js';
import { runAll, getCredit, creditTotal } from './capcut-tasks.js';
import { updateCapcutCredits } from '../infra/db.js';
import { makeMutex, readLines, sleep } from '../util/util.js';

// node/ package root (config file values resolve against it, like python's
// script-dir-relative files). This file is node/src/core/redo-tasks.js.
const NODE_ROOT = path.dirname(fileURLToPath(new URL('../../', import.meta.url)));

// Credits an account holds when ALL 11 tasks are done (python DU_NHIEM_VU).
// Accounts below this are redo targets; above it, nothing left to claim.
export const FULL_CREDIT_TARGET = 2060;

// Serializes export-file rewrites across concurrent workers (python
// _khoa_file threading.Lock). Re-read from disk inside the lock every time —
// holding an in-memory copy would overwrite another worker's change.
const FILE_MUTEX = makeMutex();

// 'YYYY-MM-DD HH:MM' local time — column-5 stamp format of the export lines
// (python ngay.py DINH_DANG). Only stamped when a line has NO date yet; an
// existing creation date is never overwritten.
function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Rebuild one export line with a new credit count (port of python
 * ngay.tach + ngay.chuan_hoa as used by ghi_credit). The line always comes
 * out with 5 columns: email|password|credits|plan|date. The date column is
 * KEPT when present (it is the account's creation date) and only stamped
 * when empty; the plan column passes through untouched.
 */
export function normalizeAccountsLine(line, credits) {
  const parts = String(line ?? '').replace(/\r+$/, '').split('|');
  while (parts.length < 5) parts.push('');
  parts[2] = String(credits);
  if (!parts[4].trim()) parts[4] = stampNow();
  return parts.join('|');
}

/**
 * Rewrite ONE account's credit inside the export file, keyed by email prefix
 * (port of python ghi_credit). Returns true when a line was updated, false
 * when the file is unreadable or the email is not in it. Must be awaited —
 * concurrent workers serialize through FILE_MUTEX, and the file is re-read
 * from disk on every call so no worker clobbers another's write.
 */
export async function rewriteAccountsCredit(filePath, email, credits) {
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
      lines[i] = normalizeAccountsLine(lines[i], credits);
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

/**
 * Order redo targets the way python main() did: 0-credit accounts LAST.
 * A 0-credit account is usually one CapCut blocked benefits on from the
 * start — still worth trying, but the 520/1540 ones (near-certain wins) go
 * first so the run banks the safe credit before burning time. Within a group
 * higher credit first; NULL credits (never measured) count as 0.
 */
export function sortRedoTargets(targets) {
  const cred = (t) => (Number.isInteger(t && t.capcut_credits) ? t.capcut_credits : 0);
  return [...targets].sort((a, b) => {
    const za = cred(a) === 0 ? 1 : 0;
    const zb = cred(b) === 0 ? 1 : 0;
    if (za !== zb) return za - zb;
    return cred(b) - cred(a);
  });
}

/**
 * Redo the tasks for ONE registered account (port of python lam_mot_nick).
 * `account` is an accounts.db row (username/email/password/capcut_credits).
 * Flow: throwaway stealth browser named after the username -> warm up the
 * SDK (also proves the proxy can load capcut.com) -> log in -> runAll tasks
 * (its internal retry sweeps + re-read stand in for python's re-run) -> read
 * the fresh total -> updateCapcutCredits + rewrite the export line.
 *
 * Returns the new credit total, or null when the account was skipped
 * (unreachable proxy, login failure, unreadable credit). Never throws except
 * StopRequested (SIGINT); on any failure the DB row keeps status
 * 'registered' — nothing is poisoned, a later run can retry.
 */
export async function redoOne(settings, {
  account, db, workerId = 1, proxy = null, accountsFile = null,
  log = console.log, shouldStop = null,
} = {}) {
  shouldStop = shouldStop || defaultShouldStop;

  // Per-line log prefix so parallel workers' output stays attributable
  // (python wlog / "[#wid]").
  const wlog = (m) => log(`[#${workerId}] ${m}`);

  const username = String(account.username || '');
  const email = String(account.email || '');
  const oldCredits = Number.isInteger(account.capcut_credits) ? account.capcut_credits : 0;

  // Per-account settings: this worker's proxy lane (python also set GPM
  // profile/CLOSE_AFTER_DONE here — both obsolete, openBrowser/close handle
  // them; the KiotProxy key lease is not ported, browser.js logs the notice).
  const ws = { ...settings, RAW_PROXY: proxy ?? settings.RAW_PROXY ?? null };

  let handle = null;
  try {
    handle = await openBrowser(ws, { name: username, rawProxy: proxy, log: wlog, shouldStop });
    const human = new HumanInput(handle.page);

    // Warm-up doubles as the reachability probe: on a dead proxy the SDK
    // never hooks fetch and CapCut is effectively unloaded.
    if (!(await warmUp(handle.page, { localePath: ws.CAPCUT_LOCALE || 'vi-vn', log: wlog, shouldStop }))) {
      wlog('[!] Proxy/network cannot load capcut.com — skipping this account.');
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

    // runAll fetches the user_id itself (the Node login returns bool, not the
    // uid python passed through); one call already includes the sweep passes
    // and the missed-read re-checks, mirroring python's single run_all call.
    const res = await runAll(handle.page, {
      log: wlog,
      shouldStop,
      userId: null,
      delayMin: Number(ws.TASK_DELAY_MIN ?? 0.8),
      delayMax: Number(ws.TASK_DELAY_MAX ?? 1.6),
    });

    // Prefer the post-run read; fall back to a fresh getCredit. A 0/failed
    // read must NOT overwrite the stored number (python kept the old value).
    let total = creditTotal(res.creditAfter);
    if (!total) total = creditTotal(await getCredit(handle.page));
    if (!total) {
      wlog('[!] Could not read credit after the redo — keeping the old number.');
      return null;
    }

    // DB is primary; keep the existing plan column (null = leave untouched).
    try {
      updateCapcutCredits(db, username, total, account.capcut ?? null);
    } catch (e) {
      wlog(`[!] Could not update the DB row: ${e && e.message ? e.message : e}`);
    }

    // Export-file parity: rewrite the email-keyed line when the file exists.
    if (accountsFile) {
      const wrote = await rewriteAccountsCredit(accountsFile, email, total);
      if (!wrote) wlog(`[i] No line for ${email} in ${accountsFile} — DB updated only.`);
    }

    wlog(`[ok] ${email}: ${oldCredits} -> ${total} (+${total - oldCredits})`);
    return total;
  } catch (e) {
    if (e instanceof StopRequested) throw e;
    wlog(`[!] Error: ${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`);
    return null;
  } finally {
    if (handle) await handle.close(); // closes Chromium, wipes profile when DELETE_PROFILE_AFTER
  }
}

/**
 * Worker pool over the pre-selected targets (port of python main()'s thread
 * pool). `targets` are accounts.db rows (already filtered + sorted by the
 * CLI); `db` is the shared open handle (node:sqlite calls are synchronous,
 * so workers cannot interleave inside a statement). Workers each stick to one
 * round-robin proxy lane, pop targets off a shared queue, and stop cleanly
 * on an empty queue or shouldStop (SIGINT). Returns the per-account results
 * in completion order — nonzero totals only, matching python's
 * `ket_qua`-filtered `xong` count.
 */
export async function runRedoBulk(settings, {
  targets, db, concurrency = 2, proxyList = null, accountsFile = null,
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
        res = await redoOne(settings, {
          account, db, workerId: wid, proxy, accountsFile, log, shouldStop,
        });
      } catch (e) {
        if (e instanceof StopRequested) return; // python: worker returns on stop
        // redoOne already logged; unreachable, but never kill the pool.
        log(`[#${wid}] [!] Error: ${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`);
      }
      if (res) {
        results.push(res);
      } else {
        // DB parity for python's "hopeless nick": the row EXISTS and stays
        // 'registered' — never poisoned on task failures, retry another day.
        log(`[#${wid}] [i] ${account.username}: redo failed — DB row left 'registered' (re-run this tool later).`);
      }
    }
  };

  // Start workers staggered 2s apart (python time.sleep(2.0) between thread
  // starts) so N browsers do not all launch at the same instant.
  const workers = [];
  for (let slot = 0; slot < concurrency; slot++) {
    workers.push(worker(slot));
    if (slot + 1 < concurrency) await sleep(2000);
  }
  await Promise.all(workers);
  return results;
}
