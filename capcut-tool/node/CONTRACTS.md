# CONTRACTS — Node.js port of capcut-tool (READ FIRST, follow exactly)

Python source of truth: `/Users/z/Desktop/gorouter-auto/capcut-tool/*.py`
Node output dir: `/Users/z/Desktop/gorouter-auto/capcut-tool/node/`

Ported in order (user-directed): **step 1 = signup** (`capcut_signup.py` flow),
step 2 = pro upgrade (`len_pro.py`), step 3 = task redo (`lam_lai_nhiem_vu.py`).
Everything not in the current step's dependency graph is OUT — do not port it yet.

## Layout (enforced)

```
node/
├── package.json            # type:module; deps resolve from repo root node_modules
├── config.example.js       # copy to config.js (gitignored) — UPPER_SNAKE named exports
├── CONTRACTS.md            # this file
├── bin/                    # thin CLI entrypoints, main-guard only
│   ├── netlog.js           # network capture CLI (landed)
│   ├── signup.js           # bulk signup CLI  (agent E)
│   └── provision.js        # provision accounts into DB (agent E)
├── src/
│   ├── core/               # CapCut domain logic
│   │   ├── capcut-api.js   # landed — 4 signup APIs via in-page fetch
│   │   ├── capcut-tasks.js # landed — credit tasks
│   │   └── capcut-engine.js# agent E — signup orchestration
│   ├── browser/            # browser platform layer (CloakBrowser = stealth Chromium, Playwright API)
│   │   ├── browser.js      # landed — openBrowser/closeBrowser/pickTab/waitForDomReady/StopRequested
│   │   ├── human-input.js  # landed — HumanInput (bezier mouse, per-key delays)
│   │   └── netlog.js       # landed — NetworkRecorder + watch/summarize
│   ├── infra/              # external services
│   │   ├── mail.js         # landed — IMAP catch-all OTP reader (thanhphuonglatoi.com)
│   │   └── db.js           # landed — accounts.db queue (provision/claim/mark)
│   └── util/               # shared helpers
│       ├── util.js         # landed — sleep/randInt/makeMutex/loadEnv/parseCli/...
│       ├── gen.js          # landed — username/password (repo github rule) + workspace name
│       └── proxy.js        # landed — parseProxy/normalizeProxy/toUrlProxy/toPlaywrightProxy
└── data/                   # gitignored runtime artifacts (profiles/, txt exports, netlog/)
```

## Global rules

1. **ESM**, `.js`, `"type":"module"`. Node >= 18, native `fetch`. **Allowed imports only**: `cloakbrowser`, `imapflow`, `mailparser`, node builtins. All resolve from repo-root `node_modules` (walk-up).
2. **Translate ALL Vietnamese → English** (comments, logs, log/UI strings — never selectors, URLs, API payloads, file formats). Vietnamese identifiers → English (`cho_san_sang` → `waitForReady`).
3. **Executive comment above every function/class/method** (1–3 lines: what/why/gotcha). Keep the Python files' measured-behavior notes (dates, measurements) — translated; they are the tool's real documentation.
4. **Faithful port**: same selectors, URLs, constants, timeouts, retries, output formats. Behavior drift is a bug.
5. Never synthetic DOM events (`el.click()`, dispatchEvent, value setters). All actuation via Playwright `page.mouse`/`page.keyboard` (CDP Input domain, isTrusted:true). JS in page only READS (rects, URL, text) via the anonymous-IIFE evaluate pattern.
6. Threading → async: worker pool with concurrency N; locks → `makeMutex()` from `src/util/util.js`.
7. No fake completion: no TODOs except the two allowed stubs. Every ported function does real work.
8. Verify your files: `node --check` each; `node -e "await import(...)"` each lib (import-safe: no top-level network/browser/file-mutation). CLIs run under `if (import.meta.url === pathToFileURL(process.argv[1]).href)`.
9. Don't touch files you don't own. Shared helpers: import from `src/util/`.
10. Config via the merged `settings` object only (engine merges config.js + CLI flags). Exception: `src/infra/mail.js` also reads `process.env.MAIL_PASS`; `loadEnv()` (util.js) loads repo-root `.env` — call once from CLIs.
11. **Browser = CloakBrowser** (`src/browser/browser.js` `openBrowser(settings, {name, rawProxy, log, shouldStop})` → `{browser, context, page, profileDir, close()}`). One throwaway stealth profile per account; `close()` wipes the dir when `DELETE_PROFILE_AFTER`. No GPMLogin, no connectOverCDP. `RAW_PROXY` is the fallback proxy; `PROXY_LIST` is dealt round-robin per worker slot.
12. Credentials come from the DB queue, never generated: `provision.js` inserts rows (username `u`+10hex, password `Vt-`+12hex+`-9x!K`, email `<username>@thanhphuonglatoi.com`, site `capcut.com`, status `unregistered`); engine claims rows atomically.

## Allowed stubs (step 1)

- `claimProIfEnabled()` — when `DO_CLAIM_PRO=true`: log `[claim] Pro claim not ported yet (step 2) — account stays free`, continue. Call site wired exactly like python.
- Proxy rotation (kiotproxy/proxy_rotate) — not ported; `browser.js` already logs one notice when `KIOT_ENABLED`/`ROTATE_PROXY`; engine passes static proxies only.

## Module contracts

### Landed (read the files; code against these exact exports)
- `src/util/util.js`: `sleep`, `randInt`, `randFloat`, `choice`, `ts`, `nowStr`, `todayStr`, `makeMutex`, `loadEnv`, `parseCli`, `readLines`, `appendLine`, `pick`, `clamp`
- `src/util/gen.js`: `randomUsername`, `randomPassword`, `randomWorkspaceName`
- `src/util/proxy.js`: `ProxyError`, `parseProxy`, `normalizeProxy`, `toUrlProxy`, `toPlaywrightProxy`
- `src/infra/mail.js`: `makeMailbox({settings, email, log, shouldStop})` → `{ waitForCode({timeout, interval, log, shouldStop}) → 6-digit string|null, release() }`, `validateMail(settings)` → string[]
- `src/infra/db.js`: `openAccountsDb(path?)`, `ensureCapcutColumns(db)`, `provisionCapcutAccounts(db, n, {emailDomain, log})`, `claimNextCapcut(db)` → row|null (ATOMIC), `markCapcutRegistered(db, username, {credits, plan})`, `markCapcutPoisoned(db, username, reason)`, `releaseCapcut(db, username)` (status back to unregistered — transient fail), `capcutStats(db)`, `DEFAULT_ACCOUNTS_DB`
- `src/browser/browser.js`: `StopRequested`, `checkStop`, `defaultShouldStop`, `currentUrl`, `waitForDomReady`, `pickTab(context)`, `openBrowser(settings, {name, rawProxy, log, shouldStop})`, `closeBrowser(handle, {log, settings})`
- `src/browser/human-input.js`: `HumanInput` — `move/clickXY/click/clickButton/fill/fillCode/typeText/pressKey/scroll/scrollToBottom/waitFor/reportInputs`
- `src/browser/netlog.js`: `NetworkRecorder`, `watch`, `summarize`, `JsonlWriter`
- `src/core/capcut-api.js`: `xorHex`, `xorUnhex`, `warmUp`, `checkEmailFree`, `checkAge`, `sendCode`, `register`, `renameWorkspace`, `skipQuestionnaire`, `signupViaApi(page, mailbox, email, password, settings, {log, shouldStop})` → `{ok, birthday}` (mailbox seam replaces python otp/order)
- `src/core/capcut-tasks.js`: `getUserId`, `getCredit`, `creditTotal`, `listTasks`, `taskPopup`, `makeOpId`, `doAction`, `waitForReady`, `runAll`, `APP_URL`, `STATUS_DONE`, `SKIP_KEYS`, `ERR_DUPLICATE`

### lib/capcut-engine.js + bin/signup.js + bin/provision.js — agent E
Port of `capcut_engine.py` + `capcut_signup.py`, DB-queue-driven.
- Engine exports: `signupOne(settings, {account, log, shouldStop, netlogPath})` → account obj `|null` (account = claimed row; creds from row), `runBulk(settings, {total, concurrency, proxyList, log, shouldStop, deleteProfile, netlogDir})` → results[] (claim → signup → mark; clean stop on empty queue or SIGINT), `validate(settings)` → string[], `saveAccount`, `readCreditTotal`, `doTasksIfEnabled`, `claimProIfEnabled` (allowed stub), `ProgressTimer` (python `_DongHo`).
- Flow per account (port python `signup_one` faithfully): openBrowser(name=username, rawProxy=slot proxy) → warmUp → SIGNUP_MODE 'api': `signupViaApi`; 'ui': port the 9 `step_*` screens (step_open_login … step_finish, same selectors/labels from capcut_engine.py) → mailbox.waitForCode inside → tasks if DO_TASKS → read credits → close browser → mark DB.
- Per-worker proxy: round-robin PROXY_LIST by slot index; empty list → RAW_PROXY → machine IP (log a warning once, like python).
- Files parity: append `email|password|credits|plan` lines to ACCOUNTS_FILE/PRO_FILE/FREE_FILE exactly like python `save_account` (paths relative to node/, i.e. under data/ per config). DB is primary.
- `bin/signup.js` flags: `-n/--count <n>`, `--total <n>`, `--no-claim`, `-t/--threads <n>`, `--one <username>` (one named unregistered row, no pool), `--netlog <file|dir>`, `--keep-profile`, `--no-rotate`, `--no-tasks`. Start: `loadEnv()`, merge config+flags, `validate()`, preflight (MAIL_PASS present via validateMail, DB stats printed, queue count warning when 0) — NO GPM ping (GPM is gone). SIGINT → stop event, workers close browsers, then exit; results summary like python (ok/total + file path).
- `bin/provision.js`: `node bin/provision.js <N>` — mirrors gen-accounts.mjs UX: provisions N rows (domain from config EMAIL_DOMAIN), prints added/skipped + total + next-up username. Refuses N<=0. Also `node bin/provision.js --stats` prints capcutStats.

## Step 2 contracts (wave 3 — parallel with engine wave; code against landed modules + each other's contracts below)

### src/core/capcut-login.js — worker F
Port of `capcut_login.py`: `login(page, human, email, password, {log, shouldStop})` → bool. Password-screen submit button found by TEXT (hashed classes — same note as python). Uses HumanInput only.

### src/infra/zaloqr-client.js — worker F
Port of `zaloqr_client.py`: `DEFAULT_HOST`, `parseExpiresIn(texts, default)`, `pngBytes(data)`, `class ZaloQRClient { constructor(host, {log, timeout, token}); healthcheck(); register(email); setBinding(url); uploadPngB64(b64, {expiresIn, note}); uploadPngBytes(raw, ...); uploadPngFile(path, ...); uploadJson(b64, {expiresIn}); queue(); nextQr(); status(); remaining(); qrUrl(); reset(reason); alive(); scanned(reason); confirm({chargeId, agreementId, amount, currency}); fail(reason, {chargeId, agreementId}); delete() }`. Soft-fail semantics: network errors log + return false/null, never break the claim flow. Write ops carry `QR_TOKEN` header when set. Server has no auth — never send anything sensitive beyond binding_url (python note).

### src/core/capcut-pro.js — worker G
Port of `capcut_pro.py`: `countLines`, `scanNetlog(path, startLine)` (jsonl scan — field names must match src/browser/netlog.js output), `proPriceTable(page, {region, log, timeout})`, `pickTrialPlan(list, {log})`, `openCommercePage(page, {log, url})`, `openOrderViaApi(page, {region, locale, log, shouldStop})`, `claimTrial(page, human, tab, netlogPath, card, {log, shouldStop})`, `waitNetlogResult(netlogPath, startLine, {log, shouldStop})`, `openCardForm`, `fillCard(page, human, card, {log, clear})`, `findConfirm`, `closeOverlays`, `setViewport(tab, {log, width, height})` (→ page.setViewportSize), `cardFromSettings`, `luhnOk`, `parseCard`, `parseCards`, `class CardPool` (take/takeMany/giveBack/blockBin/binSummary/left), `poolFromSettings`. In-page signed fetch rules identical to capcut-api.js.

### src/core/capcut-zalopay.js — worker H
Port of `capcut_zalopay.py`: `WALLETS` const (momo/zalopay labels+hosts+qr needles), `walletInfo`, `walletList`, `onWalletPage`, `zaloState(page)`, `chooseWallet(page, human, {label, log, shouldStop, tries})`, `selectZalopay`, `checkedLabel`, `isZalopaySelected`, `qrFingerprint(b64)`, `waitBindingPage`, `waitPageReady`, `captureClip(tab, box, {log, pad, scale})`, `waitUntil(doc, {seconds, pulse, shouldStop})`, `decodeQrVariant(img)` (QR content decode — use `jsqr` (ONLY allowed new dep, pure JS, add to root package.json + import here), variants logic per python `bien_the_giai`), `qrIsScannable(b64, {log, wallet})`, `grabQr(page, tab, {log, seconds, shouldStop, wallet})`, `saveQrPng(data, path, {log})`, `class QrServer` (python QRServer → node:http, serves PNG + deadline, start/stop/lanIp), `openHelperTab`, `closeHelperTab`, `proActive(page, {log, locale})`, `closeExtraTabs(page, keepTab, {log})`, `waitPaid(page, netlogPath, {log, seconds, shouldStop, ...})`, `openQrApi(qrApi, email, bindingUrl, {log})`, `openCashier(...)`, `openNewQr(...)`, `claimTrialZalopay(page, human, tab, netlogPath, {log, shouldStop, qrApi, ...})` with the auto QR-refresh loop near expiry.
Dependencies: zaloqr-client (worker F contract above), netlog jsonl format (landed), HumanInput, browser.js.

### Later (needs engine wave landed): bin/upgrade-pro.js — port of `len_pro.py` (doc_nick/ghi_ket_qua/chuyen_sang_pro/len_pro_mot_nick + engine claimProIfEnabled real wiring replacing the stub) and step 3 `bin/redo-tasks.js` — port of `lam_lai_nhiem_vu.py`.

### Step 3 — worker J: bin/redo-tasks.js + src/core/redo-tasks.js
Port of `lam_lai_nhiem_vu.py` (re-run credit tasks for existing registered accounts). DB-driven: targets = `listCapcutRedoTargets(db, {maxCredits, username})` (new db.js helpers, landed); per account: openBrowser(name=username, rawProxy=slot proxy) → `login` (src/core/capcut-login.js, landed) → tasks `runAll`/`getCredit`/`creditTotal` (landed) → `updateCapcutCredits(db, username, credits, plan)`; ACCOUNTS_FILE export line rewritten in place when present (email-keyed). CLI `node bin/redo-tasks.js`: default DRY-RUN preview (python parity), `--chay` executes, `-t/--threads <n>`, `--username <name>` single-account mode, `--max-credits <n>` filter (default from settings: redoes below 2060 full-credit target). Concurrency pool + SIGINT like signup CLI.

### Step 2 final wiring — worker I: bin/upgrade-pro.js + src/core/upgrade-pro.js + engine claim swap
Port of `len_pro.py`. Owns: `bin/upgrade-pro.js` (CLI: `--chay` execute / dry-run default, `-t/--threads`, `--username <name>` single, `--file` export override — mirrors redo-tasks CLI conventions), `src/core/upgrade-pro.js` (logic), AND a SCOPED edit of `src/core/capcut-engine.js`: replace ONLY the `claimProIfEnabled` stub body with a real call into upgrade-pro (python `claim_pro_if_enabled` wiring: wallet order per CLAIM_METHOD, card path via capcut-pro claimTrial, QR path via capcut-zalopay claimTrialZalopay, netlog mark before opening cashier, credit re-read after). DB targets = `listCapcutUpgradeTargets(db, {username})` (landed in db.js); success writes `capcut='pro'` via `updateCapcutCredits`. PINNED interfaces: `openOrderViaApi` → `[orderId, cashierUrl]`; `scanNetlog` field names are python snake_case (`pay_status`, `err_code`, `cashier_url`...); `findConfirm(page, {seconds, shouldStop})`, `closeOverlays(page, human, {log})`, `setViewport(tab, {log})`. Per-account: openBrowser(name=username) → login → claim per CLAIM_METHOD → verify proActive/credits → DB + ACCOUNTS_FILE line rewrite. ZALOQR_WAIT/REFRESH_BEFORE/TTL honored.

### OKOTP gmail provider — worker K
Port of `okotp.py` (paid gmail rental, okotp.com; envelope `{code:0,message:"success",data:...}` — code 0 = success). Owns `src/infra/okotp.js` + SCOPED engine/CLI edits:
- `src/infra/okotp.js`: `class OkotpClient { constructor(apiKey, {baseUrl, timeout, log}); ping(); balance(); services(); price(serviceId, emailTypeId); createOrder({serviceId, emailTypeId}); getCode(orderItemId, sign, {parseCode, limit}); waitForCode(order, {timeout, interval, log, shouldStop}) → code|null }` + `extractCode(data)` port (handles multiple response shapes, python's `_code_from_content`/`_scan_content` logic) + `class OkotpDead`/`OkotpError`. createOrder COSTS REAL MONEY — never call it in tests/import; code against python for shapes.
- Engine seam (SCOPED edit in `src/core/capcut-engine.js` signupOne + `bin/signup.js`/`bin/provision.js` settings): when `settings.MAIL_PROVIDER === 'okotp'`: after claiming the row, rent a gmail via OkotpClient.createOrder (CapCut OTP_SERVICE_ID, OTP_EMAIL_TYPE_ID), UPDATE the row's email to the rented address (db.js: add `setCapcutEmail(db, username, email)`), build the mailbox from the order (`waitForCode` reads code via okotp, NOT IMAP), and on finish mark the order used. `MAIL_PROVIDER='own'` (default) = current IMAP path untouched. Config keys added to config.example.js: `OTP_API_KEY=''`, `OTP_BASE='https://api.okotp.com'`, `OTP_SERVICE_ID='2070452724137512961'`, `OTP_EMAIL_TYPE_ID='2047660085469163521'`. validate(): warn when MAIL_PROVIDER='okotp' && !OTP_API_KEY.

## Ownership map
- Landed: util/gen/proxy/mail/db/config.example (A), gpm→deleted, cdp→browser.js (B, reworked by main), human-input/netlog + bin/netlog (C), capcut-api/capcut-tasks (D).
- Agent E (wave 2, RUNNING): `src/core/capcut-engine.js`, `bin/signup.js`, `bin/provision.js` — touch NOTHING else; report drift instead of fixing others' files.
