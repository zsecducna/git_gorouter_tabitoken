// key-meta.mjs — print RESEND_API_KEY format metadata only (never the value).
import fs from 'node:fs';
const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);
const k = env.RESEND_API_KEY ?? '';
console.log('len=' + k.length, 'prefix=' + k.slice(0, 3), 'space=' + /\s/.test(k), 'quote=' + /["']/.test(k));
