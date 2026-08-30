// capture-signup.mjs — open CloakBrowser at github signup, user completes the
// flow MANUALLY, every request/response is logged to signup-capture.jsonl
// (method, url, status, resource type, post data, response set-cookie headers).
// Script exits when you close the browser window.
import { launch } from 'cloakbrowser';
import fs from 'node:fs';

const OUT = new URL('./signup-capture.jsonl', import.meta.url).pathname;
fs.writeFileSync(OUT, '');

// logReq — append one structured traffic record
function logReq(rec) {
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
}

// skip noise — static assets we don't need for API analysis
const NOISE = /\.(png|jpe?g|gif|svg|woff2?|ttf|css|ico|mp4|webm)(\?|$)/i;
const NOISE_HOST = /^(\w+\.)?(google-analytics|googletagmanager|doubleclick|github\.githubusercontent\.com|collector\.github\.com)\b/i;

const browser = await launch({ headless: false, humanize: true });
const page = await browser.newPage();
await page.goto('https://github.com/', { waitUntil: 'domcontentloaded' });

page.on('request', (req) => {
  const u = req.url();
  if (NOISE.test(u) || NOISE_HOST.test(u)) return;
  logReq({
    ts: Date.now(), dir: 'req', method: req.method(), url: u,
    resource: req.resourceType(),
    headers: req.headers(),
    post: req.postData() ?? null,
  });
});

page.on('response', (res) => {
  const u = res.url();
  if (NOISE.test(u) || NOISE_HOST.test(u)) return;
  logReq({
    ts: Date.now(), dir: 'res', method: res.request().method(), url: u,
    status: res.status(),
    setCookie: res.headers()['set-cookie'] ?? null,
    location: res.headers()['location'] ?? null,
  });
});

console.log('[capture] browser ready — complete the signup manually. Logging to signup-capture.jsonl');browser.on('disconnected', () => {
  console.log('[capture] browser closed — capture done');
  process.exit(0);
});
setInterval(() => {}, 1 << 30); // hold open until user closes window
