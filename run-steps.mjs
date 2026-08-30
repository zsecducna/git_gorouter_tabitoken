// run-steps.mjs — replay a recorded session (steps.jsonl) in a FRESH browser.
// This is the automation artifact: record interactively via daemon + bctl, replay headlessly or headed.
// Usage: node run-steps.mjs [steps.jsonl]
import { launch } from 'cloakbrowser';
import fs from 'node:fs';
import { run } from './actions.mjs';

const file = process.argv[2] ?? 'steps.jsonl';
const steps = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
console.log(`[replay] ${steps.length} steps from ${file}`);

const browser = await launch({ headless: false, humanize: true });
const page = await browser.newPage();

for (const { action, ts, ok, ...cmd } of steps) {
  if (!ok) { console.log(`[replay] skip failed-recorded: ${action}`); continue; }
  try {
    await run(page, { action, ...cmd });
    console.log(`[replay] ok: ${action} ${cmd.url ?? cmd.selector ?? cmd.key ?? ''}`);
  } catch (e) {
    console.log(`[replay] FAIL: ${action} — ${String(e).split('\n')[0]}`);
  }
}

await browser.close(); // replay runs are disposable, unlike the stand-by daemon
