/**
 * API Test Studio — sync worker (Cloudflare Workers + KV)
 * --------------------------------------------------------
 * Endpoints:
 *   GET  /v1/state    -> returns the JSON payload stored under X-User-Token
 *                        404 if nothing stored yet
 *   PUT  /v1/state    -> stores the JSON body under X-User-Token (overwrites)
 *   ANY  /v1/relay?url=<encoded absolute URL>
 *                     -> forwards the request to that URL and returns the
 *                        response with permissive CORS, so a browser can test
 *                        an API that doesn't send CORS headers of its own.
 *   GET  /            -> tiny health/info page
 *   OPTIONS *         -> CORS preflight
 *
 * Auth: a single header `X-User-Token: <random string>`.
 *       Whoever holds the token reads/writes that bucket. Treat it like a
 *       password. Rotate by editing it in the app's Settings on every device.
 *
 * Config: bind a KV namespace as `STATE` in wrangler.toml (template included).
 *
 * Limits:
 *   - Per-user payload max ~100 KB (set MAX_BYTES below).
 *   - Token must be 16-128 chars, [a-zA-Z0-9_-].
 */

const MAX_BYTES = 100 * 1024;          // 100 KB cap per user
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token",
  "Access-Control-Max-Age": "86400",
};

/* ---------------------------------------------------------------------------
 * Relay
 * ---------------------------------------------------------------------------
 * An open relay is an abuse magnet, so this one is closed by default:
 *
 *   RELAY_TOKEN  (secret)  required in X-Relay-Token if set
 *   RELAY_ALLOW  (var)     comma-separated host suffixes that may be reached,
 *                          e.g. "api.acme.com,.internal.acme.dev"
 *
 * Set at least one. With neither, the relay refuses every request rather than
 * quietly becoming someone else's proxy.
 * ------------------------------------------------------------------------- */
const RELAY_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "86400",
};
// Headers the runtime owns; forwarding them corrupts the request.
const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "upgrade",
  "content-length", "x-relay-token", "cf-connecting-ip", "cf-ipcountry",
  "cf-ray", "cf-visitor", "x-forwarded-proto", "x-forwarded-for", "x-real-ip",
]);

function relayDenied(msg) {
  return new Response(JSON.stringify({ error: "relay refused", detail: msg }), {
    status: 403, headers: { "Content-Type": "application/json", ...RELAY_CORS },
  });
}

async function handleRelay(request, env, url) {
  const target = url.searchParams.get("url");
  if (!target) return relayDenied("no ?url= given");

  let t;
  try { t = new URL(target); } catch (e) { return relayDenied("?url= is not a valid absolute URL"); }
  if (t.protocol !== "https:" && t.protocol !== "http:") return relayDenied("only http and https are relayed");

  const wantToken = (env.RELAY_TOKEN || "").trim();
  const allow = (env.RELAY_ALLOW || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!wantToken && !allow.length) {
    return relayDenied("this relay has neither RELAY_TOKEN nor RELAY_ALLOW configured, so it stays closed");
  }
  if (wantToken && request.headers.get("X-Relay-Token") !== wantToken) {
    return relayDenied("missing or wrong X-Relay-Token");
  }
  if (allow.length) {
    const host = t.hostname.toLowerCase();
    const okHost = allow.some(a => host === a || host.endsWith(a.startsWith(".") ? a : "." + a));
    if (!okHost) return relayDenied(`${host} is not in RELAY_ALLOW`);
  }

  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  }
  headers.set("Host", t.host);

  const init = { method: request.method, headers, redirect: "manual" };
  if (!["GET", "HEAD"].includes(request.method)) init.body = request.body;

  let upstream;
  try {
    upstream = await fetch(t.toString(), init);
  } catch (e) {
    return new Response(JSON.stringify({ error: "relay could not reach the target", detail: String(e) }), {
      status: 502, headers: { "Content-Type": "application/json", ...RELAY_CORS },
    });
  }

  const out = new Headers(upstream.headers);
  // The relay's CORS must win, or the browser sees the origin's (absent) policy.
  ["access-control-allow-origin", "access-control-allow-methods",
   "access-control-allow-headers", "access-control-expose-headers"].forEach(h => out.delete(h));
  Object.entries(RELAY_CORS).forEach(([k, v]) => out.set(k, v));
  out.set("X-Relayed-By", "api-test-studio");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

function badToken() {
  return json({ error: "Missing or invalid X-User-Token header" }, 401);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/v1/relay") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: RELAY_CORS });
      return handleRelay(request, env, url);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "API Test Studio worker\n" +
        "  /v1/state  GET/PUT with X-User-Token  — cross-device sync\n" +
        "  /v1/relay?url=...  any method         — CORS relay (needs RELAY_TOKEN or RELAY_ALLOW)\n",
        { headers: { "Content-Type": "text/plain", ...CORS } }
      );
    }

    if (url.pathname !== "/v1/state") {
      return json({ error: "Not Found" }, 404);
    }

    const token = request.headers.get("X-User-Token") || "";
    if (!TOKEN_RE.test(token)) return badToken();

    const key = "u:" + token;

    if (request.method === "GET") {
      const data = await env.STATE.get(key);
      if (!data) return json({ error: "Not Found" }, 404);
      return new Response(data, {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    if (request.method === "PUT") {
      const body = await request.text();
      if (body.length > MAX_BYTES) {
        return json({ error: `Payload too large (>${MAX_BYTES} bytes)` }, 413);
      }
      try { JSON.parse(body); }
      catch { return json({ error: "Body must be valid JSON" }, 400); }
      await env.STATE.put(key, body, {
        // 90-day idle expiry; refreshed on every PUT
        expirationTtl: 60 * 60 * 24 * 90,
      });
      return json({ ok: true, savedAt: Date.now(), bytes: body.length });
    }

    return json({ error: "Method Not Allowed" }, 405);
  },
};
