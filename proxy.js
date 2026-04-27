#!/usr/bin/env node
/**
 * API Test Studio — local CORS proxy
 * -----------------------------------
 * Zero-dependency Node proxy that lets the browser hit any backend
 * (including http://localhost:3000, internal IPs, dev subdomains, public
 * APIs that don't send CORS headers, etc.) from any HTTP method.
 *
 *   GET  /                    → tiny health page
 *   ANY  /?url=<encoded URL>  → forwards method/headers/body to <url>
 *                                and returns the response with CORS open.
 *   ANY  /<full URL>          → same, but you can paste the URL after the slash
 *                                e.g.  http://localhost:5174/http://localhost:3000/api/users
 *
 * Run:   node proxy.js          (default port 5174)
 *        PORT=9000 node proxy.js
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = parseInt(process.env.PORT, 10) || 5174;
const HOST = process.env.HOST || "127.0.0.1";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
  "access-control-max-age": "86400",
};

const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
  "origin", "referer", // strip browser-injected origin so the upstream sees a clean call
]);

function pickTarget(req) {
  const reqUrl = req.url || "/";
  // ?url=<encoded> style
  const u = new URL(reqUrl, `http://${req.headers.host || "localhost"}`);
  const q = u.searchParams.get("url");
  if (q) return q;
  // /<full url> style: strip leading slash
  const tail = reqUrl.replace(/^\//, "");
  if (/^https?:\/\//i.test(tail)) return decodeURIComponent(tail);
  return null;
}

function send(res, status, body, ct = "text/plain") {
  res.writeHead(status, { "content-type": ct, ...CORS });
  res.end(body);
}

const server = http.createServer((req, res) => {
  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  // Root health page
  if ((req.url === "/" || req.url === "") && req.method === "GET") {
    return send(res, 200,
      `API Test Studio — local CORS proxy\nlistening on http://${HOST}:${PORT}\n` +
      `usage:  http://${HOST}:${PORT}/?url=<encoded target>\n        http://${HOST}:${PORT}/<full target url>\n`
    );
  }

  const target = pickTarget(req);
  if (!target) {
    return send(res, 400, "Missing target. Usage: ?url=<encoded URL> or /<full URL>", "text/plain");
  }

  let parsed;
  try { parsed = new URL(target); } catch {
    return send(res, 400, `Invalid target URL: ${target}`, "text/plain");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return send(res, 400, `Only http/https supported, got: ${parsed.protocol}`, "text/plain");
  }

  const lib = parsed.protocol === "https:" ? https : http;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }

  const opts = {
    method: req.method,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers,
  };

  const startedAt = Date.now();
  const upstream = lib.request(opts, (upRes) => {
    const outHeaders = { ...upRes.headers, ...CORS };
    // Drop content-encoding so node doesn't double-encode
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
    upRes.on("end", () => {
      const ms = Date.now() - startedAt;
      console.log(`${req.method.padEnd(6)} ${upRes.statusCode}  ${ms}ms  →  ${target}`);
    });
  });

  upstream.on("error", (e) => {
    console.error(`✘ ${req.method} ${target} — ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json", ...CORS });
      res.end(JSON.stringify({ proxyError: true, message: e.message, target }));
    } else {
      try { res.end(); } catch {}
    }
  });

  if (req.method === "GET" || req.method === "HEAD") {
    upstream.end();
  } else {
    req.pipe(upstream);
  }
});

server.on("clientError", (err, sock) => {
  try { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
});

server.listen(PORT, HOST, () => {
  console.log(`▶ CORS proxy ready  →  http://${HOST}:${PORT}/?url=<target>`);
  console.log(`  Forwards every method (GET/POST/PUT/PATCH/DELETE) with CORS headers.`);
  console.log(`  Stop with Ctrl+C.`);
});
