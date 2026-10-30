#!/usr/bin/env node
/**
 * API Test Studio — database helper for your own computer
 * --------------------------------------------------------
 * Run it where you can already reach the database (office network, VPN,
 * localhost), then paste the address and key it prints into the app:
 *
 *   npx --yes github:AnbuSwivl12/API-TEST-STUDIO        (no download needed)
 *   node db-gateway/server.mjs                          (from a clone, after npm install)
 *
 * Options (environment variables):
 *   PORT=7071            port to listen on (always 127.0.0.1 — never your network)
 *   DB_GATEWAY_KEY=...   use this key instead of a fresh random one each start
 *
 * It also serves the app itself at http://127.0.0.1:7071 — opened from there,
 * the app and this helper share an origin, so no browser "local network"
 * permission is involved and no key is needed.
 *
 * Opened from anywhere else (GitHub Pages, Vercel), every request must carry
 * the key in X-Gateway-Key. Without that, any web page you visit could talk to
 * this helper; with it, only the app you pasted the key into can. Queries are
 * read-only (see core.mjs). Nothing is written to disk and connection strings
 * are never logged.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createGateway, handleDbOp, GatewayError, DB_TYPES } from "./core.mjs";

const require = createRequire(import.meta.url);
function optional(name) { try { return require(name); } catch (_) { return null; } }

const drivers = {
  pg: optional("pg"),
  mysql: optional("mysql2/promise"),
  mongodb: optional("mongodb"),
  mssql: optional("mssql"),
};
const gateway = createGateway(drivers);

const PORT = Number(process.env.PORT) || 7071;
const KEY = process.env.DB_GATEWAY_KEY || crypto.randomBytes(18).toString("base64url");
const MAX_BODY = 256 * 1024;
const APP_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.html");
const OWN_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const CORS = {
  // The key, not the origin, is what keeps other sites out — the app may be
  // opened from GitHub Pages, Vercel, a file, or a teammate's own host.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Gateway-Key",
  // Chrome asks before a public site may call a localhost server.
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "600",
};

function send(res, status, obj) {
  res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function sameKey(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new GatewayError("Request too large.", 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new GatewayError("The request wasn't valid JSON.")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  const url = new URL(req.url, "http://localhost");
  const started = Date.now();

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    fs.readFile(APP_FILE, (err, html) => {
      if (err) { send(res, 404, { error: "The app file isn't next to this helper." }); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/db/health") {
    // Health is open so the app can say "the helper is running, now paste the key".
    send(res, 200, { ok: true, name: "api-test-studio-db-gateway", where: "local", types: gateway.types() });
    return;
  }

  const m = url.pathname.match(/^\/v1\/db\/(test|schema|preview|query)$/);
  if (!m || req.method !== "POST") { send(res, 404, { error: "Not found." }); return; }
  // The app this helper served is trusted; anything else must show the key.
  const own = OWN_ORIGINS.has(req.headers.origin || "");
  if (!own && !sameKey(req.headers["x-gateway-key"], KEY)) {
    send(res, 401, { error: "Wrong or missing key. Copy the key shown where the helper is running." });
    return;
  }

  let type = "?";
  try {
    const body = await readBody(req);
    type = (body.connection && body.connection.type) || "?";
    const out = await handleDbOp(gateway, m[1], body);
    send(res, 200, out);
    log(m[1], type, 200, started);
  } catch (e) {
    const err = e instanceof GatewayError ? e : new GatewayError("Something went wrong in the helper.", 500);
    send(res, err.status || 400, { error: err.message });
    log(m[1], type, err.status || 400, started, err.message);
  }
});

function log(op, type, status, started, note) {
  // Operation, type and timing only — never the connection string or query text.
  const t = new Date().toLocaleTimeString();
  console.log(`${t}  ${op.padEnd(7)} ${String(type).padEnd(8)} ${status}  ${Date.now() - started} ms${note && status >= 500 ? "  " + note : ""}`);
}

server.listen(PORT, "127.0.0.1", () => {
  const have = gateway.types().map(t => DB_TYPES[t]).join(", ") || "none — run npm install";
  console.log(`
  API Test Studio — database helper is running

  Easiest: open the app from here →  http://127.0.0.1:${PORT}
           (Database → "On my computer, office network or VPN"; nothing else to paste)

  Using the app from the website instead? Paste these under the same option:
    Address   http://127.0.0.1:${PORT}
    Key       ${KEY}

  Databases this helper can open: ${have}
  Read-only: queries that change data are refused.  Ctrl+C to stop.
`);
});
server.on("error", e => {
  if (e.code === "EADDRINUSE") console.error(`Port ${PORT} is busy. Try:  PORT=7072 node db-gateway/server.mjs`);
  else console.error(e.message);
  process.exit(1);
});
