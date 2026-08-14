// Tiny local Swagger host for API Test Studio.
// Extracts DEMO_SPEC from index.html and serves it on localhost:3000
// at the URLs the app probes (/openapi.json, /swagger.json, /v3/api-docs, ...).
// CORS is wide-open so the browser app can fetch it directly.
//
// Usage:  node swagger-server.js   (or:  PORT=3000 node swagger-server.js)

const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HTML_PATH = path.join(__dirname, "index.html");

function extractSpec() {
  const src = fs.readFileSync(HTML_PATH, "utf8");
  const marker = "const DEMO_SPEC = ";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("DEMO_SPEC not found in index.html");
  // Walk braces to find the matching closing }.
  const openIdx = src.indexOf("{", start);
  let depth = 0, end = -1;
  let inStr = false, strCh = "", prev = "";
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === strCh && prev !== "\\") inStr = false;
    } else {
      if (c === '"' || c === "'" || c === "`") { inStr = true; strCh = c; }
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    prev = c;
  }
  if (end === -1) throw new Error("Could not parse DEMO_SPEC literal");
  const literal = src.slice(openIdx, end + 1);
  const ctx = { out: null };
  vm.createContext(ctx);
  vm.runInContext("out = (" + literal + ")", ctx);
  return ctx.out;
}

const spec = extractSpec();
const specJson = JSON.stringify(spec, null, 2);

const SPEC_PATHS = new Set([
  "/", "/openapi.json", "/swagger.json",
  "/api-docs", "/api-docs/json", "/api-docs-json",
  "/v2/api-docs", "/v3/api-docs",
  "/docs/openapi.json", "/docs/swagger.json",
]);

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = req.url.split("?")[0];
  if (SPEC_PATHS.has(url)) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(specJson);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found. Try /openapi.json");
});

server.listen(PORT, () => {
  console.log(`Demo spec served at http://localhost:${PORT}/openapi.json`);
  console.log(`Endpoints: ${[...SPEC_PATHS].join(", ")}`);
});
