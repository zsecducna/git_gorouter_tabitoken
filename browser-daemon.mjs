// browser-daemon.mjs — long-running CloakBrowser with HTTP control API.
// Usage: node browser-daemon.mjs [start-url]
//
// Endpoints (http://localhost:8765):
//   GET    /state   → { ready, url, title }
//   POST   /cmd     → body {action,...} or {cmds:[...]} — executes, records, returns result
//   GET    /steps   → recorded steps so far
//   DELETE /steps   → clear recording
//
// Every successful command is appended to ./steps.jsonl — replay it later with
// run-steps.mjs to turn an interactive session into automation. No restarts needed.
import { launch } from 'cloakbrowser';
import http from 'node:http';
import fs from 'node:fs';
import { run } from './actions.mjs';

const PORT = 8765;
const STEPS = new URL('./steps.jsonl', import.meta.url).pathname;

// Surface any death cause in the log — silent daemon exit is undebuggable otherwise.
process.on('uncaughtException', (e) => console.error('[daemon] uncaught:', e));
process.on('unhandledRejection', (e) => console.error('[daemon] rejection:', e));

// Stealth Chromium, visible + humanized (workspace default). Holds open forever.
const browser = await launch({ headless: false, humanize: true });
const page = await browser.newPage();
const startUrl = process.argv[2] ?? 'about:blank';
await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

// appendStep — persist one executed command to steps.jsonl (the automation recording)
function appendStep(cmd, ok) {
  fs.appendFileSync(STEPS, JSON.stringify({ ts: Date.now(), ...cmd, ok }) + '\n');
}

// readBody — buffer a JSON request body
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// respond — send JSON and close
function respond(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// server — route table for the control API; run() errors surface as {ok:false}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/state')
      return respond(res, 200, { ready: true, url: page.url(), title: await page.title() });

    if (req.method === 'POST' && req.url === '/cmd') {
      const body = await readBody(req);
      const cmds = body.cmds ?? [body]; // batch = sequential on same live page
      const results = [];
      for (const cmd of cmds) {
        try {
          const result = await run(page, cmd);
          appendStep(cmd, true);
          results.push({ ok: true, ...result });
        } catch (e) {
          appendStep(cmd, false);
          results.push({ ok: false, error: String(e).split('\n')[0] });
        }
      }
      return respond(res, 200, { results, url: page.url() });
    }

    if (req.method === 'GET' && req.url === '/steps')
      return respond(res, 200, { steps: fs.existsSync(STEPS) ? fs.readFileSync(STEPS, 'utf8').trim().split('\n').map(JSON.parse) : [] });

    if (req.method === 'DELETE' && req.url === '/steps') {
      if (fs.existsSync(STEPS)) fs.unlinkSync(STEPS);
      return respond(res, 200, { cleared: true });
    }

    respond(res, 404, { error: 'unknown route' });
  } catch (e) {
    respond(res, 500, { error: String(e).split('\n')[0] });
  }
});

server.listen(PORT, () =>
  console.log(`[daemon] up on :${PORT} — at ${page.url()}. Recording to steps.jsonl.`)
);

// If browser dies (user closes window, crash) log it — loop stays up for diagnosis.
browser.on('disconnected', () => console.error('[daemon] browser disconnected'));

// Keep alive — never browser.close() while standing by.
setInterval(() => {}, 1 << 30);
