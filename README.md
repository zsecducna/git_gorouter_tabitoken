# gorouter-auto — GitHub account farm + GoRouter/TabiToken API key harvester

End-to-end automation: bulk-registers GitHub accounts (DataDome captcha stays
human-in-the-loop), signs each into gorouter.app + tabitoken.com via "Continue
with GitHub", creates an API key on each, and stores everything in `accounts.db`.

> Built around [CloakBrowser](https://github.com/CloakHQ/cloakbrowser) —
> stealth Chromium (fingerprints patched at C++ level), drop-in Playwright API.

## Requirements

- **Node.js ≥ 22** (uses built-in `node:sqlite`; developed on 26.x)
- **macOS** (scripts call `osascript` to hide/unhide Chromium; skip or replace on Linux)
- A **Resend** account with inbound email enabled — receives GitHub OTP codes
- Rotating **HTTP proxies** (recommended ~3 signups per IP per 240 s window)
- A human on standby for the DataDome slider (GitHub shows it intermittently;
  the script un-hides the browser window and waits up to 15 min)

## Install

```bash
npm install cloakbrowser playwright-core   # first run downloads ~200MB Chromium
```

## Configuration

### `.env` (read-only by scripts — never committed)

```
RESEND_API_KEY=re_xxx
# optional — site registration links incl. your referral codes (defaults shown)
# GOROUTER_SIGNUP_URL=https://gorouter.app/sign-up?aff=Jju8
# TABITOKEN_SIGNUP_URL=https://tabitoken.com/sign-up?aff=fPbO
```

Overriding a signup URL also re-derives that site's origin and `/sign-in`
entry automatically.

### Mail / OTP source — env-driven

Priority (checked per account):

1. `RESEND_API_KEY` in `.env` → Resend inbound API
2. else `MAIL_PASS` (+ optional `MAIL_USER`, default `me@duke-kr.win` catch-all)
   → your IMAP mail server (`mail-otp.mjs`, IDLE push)
3. neither → scripts exit at boot: `FATAL: no OTP source`

`@duke-kr.win` addresses ALWAYS use IMAP (Resend never sees that domain) —
with only `RESEND_API_KEY` configured, duke-kr batches fail fast with a clear
error instead of stalling.

Provision batches on the free domain:

```bash
node gen-accounts.mjs 1000 duke-kr.win   # userNNNN@duke-kr.win, OTPs via IMAP
```

### `proxies.txt` — one proxy per line, two accepted formats

```
host:port:username:password          # zingproxy style
http://user:pass@host:port           # URL style
```

`#` lines are comments. LRU rotation is global and shared by every process via
`proxy-state.json` (auto-generated) — the longest-idle eligible proxy is picked
next; proxies that hit network errors get a 200 s cooldown (proxy IPs rotate every 240 s anyway).

### `accounts.db` — SQLite, source of truth (never committed)

Created automatically on first provisioning. One row per account:

```sql
CREATE TABLE accounts (
  site TEXT, email TEXT, username TEXT, password TEXT,
  region TEXT, created TEXT,
  status TEXT,               -- unregistered | in-flight | registered | poisoned
  gorouter TEXT, gorouter_api_key TEXT,
  tabitoken TEXT, tabitoken_api_key TEXT
);
```

**Provision N accounts** (random `Vt-hex` passwords, `unregistered` status).
Domain is required — no default. Username suffix = domain with dots/dashes
stripped (`my-domain.io` → `user0001mydomainio`):

```bash
node gen-accounts.mjs 1000 listing-studio.uk     # user0001..user1000
node gen-accounts.mjs 500 mydomain.com 1001      # user1001..user1500
```

Existing rows are skipped by username/email — safe to re-run. The `next up`
hint is scoped to the batch's domain (global next-up would point at an older
unfinished batch). Passwords are
stored in **plaintext** by design (this is a creds vault).

## Run

### Full pipeline — register GitHub + harvest both keys

```bash
node pipeline.mjs                          # all unregistered, sequential
FROM=user0500listingstudio TO=user0600listingstudio node pipeline.mjs   # range
node pipeline.mjs 1 user0222listingstudio  # single account (also retries keys)
```

### Fast mode — register + site logins only, keys later

```bash
FAST=1 node pipeline.mjs                   # register GitHub → OAuth BOTH sites → exit
```

Skips key creation entirely (no `/keys` visits). Sites are marked `registered`
with 3-round mandatory OAuth — run `backfill-keys.mjs` afterwards to harvest
keys in a dedicated pass.

Flow per account, one fresh browser each: `/signup` → fill → **Create account**
→ Resend OTP (8-digit launch code) → signed-in/profile-200 proof → site OAuth
(gorouter, then tabitoken) → create key (group "default") → **route-intercept**
the `/api/token/<id>/key` response → save `sk-…` key.

### Windows (PowerShell) quickstart

```powershell
# prereqs
winget install OpenJS.NodeJS.LTS Git.Git
# clone + deps
cd $env:USERPROFILE\Desktop
git clone git@github.com:zsecducna/git_gorouter_tabitoken.git gorouter-auto
cd gorouter-auto
npm install cloakbrowser playwright-core imapflow mailparser

# .env — OTP via your IMAP catch-all
@"
MAIL_HOST=mail.duke-kr.win
MAIL_USER=me@duke-kr.win
MAIL_PASS=xxx
"@ | Out-File -Encoding ascii .env

# proxies.txt — one host:port:user:pass per line
# provision randomized batch + smoke-test one account
node gen-accounts.mjs 1000 duke-kr.win --random
$env:FAST="1"; node pipeline.mjs 1 u00243a5692; Remove-Item Env:FAST

# 6 FAST lanes — claims arbitrate, no ranges needed
$env:FAST="1"
1..6 | ForEach-Object { Start-Job -Name "lane$_" -ScriptBlock {
  param($n) Set-Location $using:PWD; node pipeline.mjs *> "p$n.log" } -ArgumentList $_ }
Get-Job                                  # lane status
Stop-Job lane*; Remove-Job lane*         # stop all
```

Windows notes: the macOS window-hide calls no-op silently (browsers stay
visible — slide DataDome challenges as they appear); everything else
(LRU proxies, claims, WAL, IMAP IDLE) is platform-neutral.

### Multiple threads (parallel lanes)

Lanes are safe in parallel: disjoint `FROM/TO` ranges + atomic
`unregistered → in-flight` row claims + WAL mode. Env prefix per lane:

```bash
# 5 concurrent FAST lanes over disjoint ranges (one browser each, LRU proxies)
FAST=1 FROM=user0200listingstudio TO=user0400listingstudio nohup node pipeline.mjs >> /tmp/p2.log 2>&1 &
FAST=1 FROM=user0400listingstudio TO=user0600listingstudio nohup node pipeline.mjs >> /tmp/p3.log 2>&1 &
FAST=1 FROM=user0600listingstudio TO=user0800listingstudio nohup node pipeline.mjs >> /tmp/p4.log 2>&1 &
FAST=1 FROM=user0800listingstudio TO=user0900listingstudio nohup node pipeline.mjs >> /tmp/p5.log 2>&1 &
FAST=1 FROM=user0900listingstudio                     nohup node pipeline.mjs >> /tmp/p6.log 2>&1 &
```

Same pattern without `FAST=1` for full-pipeline lanes, and with
`node backfill-keys.mjs` for key-harvest lanes. Rules of thumb:

- one **browser per lane** — CloakBrowser instances are heavyweight
- **sequential batches** (`userNNNN…`): shard with disjoint `FROM`/`TO` ranges —
  avoids lanes stealing each other's queue entries
- **random batches** (`--random`): omit `FROM`/`TO` entirely — every lane works
  the same queue and the atomic `unregistered → in-flight` claim arbitrates
  (`claimed elsewhere — skip`). A collision costs one no-op UPDATE, so no
  coordination is needed
- the last lane may omit `TO` to run to the end (`user9999…` bound)
- proxies are shared globally: every lane picks the least-recently-used
  healthy proxy from `proxies.txt` via `proxy-state.json`

### Backfill — key-only pass for registered accounts

```bash
node backfill-keys.mjs                                # all missing keys
FROM=user0001listingstudio TO=user0500listingstudio node backfill-keys.mjs
```

### Maintenance

```bash
node reconcile.mjs        # phantom 'registered' rows w/o GitHub profile → unregistered
node verify-poisoned.mjs  # 'poisoned' rows whose profile appeared → registered
```

## Gotchas learned the hard way

- **Account exists only after launch-code verify**; a bare `github.com/` redirect
  after verify can still be logged-out — check `meta[user-login]` AND profile 200.
- **Key creation response carries no key** — capture = `page.route('**/api/token/*/key')`
  + `route.fetch()` replaying the UI's own authenticated XHR. Keys arrive bare;
  store with `sk-` prefix. Never use the OS clipboard in parallel runs.
- Turnstile does **not** gate the "Continue with GitHub" button; the DataDome
  slider on `/signup` does gate registration and is human-only by design.
- Headless breaks gorouter OAuth — stay headful (windows are auto-hidden).
- Country dropdown auto-detects from proxy IP; don't touch it.
