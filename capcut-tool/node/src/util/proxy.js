// Proxy string parsing shared by the CapCut tool.
// Extracted from the original gpm.js client when GPMLogin was dropped in favor
// of CloakBrowser (2026-09-01) — the accepted input formats are unchanged.

// Bad proxy input (unparseable / missing port).
export class ProxyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProxyError';
  }
}

// Split a proxy string (any common input style) into {scheme, host, port, user, pwd}.
// Returns null when raw is empty. Accepted inputs:
//   - "socks5://user:pass@1.2.3.4:1080"   (URL with scheme + creds)
//   - "socks5://1.2.3.4:1080"             (URL without creds)
//   - "user:pass@1.2.3.4:1080"
//   - "1.2.3.4:1080"                      (host:port)
//   - "1.2.3.4:1080:user:pass"            (host:port:user:pass — the user's PROXY_LIST format)
export function parseProxy(raw, defaultScheme = 'http') {
  if (raw === null || raw === undefined) return null;
  raw = String(raw).trim();
  if (!raw) return null;

  let scheme = defaultScheme;
  let rest = raw;
  if (raw.includes('://')) {
    const i = raw.indexOf('://');
    scheme = raw.slice(0, i).toLowerCase();
    rest = raw.slice(i + 3);
  }

  let user = null;
  let pwd = null;
  let host;
  let port;
  if (rest.includes('@')) { // creds@host:port
    const at = rest.lastIndexOf('@');
    const creds = rest.slice(0, at);
    const hostport = rest.slice(at + 1);
    const ci = creds.indexOf(':');
    if (ci !== -1) {
      user = creds.slice(0, ci);
      pwd = creds.slice(ci + 1);
    } else {
      user = creds;
    }
    const hp = hostport.split(':');
    if (hp.length < 2) {
      throw new ProxyError(`Proxy missing port: ${JSON.stringify(raw)}`);
    }
    host = hp[0];
    port = hp[1];
  } else {
    const parts = rest.split(':');
    if (parts.length === 2) { // host:port
      host = parts[0];
      port = parts[1];
    } else if (parts.length >= 4) { // host:port:user:pass — password may itself contain ':'
      host = parts[0];
      port = parts[1];
      user = parts[2];
      pwd = parts.slice(3).join(':');
    } else {
      throw new ProxyError(
        `Unrecognized proxy format: ${JSON.stringify(raw)}. ` +
          'Use host:port:user:pass or scheme://[user:pass@]host:port'
      );
    }
  }
  return { scheme, host, port, user, pwd };
}

// Normalize into the compact `host:port[:user:pass]` form (scheme prefix kept
// only for socks). Historical consumers: kiotproxy-style backends that want a
// bare string. Returns null when raw is empty.
export function normalizeProxy(raw, defaultScheme = 'http') {
  const p = parseProxy(raw, defaultScheme);
  if (p === null) return null;
  let creds = '';
  if (p.user) {
    creds = p.pwd !== null && p.pwd !== undefined ? `:${p.user}:${p.pwd}` : `:${p.user}`;
  }
  const base = `${p.host}:${p.port}${creds}`;
  const sch = p.scheme;
  if (sch === 'http' || sch === 'https' || sch === '') {
    return base;
  }
  return `${sch}://${base}`;
}

// Normalize into a standard URL for HTTP clients:
//   scheme://[user:pass@]host:port
// (socks5 -> socks5h and socks4 -> socks4a so DNS resolves through the proxy.)
// Returns null when raw is empty.
export function toUrlProxy(raw, defaultScheme = 'http') {
  const p = parseProxy(raw, defaultScheme);
  if (p === null) return null;
  let sch = (p.scheme || 'http').toLowerCase();
  if (sch === 'socks5') {
    sch = 'socks5h';
  } else if (sch === 'socks4') {
    sch = 'socks4a';
  }
  let auth = '';
  if (p.user) {
    auth = p.pwd !== null && p.pwd !== undefined ? `${p.user}:${p.pwd}@` : `${p.user}@`;
  }
  return `${sch}://${auth}${p.host}:${p.port}`;
}

// Convert any accepted raw proxy string into the Playwright/CloakBrowser
// `proxy` launch option: { server, username?, password? }. Returns undefined
// when raw is empty (browser runs on the machine IP, like python's no-proxy path).
export function toPlaywrightProxy(raw, defaultScheme = 'http') {
  const p = parseProxy(raw, defaultScheme);
  if (p === null) return undefined;
  const proxy = { server: `${p.scheme || 'http'}://${p.host}:${p.port}` };
  if (p.user) {
    proxy.username = p.user;
    proxy.password = p.pwd ?? '';
  }
  return proxy;
}
