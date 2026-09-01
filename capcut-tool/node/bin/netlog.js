#!/usr/bin/env node
// netlog CLI — port of netlog.py main(): record capcut.com traffic while you
// browse a GPM profile by hand, or summarize an existing .jsonl capture.
//
// Records capture FULL credentials (cookies, Authorization) — see the warning
// in src/browser/netlog.js. Do not share .jsonl files.

import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { watch, summarize } from '../src/browser/netlog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: node bin/netlog.js [flags]

Watch capcut.com network requests (manual browsing is recorded).

  --out <file>         .jsonl file to record (default netlog/capcut-<timestamp>.jsonl)
  --seconds <n>        auto-stop after n seconds (0 = wait for Ctrl+C)
  --all                also record images/css/fonts (skipped by default)
  --profile <name>     stealth profile dir name to watch with (CloakBrowser)
  --url <url>          opening page (default: the login page)
  --keep-profile       keep the profile after stopping (next session stays logged in)
  --summary <file>     only print a summary of an existing .jsonl file
  --show-body          with --summary: also print payloads & responses
  --only <substr>      with --summary: only show URLs containing this substring

Note: python's --email/--password pre-login shortcut is not ported yet
(needs the capcut-api login helper, step 2+). Log in by hand instead.
`;

// CLI entry: parse flags (python argparse parity), then dispatch to
// summarize() or watch(). Exits 2 on bad flags (argparse behavior), 1 on
// runtime errors with the message on stderr.
async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        out: { type: 'string' },
        seconds: { type: 'string', default: '0' },
        all: { type: 'boolean', default: false },
        profile: { type: 'string' },
        url: { type: 'string' },
        'keep-profile': { type: 'boolean', default: false },
        summary: { type: 'string' },
        'show-body': { type: 'boolean', default: false },
        only: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    console.error(String(err.message));
    console.error(USAGE);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  if (values.summary) {
    await summarize(values.summary, { showBody: values['show-body'], only: values.only });
    return 0;
  }

  const seconds = Number.parseInt(values.seconds, 10);
  if (Number.isNaN(seconds) || seconds < 0) {
    console.error(`--seconds must be a non-negative integer, got: ${values.seconds}`);
    process.exit(2);
  }

  let out = values.out;
  if (!out) {
    // Default: netlog/capcut-YYYYMMDD-HHMMSS.jsonl next to this script
    // (python used the script's directory the same way).
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
      `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    out = path.join(__dirname, 'netlog', `capcut-${stamp}.jsonl`);
  }

  await watch(out, {
    seconds,
    includeStatic: values.all,
    profile: values.profile,
    startUrl: values.url,
    keepProfile: values['keep-profile'],
  });
  console.log(`\nView summary:  node bin/netlog.js --summary ${out} --show-body`);
  return 0;
}

// Run only when executed directly (node netlog.js ...); importing this module
// (e.g. for tests) must stay side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  });
}
