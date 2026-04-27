/**
 * API Test Studio — sync + proxy worker (Cloudflare Workers + KV)
 * ---------------------------------------------------------------
 * Endpoints:
 *   GET  /v1/state                -> returns JSON state stored under X-User-Token (404 if empty)
 *   PUT  /v1/state                -> stores JSON state under X-User-Token (overwrites)
 *   ANY  /v1/proxy?url=<encoded>  -> forwards method/headers/body to <url>, returns response
 *                                    with CORS open. For *public* URLs only — Workers can't
 *                                    reach localhost / RFC1918 ranges; use the bundled
 *                                    proxy.js locally for that.
 *   GET  /                        -> tiny health/info page
 *   OPTIONS *                     -> CORS preflight
 *
 * Auth (state endpoint): X-User-Token header, 16-128 chars [A-Za-z0-9_-].
 * Auth (proxy endpoint): none — open relay, rate-limited by Cloudflare.
 *
 * KV: bind namespace `STATE` in wrangler.toml.
 *
 * Limits:
 *   - State payload max ~100 KB.
 *   - Token must match TOKEN_RE.
 */

const MAX_BYTES = 100 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
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

// Block proxying to private/internal hosts — Workers can't reach them anyway.
function isPrivateHost(host) {
  const h = (host || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h.endsWith(".localhost") ||
         /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "API Test Studio worker\n" +
        "  /v1/state  — sync (header X-User-Token)\n" +
        "  /v1/proxy  — CORS-open relay for public URLs (?url=<encoded>)\n",
        { headers: { "Content-Type": "text/plain", ...CORS } }
      );
    }

    // ---- /v1/proxy : forward any method to any *public* URL ----
    if (url.pathname === "/v1/proxy") {
      const target = url.searchParams.get("url");
      if (!target) return json({ error: "Missing ?url=<encoded target>" }, 400);
      let parsed;
      try { parsed = new URL(target); }
      catch { return json({ error: `Invalid target URL: ${target}` }, 400); }
      if (!/^https?:$/.test(parsed.protocol)) {
        return json({ error: "Only http/https supported" }, 400);
      }
      if (isPrivateHost(parsed.hostname)) {
        return json({
          error: "Cannot proxy to private/local hosts from a public worker. " +
                 "Use the bundled proxy.js locally for localhost / internal IPs."
        }, 400);
      }
      // Forward everything except hop-by-hop & worker-injected headers.
      const fwd = new Headers();
      for (const [k, v] of request.headers.entries()) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "origin" || lk === "referer" ||
            lk === "x-user-token" || lk === "cf-connecting-ip" ||
            lk.startsWith("cf-") || lk.startsWith("x-forwarded-")) continue;
        fwd.set(k, v);
      }
      const init = { method: request.method, headers: fwd, redirect: "follow" };
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = await request.arrayBuffer();
      }
      try {
        const upstream = await fetch(target, init);
        const respHeaders = new Headers(upstream.headers);
        for (const [k, v] of Object.entries(CORS)) respHeaders.set(k, v);
        respHeaders.delete("transfer-encoding");
        respHeaders.delete("content-encoding");
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      } catch (e) {
        return json({ proxyError: true, message: e.message, target }, 502);
      }
    }

    // ---- /v1/state : per-user JSON store ----
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
        expirationTtl: 60 * 60 * 24 * 90,
      });
      return json({ ok: true, savedAt: Date.now(), bytes: body.length });
    }

    return json({ error: "Method Not Allowed" }, 405);
  },
};
