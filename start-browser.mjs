// start-browser.mjs — CloakBrowser session with command-file control loop.
// Usage: node start-browser.mjs [url]
// Control: write JSON to ./cmd.json  →  { "action": "goto|click|type|press|text|eval|screenshot", ... }
// Result of last command lands in ./last-result.json. Browser stays open (core workflow: stand by).
import { launch } from 'cloakbrowser';
import fs from 'node:fs';

const CMD = new URL('./cmd.json', import.meta.url).pathname;
const OUT = new URL('./last-result.json', import.meta.url).pathname;

// Stealth Chromium, visible + humanized input (workspace default).
const browser = await launch({ headless: false, humanize: true });
const page = await browser.newPage();

// Initial navigation from argv (default blank), then hand control to command loop.
const url = process.argv[2] ?? 'about:blank';
await page.goto(url, { waitUntil: 'domcontentloaded' });
console.log(`[start-browser] Goto ${url} done. Command loop armed.`);

// Execute one parsed command; every branch returns a JSON-serializable result.
async function run(cmd) {
  switch (cmd.action) {
    case 'goto':
      await page.goto(cmd.url, { waitUntil: 'domcontentloaded' });
      return { url: page.url() };
    case 'click': // selector click, auto-wait for element to be actionable
      await page.click(cmd.selector, { timeout: cmd.timeout ?? 15000 });
      return { clicked: cmd.selector, url: page.url() };
    case 'type': // clear field then send text (optionally press Enter after)
      await page.fill(cmd.selector, cmd.text, { timeout: cmd.timeout ?? 15000 });
      if (cmd.enter) await page.press(cmd.selector, 'Enter');
      return { typed: cmd.selector, enter: !!cmd.enter };
    case 'press':
      await page.press(cmd.selector ?? 'body', cmd.key);
      return { pressed: cmd.key };
    case 'text': // extract textContent of first match (or all with all:true)
      return cmd.all
        ? { texts: await page.locator(cmd.selector).allTextContents() }
        : { text: await page.textContent(cmd.selector, { timeout: cmd.timeout ?? 15000 }) };
    case 'eval': // run arbitrary JS expression in page context
      return { value: await page.evaluate(cmd.expr) };
    case 'screenshot':
      await page.screenshot({ path: cmd.path ?? 'shot.png', fullPage: !!cmd.fullPage });
      return { saved: cmd.path ?? 'shot.png' };
    default:
      return { error: `unknown action: ${cmd.action}` };
  }
}

// Poll for ./cmd.json; consume (delete) before executing so one file = one run,
// then report outcome in ./last-result.json. Errors captured, loop never dies.
fs.writeFileSync(OUT, JSON.stringify({ ready: true, url: page.url() }));
setInterval(async () => {
  if (!fs.existsSync(CMD)) return;
  let cmd;
  try {
    cmd = JSON.parse(fs.readFileSync(CMD, 'utf8'));
    fs.unlinkSync(CMD);
  } catch {
    return; // half-written file — skip, next poll retries
  }
  console.log(`[start-browser] cmd: ${cmd.action}`);
  try {
    fs.writeFileSync(OUT, JSON.stringify({ ok: true, ...(await run(cmd)) }));
  } catch (e) {
    fs.writeFileSync(OUT, JSON.stringify({ ok: false, error: String(e).split('\n')[0] }));
  }
}, 500);

// Keep process alive — never browser.close() in stand-by mode.
setInterval(() => {}, 1 << 30);
