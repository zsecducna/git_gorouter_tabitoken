// bctl.mjs — CLI client for browser-daemon. Usage examples:
//   node bctl.mjs state
//   node bctl.mjs goto https://github.com
//   node bctl.mjs click 'a[href="/signup"]'
//   node bctl.mjs type '#email' 'me@example.com' enter
//   node bctl.mjs text 'h1' all
//   node bctl.mjs eval 'document.title'
//   node bctl.mjs shot page.png
//   node bctl.mjs steps | clear
const D = 'http://localhost:8765';
const [action, ...rest] = process.argv.slice(2);

// buildRequest — map CLI args to (method, path, body) per action word
function buildRequest() {
  switch (action) {
    case 'state':  return { method: 'GET', path: '/state' };
    case 'steps':  return { method: 'GET', path: '/steps' };
    case 'clear':  return { method: 'DELETE', path: '/steps' };
    case 'goto':   return { method: 'POST', path: '/cmd', body: { action: 'goto', url: rest[0] } };
    case 'click':  return { method: 'POST', path: '/cmd', body: { action: 'click', selector: rest[0] } };
    case 'type':   return { method: 'POST', path: '/cmd', body: { action: 'type', selector: rest[0], text: rest[1], enter: rest.includes('enter') } };
    case 'press':  return { method: 'POST', path: '/cmd', body: { action: 'press', key: rest[0] } };
    case 'text':   return { method: 'POST', path: '/cmd', body: { action: 'text', selector: rest[0], all: rest.includes('all') } };
    case 'eval':   return { method: 'POST', path: '/cmd', body: { action: 'eval', expr: rest[0] } };
    case 'shot':   return { method: 'POST', path: '/cmd', body: { action: 'screenshot', path: rest[0] ?? 'shot.png' } };
    default: throw new Error(`unknown command: ${action}`);
  }
}

const { method, path, body } = buildRequest();
const res = await fetch(D + path, {
  method,
  headers: body ? { 'content-type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
});
console.log(JSON.stringify(await res.json(), null, 2));
