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
```

### `proxies.txt` — one proxy per line, two accepted formats

```
host:port:username:password          # zingproxy style
http://user:pass@host:port           # URL style
```

`#` lines are comments. LRU rotation is global and shared by every process via
`proxy-state.json` (auto-generated) — the longest-idle eligible proxy is picked
next; proxies that hit network errors get a 10-minute cooldown.

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

Existing rows are skipped by username/email — safe to re-run. Passwords are
stored in **plaintext** by design (this is a creds vault).

## Run

### Full pipeline — register GitHub + harvest both keys

```bash
node pipeline.mjs                          # all unregistered, sequential
FROM=user0500listingstudio TO=user0600listingstudio node pipeline.mjs   # range
node pipeline.mjs 1 user0222listingstudio  # single account (also retries keys)
```

Flow per account, one fresh browser each: `/signup` → fill → **Create account**
→ Resend OTP (8-digit launch code) → signed-in/profile-200 proof → site OAuth
(gorouter, then tabitoken) → create key (group "default") → **route-intercept**
the `/api/token/<id>/key` response → save `sk-…` key.

Parallel lanes are safe: disjoint `FROM/TO` ranges + atomic
`unregistered → in-flight` row claims + WAL mode.

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
