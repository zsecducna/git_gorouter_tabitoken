// HumanInput — port of human_input.py (HumanClicker) onto a Playwright page.
//
// Human-like mouse & keyboard simulation through the CDP Input domain.
// Playwright page.mouse / page.keyboard drive the very same Input domain the
// Python tool drove with pychrome, so the browser still treats every event as
// real hardware input (isTrusted=true, not detectable as automation).
//
// NEVER use:
//   - el.click()                            -> isTrusted=false, easily detected
//   - el.value = x / nativeInputValueSetter -> React / anti-bot flags it
//   - el.dispatchEvent(new Event(...))      -> isTrusted=false
//   - window.xxx globals                    -> fingerprint scripts notice
//
// JavaScript is used only minimally (anonymous IIFEs) to READ element
// positions — nothing is stored on window, no DOM mutation, no traces left.

// windowsVirtualKeyCode -> Playwright key name. Used to resolve the raw VK
// codes the Python callers passed (vk=65 etc.) into Playwright key names.
export const VK_MAP = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Control',
  18: 'Alt', 19: 'Pause', 20: 'CapsLock', 27: 'Escape', 32: 'Space',
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
  37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
  45: 'Insert', 46: 'Delete',
  91: 'Meta', 92: 'Meta', 93: 'ContextMenu',
  106: 'NumpadMultiply', 107: 'NumpadAdd', 109: 'NumpadSubtract',
  110: 'NumpadDecimal', 111: 'NumpadDivide',
  186: 'Semicolon', 187: 'Equal', 188: 'Comma', 189: 'Minus', 190: 'Period',
  191: 'Slash', 192: 'Backquote', 219: 'BracketLeft', 220: 'Backslash',
  221: 'BracketRight', 222: 'Quote',
};
for (let i = 48; i <= 57; i++) VK_MAP[i] = String(i - 48); // 0-9
for (let i = 65; i <= 90; i++) VK_MAP[i] = String.fromCharCode(i + 32); // a-z
for (let i = 96; i <= 105; i++) VK_MAP[i] = `Numpad${i - 96}`;
for (let i = 112; i <= 123; i++) VK_MAP[i] = `F${i - 111}`;

// CDP physical-key code -> Playwright key name (KeyA -> a, Digit1 -> 1, ...).
export const CODE_MAP = {};
for (let i = 0; i <= 9; i++) CODE_MAP[`Digit${i}`] = String(i);
for (let i = 0; i < 26; i++) CODE_MAP[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(97 + i);
for (const n of [
  'Backspace', 'Tab', 'Enter', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock',
  'Escape', 'Space', 'PageUp', 'PageDown', 'End', 'Home', 'ArrowLeft',
  'ArrowUp', 'ArrowRight', 'ArrowDown', 'Insert', 'Delete', 'ContextMenu',
  'NumLock', 'ScrollLock', 'Pause', 'PrintScreen',
]) CODE_MAP[n] = n;
for (let i = 1; i <= 12; i++) CODE_MAP[`F${i}`] = `F${i}`;

// Escape a CSS selector for safe embedding inside a single-quoted JS string.
function safeSelector(selector) {
  return selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class HumanInput {
  // CDP-based human-like mouse & keyboard simulation on a Playwright page.
  // Tracks a virtual cursor position (mx, my) so bezier moves always start
  // from wherever the "hand" last rested, exactly like the Python tool.
  constructor(page) {
    if (!page) throw new Error('HumanInput: a Playwright page is required');
    this.page = page;
    // randint(350,700)/randint(200,500) at construction — inline Math.random
    // because the shared util module is loaded lazily (async) and the
    // constructor must stay synchronous.
    this.mx = 350 + Math.floor(Math.random() * 351);
    this.my = 200 + Math.floor(Math.random() * 301);
  }

  _utilMemo = null;

  // Lazily import the shared helpers (sleep/randInt/randFloat). Lazy so this
  // module stays import-safe while src/util/util.js may still be landing from
  // another agent's work stream; memoized so the import happens once.
  async _util() {
    this._utilMemo ??= import('../util/util.js');
    return this._utilMemo;
  }

  // Evaluate a read-only JS expression in the page with a 10s timeout.
  // Python wrapped every CDP call in _timeout=10; the race keeps that safety
  // net. On timeout the underlying evaluate is abandoned (its late result is
  // ignored), exactly like a pychrome call that times out.
  async _eval(js, timeoutMs = 10000) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('HumanInput: page.evaluate timed out')), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.page.evaluate(js), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Viewport rect of the first element matching `selector`; null when missing,
  // disabled, aria-disabled, or invisible. Anonymous IIFE — leaves no trace.
  async _rect(selector) {
    const safe = safeSelector(selector);
    // A disabled button still renders but a real click is dropped by the
    // browser -> treat it as not-yet-clickable (so wait_for can wait for it
    // to become enabled).
    const js =
      `(()=>{let e=document.querySelector('${safe}');` +
      `if(!e)return null;` +
      `if(e.disabled||e.getAttribute('aria-disabled')==='true')return null;` +
      `let r=e.getBoundingClientRect(),s=getComputedStyle(e);` +
      `if(r.width<1||r.height<1||s.visibility==='hidden'||s.display==='none')return null;` +
      `return{x:r.x,y:r.y,w:r.width,h:r.height}})()`;
    return (await this._eval(js)) ?? null;
  }

  // Try each selector in order; return [selector, rect] of the first visible
  // one, or [null, null]. Accepts a single selector string or an array.
  async _find(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      const rect = await this._rect(sel);
      if (rect) return [sel, rect];
    }
    return [null, null];
  }

  // Scroll the element into the viewport when it sits above/below the fold.
  // Returns true when a scroll happened. scrollIntoView does not mutate the
  // DOM and leaves no fingerprint trace.
  async _scrollIntoView(selector) {
    const safe = safeSelector(selector);
    const js =
      `(()=>{let e=document.querySelector('${safe}');` +
      `if(!e)return false;` +
      `let r=e.getBoundingClientRect();` +
      `if(r.top<40||r.bottom>innerHeight-40){` +
      `e.scrollIntoView({block:'center',inline:'nearest'});return true}` +
      `return false})()`;
    return Boolean(await this._eval(js));
  }

  // Rects of ALL elements matching `selector`, each flagged `vis` when at
  // least 1x1 px. Read-only; used by fillCode for split digit boxes.
  async _rectsAll(selector) {
    const safe = safeSelector(selector);
    const js =
      `(()=>Array.from(document.querySelectorAll('${safe}')).map(e=>{` +
      `let r=e.getBoundingClientRect();` +
      `return{x:r.x,y:r.y,w:r.width,h:r.height,` +
      `vis:(r.width>=1&&r.height>=1)}}))()`;
    return (await this._eval(js)) || [];
  }

  // Cubic bezier path from (x0,y0) to (x1,y1) with randomized control points
  // and smoothstep easing — ported 1:1 from the Python math.
  async _bezier(x0, y0, x1, y1) {
    const { randFloat } = await this._util();
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(10, Math.min(40, Math.trunc(dist / 10)));
    const dx = x1 - x0, dy = y1 - y0;
    const cx1 = x0 + dx * randFloat(0.12, 0.42) + randFloat(-50, 50);
    const cy1 = y0 + dy * randFloat(0.0, 0.35) + randFloat(-30, 30);
    const cx2 = x0 + dx * randFloat(0.55, 0.88) + randFloat(-50, 50);
    const cy2 = y0 + dy * randFloat(0.65, 1.0) + randFloat(-30, 30);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      let t = i / steps;
      t = t * t * (3 - 2 * t); // smoothstep easing
      const u = 1 - t;
      const px = u ** 3 * x0 + 3 * u ** 2 * t * cx1 + 3 * u * t ** 2 * cx2 + t ** 3 * x1;
      const py = u ** 3 * y0 + 3 * u ** 2 * t * cy1 + 3 * u * t ** 2 * cy2 + t ** 3 * y1;
      pts.push([px, py]);
    }
    return pts;
  }

  // Move the mouse along a bezier curve to (x, y), one mouseMoved event per
  // point with a 3-15 ms human jitter between steps. Coordinates are rounded
  // to ints, same as the Python Input.dispatchMouseEvent wrapper.
  async move(x, y) {
    const { sleep, randInt } = await this._util();
    for (const [px, py] of await this._bezier(this.mx, this.my, x, y)) {
      await this.page.mouse.move(Math.round(px), Math.round(py));
      await sleep(randInt(3, 15));
    }
    this.mx = x;
    this.my = y;
  }

  // Move the mouse to (x, y) then click with natural press/release timing.
  // mouse.down/up at the current position == mousePressed/mouseReleased with
  // clickCount=1 in the Python CDP wrapper.
  async clickXY(x, y) {
    const { sleep, randInt } = await this._util();
    await this.move(x, y);
    await sleep(randInt(40, 130));
    await this.page.mouse.down({ clickCount: 1 });
    await sleep(randInt(40, 100));
    await this.page.mouse.up({ clickCount: 1 });
  }

  // Click the first visible element among `selectors`; returns the matched
  // selector or null. Scrolls the element into view first (the 'Create
  // account' button sits at the end of a long form and is often below the
  // fold -> clicking by a stale rect lands outside the viewport).
  async click(selectors) {
    const { sleep, randInt, randFloat } = await this._util();
    const found = await this._find(selectors);
    const sel = found[0];
    let rect = found[1];
    if (!rect) return null;
    if (await this._scrollIntoView(sel)) {
      await sleep(randInt(250, 550));
      rect = (await this._rect(sel)) || rect;
    }
    const padX = Math.max(3, rect.w * 0.13);
    const padY = Math.max(3, rect.h * 0.13);
    const x = rect.x + randFloat(padX, rect.w - padX);
    const y = rect.y + randFloat(padY, rect.h - padY);
    await this.clickXY(x, y);
    return sel;
  }

  // Current window.scrollY as an int (rounded).
  async _scrollY() {
    const v = await this._eval('Math.round(window.scrollY)');
    return Number.isFinite(v) ? v : 0;
  }

  // Scroll at the current cursor position with a real wheel event.
  // A mouseMoved is dispatched BEFORE the wheel: when the pointer has never
  // entered the viewport Chrome may not ack the wheel dispatch (the Python
  // tool saw pychrome TimeoutExceptions although the event still arrived), so
  // both dispatches are best-effort and never fatal — callers verify via
  // scrollY whether the page actually scrolled.
  async scroll(deltaY = 300) {
    const { sleep, randInt } = await this._util();
    try {
      await this.page.mouse.move(this.mx, this.my);
    } catch { /* cursor move failed (page navigating) — try the wheel anyway */ }
    try {
      await this.page.mouse.wheel(0, deltaY);
    } catch { /* wheel not acked — caller checks scrollY */ }
    await sleep(randInt(100, 300));
  }

  // Scroll to the bottom of the page with REAL wheel events; if the wheel has
  // no effect, fall back to the End key (also a real-human action, and it
  // always works over CDP). The /signup 'Create account' button sits below
  // the fold until scrolled. Returns the final scrollY.
  async scrollToBottom(maxSteps = 12) {
    const { sleep, randInt, randFloat } = await this._util();
    // Park the cursor in the middle-ish of the viewport so the wheel bites.
    const vp = (await this._eval('(()=>({w:innerWidth,h:innerHeight}))()')) || {};
    await this.move((vp.w ?? 1000) * randFloat(0.4, 0.6), (vp.h ?? 800) * randFloat(0.4, 0.6));

    let last = await this._scrollY();
    for (let i = 0; i < maxSteps; i++) {
      await this.scroll(randInt(220, 420));
      const cur = await this._scrollY();
      if (cur === last) break; // cannot scroll further -> bottom, or wheel ignored
      last = cur;
      await sleep(randInt(100, 250));
    }

    if (last === 0) {
      // Wheel had no effect -> press End (a real human does this too).
      await this.pressKey('End', { code: 'End', vk: 35 });
      await sleep(randInt(500, 900));
      last = await this._scrollY();
    }
    return last;
  }

  // Fill a verification code. Supports both a MERGED box (single input:
  // click then type the whole string) and SPLIT boxes (one digit per box,
  // like the 8-box GitHub 'launch code' screen): click each box and type one
  // digit — never rely on auto-advance, and number inputs ignore maxlength
  // so dumping everything into one box is error-prone. Returns true when
  // the code was entered.
  async fillCode(selectors, code) {
    const { sleep, randInt, randFloat } = await this._util();
    const sels = Array.isArray(selectors) ? selectors : [selectors];
    let sel = null;
    for (const s of sels) {
      if (await this._rect(s)) { sel = s; break; }
    }
    if (!sel) return false;
    await this._scrollIntoView(sel);
    await sleep(randInt(200, 500));
    const boxes = (await this._rectsAll(sel)).filter((r) => r && r.vis);
    if (boxes.length >= 2) {
      const chars = Array.from(String(code));
      for (let i = 0; i < chars.length; i++) {
        if (i >= boxes.length) break;
        const r = boxes[i];
        const x = r.x + r.w / 2 + randFloat(-2, 2);
        const y = r.y + r.h / 2 + randFloat(-2, 2);
        await this.clickXY(x, y);
        await sleep(randInt(50, 150));
        await this.typeText(chars[i]);
        await sleep(randInt(60, 160));
      }
      return true;
    }
    await this.click(sel);
    await sleep(randInt(150, 350));
    await this.typeText(code);
    return true;
  }

  // Type text character by character (real key events per char), with
  // per-character human delays: longer after space/@./-/_/#!, an occasional
  // "thinking pause" (4%), otherwise a fast 30-100 ms.
  async typeText(text) {
    const { sleep, randInt } = await this._util();
    for (const ch of Array.from(String(text))) {
      // keyboard.type emits keydown+input+keyup for the char — the Playwright
      // equivalent of the Python keyDown(text=ch)/keyUp(ch) CDP pair.
      await this.page.keyboard.type(ch, { delay: 0 });
      if (' @.-_#!'.includes(ch)) {
        await sleep(randInt(80, 220));
      } else if (Math.random() < 0.04) {
        await sleep(randInt(180, 500));
      } else {
        await sleep(randInt(30, 100));
      }
    }
  }

  // Resolve a Python-style key spec to a Playwright key name: VK code first,
  // then physical code, then the raw key (single characters pass through).
  _keyName(key, code = null, vk = null) {
    if (Number.isInteger(vk) && VK_MAP[vk]) return VK_MAP[vk];
    if (code && CODE_MAP[code]) return CODE_MAP[code];
    return String(key ?? '');
  }

  // Press + release one key (Tab, Enter, Ctrl+A, ...). `vk` is the Windows
  // virtual-key code the Python tool passed; `modifiers` is the CDP bitmask
  // (1=Alt, 2=Ctrl, 4=Shift, 8=Meta) mapped onto Playwright modifier names.
  // The 30-80 ms down/up delay mirrors the Python press timing.
  async pressKey(key, { code = null, vk = null, modifiers = 0 } = {}) {
    const { randInt } = await this._util();
    const parts = [];
    if (modifiers & 1) parts.push('Alt');
    if (modifiers & 2) parts.push('Control');
    if (modifiers & 4) parts.push('Shift');
    if (modifiers & 8) parts.push('Meta');
    parts.push(this._keyName(key, code, vk));
    await this.page.keyboard.press(parts.join('+'), { delay: randInt(30, 80) });
  }

  // Fill an input: click it, clear old content with Ctrl+A, type the new
  // text, then Tab out (like a real user moving to the next field). Returns
  // the matched selector or null.
  async fill(selectors, text) {
    const { sleep, randInt } = await this._util();
    const sel = await this.click(selectors);
    if (!sel) return null;
    await sleep(randInt(100, 280));
    await this.pressKey('a', { code: 'KeyA', vk: 65, modifiers: 2 }); // Ctrl+A
    await sleep(randInt(20, 60));
    await this.typeText(text);
    await sleep(randInt(80, 180));
    await this.pressKey('Tab', { code: 'Tab', vk: 9 });
    return sel;
  }

  // Click a button by selector or by visible text. Returns 'sel:<selector>',
  // 'text:<matched label>' or null. The rect is re-read WITH the element's
  // index in querySelectorAll so the right element can be scrolled back into
  // view (the 'Create account' button ends up around y~853, below the fold,
  // and clicking by a stale rect misses the viewport entirely).
  async clickButton(texts, selectors = null) {
    const { randFloat } = await this._util();
    if (selectors) {
      const sel = await this.click(selectors);
      if (sel) return `sel:${sel}`;
    }
    const wants = texts.map((t) => String(t).toLowerCase());
    // Collect buttons WITH their querySelectorAll index, filtered to visible
    // and enabled ones, text lowercased for substring matching.
    const js =
      `(()=>{let r=[],all=document.querySelectorAll('button,input[type=submit]');` +
      `all.forEach((b,i)=>{let s=getComputedStyle(b),box=b.getBoundingClientRect();` +
      `if(box.width>0&&box.height>0&&s.visibility!=='hidden'` +
      `&&s.display!=='none'&&!b.disabled)` +
      `r.push({i:i,t:(b.innerText||b.value||'').trim().toLowerCase(),` +
      `x:box.x,y:box.y,w:box.width,h:box.height})});` +
      `return r})()`;
    const buttons = (await this._eval(js)) || [];
    for (const btn of buttons) {
      for (const want of wants) {
        if (btn.t && btn.t.includes(want)) {
          const box = (await this._scrollIndexIntoView(btn.i)) || btn;
          const padX = Math.max(3, box.w * 0.12);
          const padY = Math.max(3, box.h * 0.12);
          const x = box.x + randFloat(padX, box.w - padX);
          const y = box.y + randFloat(padY, box.h - padY);
          await this.clickXY(x, y);
          return `text:${btn.t}`;
        }
      }
    }
    return null;
  }

  // Scroll the nth 'button,input[type=submit]' element into view and return
  // its FRESH rect; null when not needed/not found. After scrolling, wait for
  // the scroll animation to settle, then re-read the rect — and keep the
  // pre-scroll box as a fallback. Read-only, no DOM mutation.
  async _scrollIndexIntoView(index) {
    const { sleep, randInt } = await this._util();
    if (index == null) return null;
    const i = Math.trunc(index);
    const js =
      `(()=>{let e=document.querySelectorAll('button,input[type=submit]')[${i}];` +
      `if(!e)return null;let r=e.getBoundingClientRect();` +
      `if(r.top<40||r.bottom>innerHeight-40){` +
      `e.scrollIntoView({block:'center',inline:'nearest'});` +
      `r=e.getBoundingClientRect()}` +
      `return{x:r.x,y:r.y,w:r.width,h:r.height}})()`;
    const box = await this._eval(js);
    if (!box) return null;
    // After the scroll, let the page settle, then READ the rect again
    // (scrolling animates).
    await sleep(randInt(250, 500));
    const js2 =
      `(()=>{let e=document.querySelectorAll('button,input[type=submit]')[${i}];` +
      `if(!e)return null;let r=e.getBoundingClientRect();` +
      `return{x:r.x,y:r.y,w:r.width,h:r.height}})()`;
    return (await this._eval(js2)) || box;
  }

  // Wait until one of `selectors` is visible; returns the matched selector or
  // null on timeout (`timeout` in SECONDS, default 25).
  // Poll every 0.2s: each poll is one cheap Runtime.evaluate, but this sits
  // on the critical path of EVERY step (email, password, username, Create
  // button, TOTP box...), so a sparse poll rate adds up to whole seconds per
  // account.
  async waitFor(selectors, timeout = 25) {
    const { sleep } = await this._util();
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const deadline = Date.now() + timeout * 1000;
    for (;;) {
      const [sel] = await this._find(list);
      if (sel) return sel;
      if (Date.now() >= deadline) return null;
      await sleep(200);
    }
  }

  // Diagnostic: list currently visible inputs ({id,name,type,ph}).
  // Anonymous IIFE, leaves no trace. The array length doubles as the visible
  // input count for debugging stuck forms.
  async reportInputs() {
    const js =
      `(()=>Array.from(document.querySelectorAll('input'))` +
      `.filter(e=>{let r=e.getBoundingClientRect();` +
      `return r.width>0&&r.height>0})` +
      `.map(e=>({id:e.id,name:e.name,type:e.type,ph:e.placeholder})))()`;
    return (await this._eval(js)) ?? null;
  }
}
