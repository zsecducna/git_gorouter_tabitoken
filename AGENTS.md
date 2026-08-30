<!-- caveman-begin -->
Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
<!-- caveman-end -->

# gorouter-auto

Browser automation workspace. Language: Node.js. Not a git repo.

## Core workflow

On user request: open the given URL in CloakBrowser, then STAND BY. Do not navigate, click, or extract anything until the user gives further instructions. Keep the browser alive while waiting.

## Browser: CloakBrowser

Repo: https://github.com/CloakHQ/cloakbrowser — stealth Chromium, drop-in Playwright replacement (fingerprints patched at C++ source level).

- Install: `npm install cloakbrowser playwright-core`. Use the Playwright wrapper (default); Puppeteer wrapper exists (`cloakbrowser/puppeteer`) but its CDP leaks automation signals against reCAPTCHA Enterprise.
- First run auto-downloads ~200MB Chromium binary, cached locally.
- API:
  ```js
  import { launch, launchContext, launchPersistentContext } from 'cloakbrowser';

  const browser = await launch({ headless: false, humanize: true });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  // hold open, await user instructions — do NOT browser.close()
  ```
- Persistent profile (cookies/localStorage survive restarts): `launchPersistentContext({ userDataDir: './chrome-profile' })`.
- Options: `proxy`, `timezone`, `locale`, `args`, `humanize`, `licenseKey` (Pro binary).

## Repo state

- No package.json yet. Before first script: `npm init -y && npm install cloakbrowser playwright-core` (add `"type": "module"` for the `import` syntax above).
- `.env` holds secrets (`RESEND_API_KEY`). Never commit, never echo values.
- `resend-docs.md` — Resend inbound-email API reference (Go samples; port to Node if used).

## Tool rule files

Caveman response rules mirrored per tool: `.clinerules/`, `.cursor/rules/`, `.windsurf/rules/`, `.github/copilot-instructions.md`, `.opencode/AGENTS.md`. Keep in sync when the caveman block changes.
