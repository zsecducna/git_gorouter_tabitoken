// Browser layer for the CapCut tool — CloakBrowser (stealth Chromium, Playwright API).
//
// Replaces the original GPMLogin + connectOverCDP stack (swapped 2026-09-01):
// every account gets its OWN throwaway stealth profile via
// launchPersistentContext({ userDataDir }) with an optional per-account proxy,
// locale/timezone pinned to Vietnam, and the profile directory deleted after
// the run when DELETE_PROFILE_AFTER is on (python's fresh-GPM-profile-per-account
// semantics, minus the external Windows app).
//
// History note: GPM needed process-wide serialized profile starts because ~10
// simultaneous opens corrupted the DevToolsActivePort file (IO_SharingViolation,
// 4/10 threads dead, measured 03:30 2026-08-31). CloakBrowser launches its own
// Chromium per call — no shared port file, no mutex needed.
//
// Interaction still goes through human-input.js (CDP Input domain events,
// isTrusted:true) — same rule as python: never synthetic el.click().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPersistentContext } from 'cloakbrowser';
import { toPlaywrightProxy } from '../util/proxy.js';
import { sleep, randFloat } from '../util/util.js';

const PKG_ROOT = path.dirname(fileURLToPath(new URL('../../', import.meta.url)));

// User pressed Stop -> exit the worker gracefully.
export class StopRequested extends Error {
  constructor(message = 'Stop requested') {
    super(message);
    this.name = 'StopRequested';
  }
}

// Default stop-check: never stop.
export function defaultShouldStop() {
  return false;
}

// Throw StopRequested when the caller's shouldStop flag is set.
export function checkStop(shouldStop) {
  if (shouldStop && shouldStop()) {
    throw new StopRequested();
  }
}

// Read the page's current URL ('' on evaluation failure — e.g. mid-navigation).
export async function currentUrl(page) {
  try {
    return (await page.evaluate('location.href')) || '';
  } catch {
    return '';
  }
}

// Wait for `document.readyState == 'complete'`, then a short natural settle.
// Replaces a hard sleep after each navigate. Evaluate can throw mid-navigation
// — swallow and retry, like python did. Returns true when loaded within `timeout`.
export async function waitForDomReady(page, { timeout = 15, settle = [0.3, 0.7] } = {}) {
  const deadline = Date.now() + timeout * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    try {
      if ((await page.evaluate('document.readyState')) === 'complete') {
        ok = true;
        break;
      }
    } catch { // navigating -> evaluate fails, retry
    }
    await sleep(150);
  }
  await sleep(randFloat(settle[0], settle[1]) * 1000);
  return ok;
}

// Pick the real WEB page/tab to drive inside OUR OWN context.
// DevTools tabs (devtools://) must never win — every later command would run
// against DevTools. Prefer http/https pages, then non-devtools, then page[0].
export function pickTab(context) {
  const pages = context.pages();
  const urlOf = (p) => String(p.url() || '');
  return (
    pages.find((p) => urlOf(p).startsWith('http')) ||
    pages.find((p) => !urlOf(p).startsWith('devtools://')) ||
    pages[0] ||
    null
  );
}

// Launch one throwaway stealth browser for a single account.
// `name` names the profile dir (account username, or 'netlog-watch' for the
// manual capture CLI). `rawProxy` accepts every format from util/proxy.js
// ('ip:port:user:pass' included) — undefined/null = machine IP.
// Returns { browser, context, page, profileDir, close() }; the caller MUST
// close it in a `finally` via close() (or closeBrowser).
export async function openBrowser(settings, { name = 'capcut', rawProxy = null, log = console.log, shouldStop = null } = {}) {
  checkStop(shouldStop);

  const root = settings.PROFILE_ROOT
    ? path.resolve(PKG_ROOT, settings.PROFILE_ROOT)
    : path.join(PKG_ROOT, 'data', 'profiles');
  const profileDir = path.join(root, `${name}-${Date.now()}`);
  fs.mkdirSync(profileDir, { recursive: true });

  if (settings.KIOT_ENABLED) {
    log('[i] KIOT_ENABLED=true but KiotProxy is not ported yet (step 1) — using the static proxy.');
  }
  if (settings.ROTATE_PROXY) {
    log('[i] Proxy rotation not ported yet (step 1) — proceeding with the static proxy.');
  }

  const opts = {
    userDataDir: profileDir,
    headless: settings.HEADLESS ?? false,
    humanize: settings.HUMANIZE ?? true,
    locale: settings.BROWSER_LOCALE ?? 'vi-VN',
    timezoneId: settings.BROWSER_TIMEZONE ?? 'Asia/Ho_Chi_Minh',
    viewport: { width: 1280, height: 900 }, // python GPM window_size default
  };
  // CAPCUT_BROWSER=chrome — run the flow in the REAL Google Chrome instead of
  // the stealth-patched CloakBrowser binary. Credit-attribution experiment
  // (2026-09-02): python's identical flow (same email domain, same API
  // payloads) got task credits from GPM Chromium; CloakBrowser accounts get
  // tasks marked done with 0 credit on every path — bytedance risk scores the
  // device fingerprint (webmssdk) before granting, and the stealth patching
  // itself can be the low-trust signal. CapCut never blocks us, so for THIS
  // site an unpatched Chrome may score better.
  if (process.env.CAPCUT_BROWSER === 'chrome') {
    opts.channel = 'chrome';
    log(`[i] Browser override: REAL Google Chrome (channel 'chrome'), no stealth patching.`);
  }
  const proxy = toPlaywrightProxy(rawProxy ?? settings.RAW_PROXY ?? null);
  if (proxy) {
    opts.proxy = proxy;
    log(`[i] Stealth browser launching (profile ${path.basename(profileDir)}, proxy ${proxy.server}) ...`);
  } else {
    log(`[i] Stealth browser launching (profile ${path.basename(profileDir)}, machine IP — no proxy) ...`);
  }

  // Transient launch failures (resource contention with N sibling browsers)
  // get a short retry — same spirit as python's GPM-busy retry loop.
  let context = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3 && !context; attempt++) {
    try {
      context = await launchPersistentContext(opts);
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        const wait = 2 * (attempt + 1);
        log(`[i] Browser launch failed (${String(e && e.message || e).slice(0, 80)}) — retry in ${wait}s`);
        await sleep(wait * 1000);
      }
    }
  }
  if (!context) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch { /* best effort cleanup */ }
    throw new Error(`CloakBrowser failed to launch after 3 attempts: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
  }

  let page = pickTab(context);
  if (!page) {
    page = await context.newPage();
  }
  // Capture the pristine native fetch BEFORE any page SDK replaces it, and
  // wrap the SDK's hook with a native fallback once it installs.
  // Measured 2026-09-02: through the zingproxy gateways, CapCut's SDK fetch
  // hook — once fully initialized — breaks CROSS-ORIGIN credentialed requests
  // (TypeError) for both our API calls and the page's OWN login/signup flows
  // (the email-continue check stalls the whole UI). Direct connections never
  // see this. The fallback re-runs the request on the native fetch: same
  // request, unsigned — passport/task endpoints accept that (verified).
  await context.addInitScript(`
    if (!window.__nativeFetch) {
      window.__nativeFetch = window.fetch.bind(window);
      let wrapped = false;
      const wrap = () => {
        if (wrapped || window.fetch === window.__nativeFetch) return;
        const hooked = window.fetch;
        window.fetch = (...args) => hooked(...args).catch((e) => {
          if (e instanceof TypeError) return window.__nativeFetch(...args);
          throw e;
        });
        wrapped = true;
      };
      setInterval(() => { try { wrap(); } catch {} }, 500);
    }
  `);
  const browser = context.browser();
  return {
    browser,
    context,
    page,
    profileDir,
    close: () => closeBrowser({ browser, context, profileDir }, { log, settings }),
  };
}

// Close the browser and (when DELETE_PROFILE_AFTER) wipe its profile dir.
// Never throws outward. `handle` is what openBrowser returned (partial ok).
export async function closeBrowser(handle, { log = console.log, settings = null } = {}) {
  if (!handle) return;
  try {
    if (handle.context) {
      await handle.context.close(); // persistent context: closing = killing Chromium
    } else if (handle.browser) {
      await handle.browser.close();
    }
  } catch (e) {
    log(`[!] Browser close hiccup (ignored): ${e && e.message ? e.message : e}`);
  }
  const wipe = settings ? settings.DELETE_PROFILE_AFTER !== false : true;
  if (handle.profileDir && wipe) {
    try {
      fs.rmSync(handle.profileDir, { recursive: true, force: true });
    } catch (e) {
      log(`[!] Could not delete profile dir ${handle.profileDir}: ${e && e.message ? e.message : e}`);
    }
  }
}
