// actions.mjs — browser action dispatcher shared by daemon (live control) and
// run-steps.mjs (replay). One function per-command switch so recorded steps and
// live commands execute through identical code paths.
const T = 15000; // default action timeout ms

export async function run(page, cmd) {
  switch (cmd.action) {
    case 'goto':
      await page.goto(cmd.url, { waitUntil: 'domcontentloaded' });
      return { url: page.url() };
    case 'click': // auto-waits for element to be visible/actionable
      await page.click(cmd.selector, { timeout: cmd.timeout ?? T });
      return { clicked: cmd.selector, url: page.url() };
    case 'type': // clear field then send text; --enter submits after
      await page.fill(cmd.selector, cmd.text, { timeout: cmd.timeout ?? T });
      if (cmd.enter) await page.press(cmd.selector, 'Enter');
      return { typed: cmd.selector, enter: !!cmd.enter };
    case 'press':
      await page.press(cmd.selector ?? 'body', cmd.key);
      return { pressed: cmd.key };
    case 'text': // extract textContent — first match, or all matches with all:true
      return cmd.all
        ? { texts: await page.locator(cmd.selector).allTextContents() }
        : { text: await page.textContent(cmd.selector, { timeout: cmd.timeout ?? T }) };
    case 'eval': // arbitrary JS expression in page context
      return { value: await page.evaluate(cmd.expr) };
    case 'screenshot':
      await page.screenshot({ path: cmd.path ?? 'shot.png', fullPage: !!cmd.fullPage });
      return { saved: cmd.path ?? 'shot.png' };
    default:
      throw new Error(`unknown action: ${cmd.action}`);
  }
}
