# RESTRUCTURE-PROPOSAL — gorouter-auto root cleanup

> **STATUS: PROPOSAL ONLY — DO NOT EXECUTE YET.**
> Drafted 2026-09-01. Execution is gated on the 5 nohup backfill lanes draining.
> Nothing in this document has been applied; no file was moved or modified to
> produce it. Phase 1 items are marked "safe now"; Phases 2–3 are post-drain.

---

## 1. Why

- **Maintainability**: 17 runnable/shared `.mjs` files, 2 key-export artifacts, the
  SQLite DB, proxy list, and proxy rotation state all sit flat in the repo root.
  There is no separation between *entrypoints*, *library code*, *mutable data*, and
  *docs*.
- **Safety**: the 2026-09-01 incident (key exports committed, commit b1bbaf4)
  showed a flat layout invites accidents. A `data/` boundary that is gitignored
  wholesale — plus the already-installed pre-push hook — gives layered defense.
- **Precedent**: `capcut-tool/node/` (bin/, src/core|browser|infra|util, data/,
  config.js + config.example.js split, CONTRACTS.md, `data/` in .gitignore) is the
  accepted in-repo structure. This proposal ports that pattern to the root.

---

## 2. Current-state map (root inventory)

Legend — **Lane**: needed by the running nohup lanes (imports/path refs verified).
**Regen**: file is rewritten while lanes run (mtimes at proposal time = current
minute). **Tracked**: in git index.

| File | Kind | Role (one line) | Lane | Regen | Tracked |
|---|---|---|---|---|---|
| `backfill-keys.mjs` | entry (39KB) | Full account lifecycle pipeline — backfill worker variant; imports mail-otp; reads db/.env/proxies/proxy-state | **YES** | – | yes |
| `pipeline.mjs` | entry (44KB) | Full account lifecycle pipeline (register GitHub → harvest keys); near-duplicate of backfill-keys.mjs | **YES** | – | yes |
| `register-accounts.mjs` | entry | GitHub registration via real form navigation (DOM-driven) | **YES** | – | yes |
| `gen-accounts.mjs` | entry | Provision N `unregistered` rows into accounts.db | **YES** | – | yes |
| `gorouter-signup.mjs` | entry | Per registered account: GitHub login + gorouter.app OAuth signup. **Confirmed RUNNING: pid 85399 `node gorouter-signup.mjs user5listingstudio --keep-open`** | **YES** | – | yes |
| `gorouter-keys.mjs` | entry | Create one GoRouter API key per GitHub account (fresh browser → login → OAuth) | **YES** | – | yes |
| `sites-run.mjs` | entry | Register one GitHub account on all 4 target sites + API key each | **YES** | – | yes |
| `mail-otp.mjs` | lib | IMAP catch-all OTP reader for @duke-kr.win (imports: backfill-keys, pipeline) | **YES** | – | yes |
| `actions.mjs` | lib | Browser action dispatcher shared by daemon + run-steps replay | no | – | yes |
| `browser-daemon.mjs` | entry | Long-running CloakBrowser with HTTP control API (writes steps.jsonl) | no | runtime | yes |
| `bctl.mjs` | entry | CLI client for browser-daemon (HTTP — no file paths) | no | – | yes |
| `run-steps.mjs` | entry | Replay recorded steps.jsonl session in fresh browser | no | – | yes |
| `start-browser.mjs` | entry | Interactive CloakBrowser session driven by cmd.json | no | runtime | yes |
| `read-otp.mjs` | lib | Fetch OTP via Resend SDK, save body to otp.txt | no | – | yes |
| `key-meta.mjs` | lib | Print RESEND_API_KEY format metadata only (never the value) | no | – | yes |
| `accounts.db` | data (516KB) | SQLite — source of truth for accounts/keys | **YES** | live writes | no (ignored) |
| `gorouter-keys.txt` | data (65KB, 1251 lines) | GoRouter key export — **REGENERATES while lanes run** | **YES** | **YES** | no (ignored) |
| `tabitoken-keys.txt` | data (63KB, 1223 lines) | TabiToken key export — **REGENERATES while lanes run** | **YES** | **YES** | no (ignored) |
| `proxies.txt` | data (25 lines) | Proxy list (credentials inside; ignored) | **YES** | edited by hand | no (ignored) |
| `proxy-state.json` | data | Proxy rotation cooldown state (credentials inside; ignored; shared mutable) | **YES** | **YES** | no (ignored) |
| `.env` | config | `RESEND_API_KEY` etc. (83B — never read for this proposal) | **YES** | – | no (ignored) |
| `resend-docs.md` | doc | Resend inbound-email API reference ("List Received Emails") | no | – | yes |
| `README.md` | doc | Project doc: config (.env keys, proxies.txt formats), run commands | no | – | yes |
| `AGENTS.md` | doc | Agent instructions — **stale**: says "not a git repo" (it is now) | no | – | yes |
| `package.json` / `package-lock.json` | config | `type: module`; deps: cloakbrowser, playwright-core, imapflow, mailparser, resend | – | – | yes |
| `.gitignore` | config | Already covers: node_modules, .env, accounts.db(-*), proxy-state.json, otp.txt, *.png, steps.jsonl, proxies.txt, signup-capture.jsonl, *.log, *-keys.txt | – | – | yes |
| `capcut-tool/` | subtree | Separate sub-project (Python + structured Node port) — **untouched by this proposal** | no | – | untracked dir |
| `.clinerules/ .cursor/ .windsurf/ .github/ .opencode/` | tool rules | Caveman rule mirrors — currently **deleted in worktree** (`git status` D) | no | – | yes (deleted) |

Key mechanical fact: **every script resolves its data files relative to its own
location** (`fileURLToPath`/`__dirname` + `./accounts.db`, `./.env`,
`./proxies.txt`, `./proxy-state.json`, `./mail-otp.mjs`, `./actions.mjs`). No
`process.cwd()` dependence found. This makes moves safe *if and only if* the
relative literals are bumped — and makes a missed bump fail by silently
re-creating `accounts.db` in the wrong directory.

---

## 3. Target tree (aligned with capcut-tool/node precedent)

```
gorouter-auto/
├── bin/                          # runnable entrypoints (lanes + interactive tools)
│   ├── backfill-keys.mjs
│   ├── pipeline.mjs
│   ├── sites-run.mjs
│   ├── gorouter-signup.mjs
│   ├── gorouter-keys.mjs
│   ├── register-accounts.mjs
│   ├── gen-accounts.mjs
│   ├── browser-daemon.mjs
│   ├── bctl.mjs
│   ├── run-steps.mjs
│   └── start-browser.mjs
├── src/
│   ├── core/
│   │   └── actions.mjs           # shared action dispatcher
│   ├── browser/                  # reserved — future shared browser/session helpers
│   ├── infra/
│   │   ├── mail-otp.mjs          # IMAP catch-all OTP reader
│   │   └── read-otp.mjs          # Resend inbound OTP reader
│   └── util/
│       └── key-meta.mjs          # env-key metadata probe
├── data/                         # ALL mutable state — gitignored wholesale
│   ├── accounts.db               # (+ -wal / -shm / -journal sidecars if present)
│   ├── proxies.txt
│   ├── proxy-state.json
│   ├── gorouter-keys.txt
│   ├── tabitoken-keys.txt
│   └── (runtime: steps.jsonl, otp.txt, cmd.json, last-result.json, nohup output)
├── config/
│   ├── env.example               # documented .env template (from README §Configuration)
│   └── proxies.example.txt       # proxy format examples (no real creds)
├── docs/
│   ├── resend-docs.md
│   └── RESTRUCTURE-PROPOSAL.md   # this file moves here in Phase 2
├── CONTRACTS.md                  # layout + module contracts, capcut-tool/node style
├── .env                          # STAYS AT ROOT (dotenv convention; scripts use ../.env)
├── README.md                     # stays (run commands updated in Phase 3)
├── AGENTS.md                     # stays (repo-state section rewritten in Phase 3)
├── package.json / package-lock.json / .gitignore
├── capcut-tool/                  # untouched
└── node_modules/
```

Deliberate choices:
- `.env` stays at root: dotenv default, all 8 env-reading scripts keep a single
  well-known anchor; bin/ scripts reference `../.env`, src/ references `../../.env`.
- `data/` ignored wholesale (capcut-tool/node does exactly this) instead of
  enumerating files — future artifacts are covered automatically.
- `*-keys.txt` also kept as a root-level gitignore rule AND the pre-push hook
  stays as-is: its regex `(^|/)(gorouter|tabitoken)-keys\.txt$|…-keys\.txt$` is
  directory-agnostic, so moving key files into `data/` does **not** weaken the
  guard (verified against hook source).

---

## 4. Move list (old → new)

**Tracked files — `git mv` (history preserved):**

| Old (root) | New |
|---|---|
| `backfill-keys.mjs` | `bin/backfill-keys.mjs` |
| `pipeline.mjs` | `bin/pipeline.mjs` |
| `sites-run.mjs` | `bin/sites-run.mjs` |
| `gorouter-signup.mjs` | `bin/gorouter-signup.mjs` |
| `gorouter-keys.mjs` | `bin/gorouter-keys.mjs` |
| `register-accounts.mjs` | `bin/register-accounts.mjs` |
| `gen-accounts.mjs` | `bin/gen-accounts.mjs` |
| `browser-daemon.mjs` | `bin/browser-daemon.mjs` |
| `bctl.mjs` | `bin/bctl.mjs` |
| `run-steps.mjs` | `bin/run-steps.mjs` |
| `start-browser.mjs` | `bin/start-browser.mjs` |
| `actions.mjs` | `src/core/actions.mjs` |
| `mail-otp.mjs` | `src/infra/mail-otp.mjs` |
| `read-otp.mjs` | `src/infra/read-otp.mjs` |
| `key-meta.mjs` | `src/util/key-meta.mjs` |
| `resend-docs.md` | `docs/resend-docs.md` |
| `RESTRUCTURE-PROPOSAL.md` | `docs/RESTRUCTURE-PROPOSAL.md` (Phase 2) |

**Untracked/ignored state — plain `mv` (post-drain only):**

| Old (root) | New |
|---|---|
| `accounts.db` (+ any `-wal`/`-shm`/`-journal`) | `data/accounts.db` (+ sidecars) |
| `proxies.txt` | `data/proxies.txt` |
| `proxy-state.json` | `data/proxy-state.json` |
| `gorouter-keys.txt` | `data/gorouter-keys.txt` |
| `tabitoken-keys.txt` | `data/tabitoken-keys.txt` |

**Stay at root:** `.env`, `.gitignore`, `package.json`, `package-lock.json`,
`README.md`, `AGENTS.md`, `capcut-tool/`, `node_modules/`.

### 4.1 Import/path-fix table (do together with the moves, one commit)

All are string-literal edits inside the moved files (resolution is
`__dirname`-relative everywhere, so a `bin/` file needs one extra `../`):

| File (new path) | Literal changes |
|---|---|
| `bin/backfill-keys.mjs`, `bin/pipeline.mjs` | `./mail-otp.mjs` → `../src/infra/mail-otp.mjs`; `./accounts.db` → `../data/accounts.db`; `./.env` → `../.env`; `./proxies.txt` → `../data/proxies.txt`; `./proxy-state.json` → `../data/proxy-state.json` |
| `bin/gorouter-signup.mjs` | `./accounts.db` → `../data/accounts.db`; `./.env` → `../.env` |
| `bin/gorouter-keys.mjs`, `bin/register-accounts.mjs`, `bin/sites-run.mjs` | `./accounts.db` → `../data/accounts.db`; `./proxies.txt` → `../data/proxies.txt`; `./.env` → `../.env` |
| `bin/gen-accounts.mjs` | `./accounts.db` → `../data/accounts.db` |
| `bin/browser-daemon.mjs` | `./actions.mjs` → `../src/core/actions.mjs`; `./steps.jsonl` → `../data/steps.jsonl` |
| `bin/run-steps.mjs` | `./actions.mjs` → `../src/core/actions.mjs` |
| `bin/start-browser.mjs` | `./cmd.json`, `./last-result.json` → `../data/cmd.json`, `../data/last-result.json` |
| `src/infra/mail-otp.mjs` | `./.env` → `../../.env` |
| `src/infra/read-otp.mjs` | `.env` → `../../.env`; `otp.txt` → `../../data/otp.txt` |
| `src/util/key-meta.mjs` | `.env` → `../../.env` |
| `bin/bctl.mjs` | none (pure HTTP client) |
| `src/core/actions.mjs` | none (pure dispatcher, no file refs — safest first move) |

---

## 5. Phase plan

### Phase 1 — hygiene, SAFE NOW (no lane file is touched)
1. `.gitignore` additions: `nohup.out`, `cmd.json`, `last-result.json`,
   `data/` (pre-creating the Phase 2 ignore), plus section comments. Nothing
   tracked matches these, so `git status` stays clean.
2. Create `config/env.example` and `config/proxies.example.txt` (new files,
   documented from README §Configuration — real values never copied).
3. Create `docs/`, `git mv resend-docs.md docs/` (verified: zero script imports;
   only a comment mention in read-otp.mjs — safe while lanes run).
4. This proposal lands (Phase 1 artifact); README gets one pointer line.
5. Re-affirm pre-push hook stays untouched (path-agnostic, verified).

### Phase 2 — post-drain moves (GATE: all 5 lanes drained, see §7)
Single maintenance window, ordered:
1. Gate checks (§7A) pass: no lane processes, no open handles on
   accounts.db / key txts / proxy-state.json / .env.
2. Cold backup: `mkdir -p .backup && cp accounts.db proxy-state.json gorouter-keys.txt tabitoken-keys.txt proxies.txt .backup/` (keep until first full cycle succeeds; .backup/ must be gitignored).
3. `git mv` all tracked scripts (§4) + apply every path fix (§4.1) — one commit.
4. `mv` untracked state files into `data/` (db sidecars together with db).
5. `node --check` every moved file; smoke-run one cheap entry
   (`bin/key-meta` equivalent, `bin/gen-accounts.mjs` dry) from repo root AND
   from `$HOME` to prove cwd-independence.
6. Restart ONE lane from new path (`node bin/backfill-keys.mjs …`), confirm its
   first cycle writes land in `data/` and root stays clean (§7C), then bring up
   the remaining lanes.

### Phase 3 — shims, docs, deprecation
1. Root-level deprecation shims for legacy names (3 lines each:
   `console.warn('[deprecated] moved to bin/X.mjs')` + dynamic import), kept
   ~2–4 weeks for muscle memory / old shell history:
   `pipeline.mjs`, `backfill-keys.mjs`, `sites-run.mjs`, `gorouter-signup.mjs`,
   `gorouter-keys.mjs`, `register-accounts.mjs`, `gen-accounts.mjs`.
2. Update `README.md` run commands; rewrite `AGENTS.md` §Repo state (currently
   claims "not a git repo" — false since the incident; also the tool-rule
   mirrors are deleted in the worktree — decide re-create vs drop).
3. `package.json` scripts: add lane entrypoints
   (`"lane:backfill": "node bin/backfill-keys.mjs"`, etc.) so nohup commands
   have one canonical form; add `"type": "module"` is already set — no change.
4. Author root `CONTRACTS.md` (layout rules + module contracts, mirroring
   capcut-tool/node).
5. Follow-up (explicitly out of scope here): `pipeline.mjs` and
   `backfill-keys.mjs` are near-duplicates (44KB vs 39KB, same header) — dedupe
   into `src/core/lifecycle.mjs` with lane-specific config; centralize path
   resolution in `src/util/paths.mjs`.
6. Remove shims; final `git grep` sweep (§7C); close out.

---

## 6. Risk notes

1. **Running lanes** — node resolves static ESM imports and `__dirname` at
   startup, so renaming a `.mjs` on disk does not immediately crash a running
   lane. But any dynamic `import()` or self re-read would throw, and the lane's
   in-memory paths still point at the ROOT. Moving files under live lanes is
   still prohibited — this is the reason Phases 2–3 are post-drain.
2. **Regenerating artifacts** — `gorouter-keys.txt` (1251 lines) and
   `tabitoken-keys.txt` (1223 lines) are rewritten continuously (mtimes tracked
   the current minute during inventory). Move them while a lane lives and the
   lane re-creates them at the old root path → split-brain exports.
3. **accounts.db under a live writer** — `node:sqlite` reopens journal/WAL
   sidecars BY PATH on transactions. Moving the db while a writer is attached
   risks the journal being recreated at the old location → corruption or silent
   lost writes. Move db + `-wal`/`-shm`/`-journal` together, only when stopped.
4. **proxy-state.json split-brain** — shared mutable cooldown map across lanes;
   moving it while any proxy-consuming lane runs produces two competing states.
5. **Relative-path assumptions** — `./accounts.db`, `./.env`, `./proxies.txt`,
   `./proxy-state.json`, `./mail-otp.mjs`, `./actions.mjs` are `__dirname`-based.
   One missed `../` bump ⇒ a lane silently creates a FRESH empty
   `bin/accounts.db` (or crashes on missing `.env`). §4.1 + §7B greps are the
   countermeasure. Note `../.env` style refs from bin/ assume `.env` stays at
   root — that is pinned in §3.
6. **nohup cwd + command history** — lanes were started as
   `node <script>.mjs …` with cwd = repo root; restarts must become
   `node bin/<script>.mjs …`. `nohup.out` lands in the *launching* cwd —
   redirect explicitly (`> data/lane-<name>.log 2>&1`) so root stays clean.
   (`.gitignore` already covers `*.log`.)
7. **Tracked vs untracked** — all 17 `.mjs` + 2 `.md` are tracked ⇒ `git mv`
   keeps history; db/txt/json state files are ignored ⇒ plain `mv`; the Phase 2
   commit will therefore contain only renames + string edits, easy to review.
8. **Pre-push hook interaction** — hook blocks `*-keys.txt` by name in ANY
   directory and bulk key-line content in any added `.txt/.json`; `data/` being
   gitignored adds a second layer. No hook edit required by this proposal.
9. **Worktree drift** — `git status` shows the 5 tool-rule files deleted and
   `backfill-keys.mjs` modified; reconcile/commit BEFORE Phase 2 so the rename
   diff is not polluted.
10. **capcut-tool/** is a self-contained subtree with its own contracts —
    excluded from every phase.

---

## 7. Pre-flight checklist (greps that prove nothing references old paths)

### A. Gate — before ANY move (Phase 2 start)
```bash
# 1. No lane processes alive (expect EMPTY output)
ps -axo pid,command | grep -E 'node .*(backfill-keys|pipeline\.mjs|sites-run|gorouter-signup|gorouter-keys|register-accounts|gen-accounts)' | grep -v grep

# 2. No open handles on shared state (expect EMPTY of node PIDs)
lsof +D /Users/z/Desktop/gorouter-auto 2>/dev/null | grep -vE 'zcode|context-mode'

# 3. Cold backup taken
ls .backup/accounts.db .backup/proxy-state.json
```

### B. After path fixes, BEFORE restarting lanes
```bash
# 4. No stale sibling-relative refs remain in moved code (expect 0 hits)
grep -rn -e '\./accounts\.db' -e '\./\.env' -e '\./proxies\.txt' \
         -e '\./proxy-state\.json' -e '\./mail-otp\.mjs' -e '\./actions\.mjs' \
         -e '\./steps\.jsonl' bin/ src/

# 5. Every data/state ref now points through ../data/ or ../.env (expect 0 hits)
grep -rn -e 'accounts\.db' -e 'proxies\.txt' -e 'proxy-state\.json' \
         -e 'gorouter-keys\.txt' -e 'tabitoken-keys\.txt' -e '\.env' \
         bin/ src/ | grep -v -e '\.\./data/' -e '\.\./\.env' -e '\.\./\.\./\.env'

# 6. No cwd-dependent resolution (expect 0 hits)
grep -rn 'process\.cwd()' bin/ src/

# 7. Everything still parses
for f in bin/*.mjs src/core/*.mjs src/infra/*.mjs src/util/*.mjs; do node --check "$f" || echo "SYNTAX FAIL: $f"; done
```

### C. After first restarted cycle — acceptance
```bash
# 8. Root stays clean: old names must NOT reappear (expect all "No such file")
ls accounts.db gorouter-keys.txt tabitoken-keys.txt proxies.txt proxy-state.json 2>&1

# 9. Regeneration landed in data/ (mtimes bump)
ls -la data/

# 10. No stale run-commands or old paths left in docs/config
git grep -nE '(^|[ /`(])(pipeline|backfill-keys|sites-run|gorouter-signup|gorouter-keys|register-accounts|gen-accounts)\.mjs' -- '*.md' '*.json' ':!capcut-tool' ':!RESTRUCTURE-PROPOSAL.md'

# 11. Clean tree, intended renames only
git status --short
```

---

## 8. Out of scope

- Purging the leaked key exports from git *history* (incident b1bbaf4) — hook
  only guards future pushes; a separate `git filter-repo`/BFG decision.
- pipeline/backfill dedupe, shared `src/util/paths.mjs`, tests, CI.
- Any change inside `capcut-tool/`.

*End of proposal. Do not execute until the five lanes drain and §7A passes.*
