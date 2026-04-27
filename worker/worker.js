/**
 * API Test Studio — sync worker (Cloudflare Workers + KV)
 * --------------------------------------------------------
 * Endpoints:
 *   GET  /v1/state    -> returns the JSON payload stored under X-User-Token
 *                        404 if nothing stored yet
 *   PUT  /v1/state    -> stores the JSON body under X-User-Token (overwrites)
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

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "API Test Studio sync worker — POST /v1/state with X-User-Token header.\n",
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
