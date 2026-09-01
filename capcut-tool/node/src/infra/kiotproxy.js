// Minimal KiotProxy classic-API client (2026-09-02, for the batch runner).
//
// GET /api/v1/proxies/new?key=K... allocates a FRESH residential proxy bound
// to the CALLER'S IP (no user/pass on the proxy itself — IP-authenticated),
// envelope {success, data:{http:'ip:port', socks5, ttl, ttc, ...}}. Keys are
// single-slot: one held proxy per key at a time. Allocation can fail with
// SYSTEM_IS_HAVING_TROUBLE_ALLOCATING_RESOURCES (stock hiccup, seen live) —
// retry once, then surface the error so the caller just uses another source.

const BASE = 'https://api.kiotproxy.com/api/v1/proxies';

// Allocate a fresh proxy for a key. Returns 'ip:port' (IP-auth, no creds)
// or throws with the server's message.
export async function newProxy(key, { timeoutMs = 20000, retries = 1 } = {}) {
  let last = 'no response';
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(`${BASE}/new?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(timeoutMs) });
      const j = await r.json().catch(() => null);
      if (j?.success && j?.data?.http) return j.data.http;
      last = j?.error || j?.message || `HTTP ${r.status}`;
    } catch (e) {
      last = e.message;
    }
    if (i < retries) await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`kiotproxy allocation failed: ${last}`);
}
