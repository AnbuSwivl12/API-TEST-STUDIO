# API Test Studio

Single-file Scalar/Postman-style runner for **any** API — public, private, or `http://localhost:3000`. Bundled with a local CORS proxy so the browser can hit endpoints that don't return CORS headers.

```
API test studio/
├── index.html         ← the app (single self-contained file, v1.9)
├── proxy.js           ← local CORS proxy (Node, zero deps) — port 5174
├── package.json       ← npm scripts to run/deploy
├── start.sh           ← bash launcher (no Node required for the web part)
├── .nojekyll          ← tells GitHub Pages to serve files as-is
├── .gitignore
├── README.md          ← this file
└── worker/
    ├── worker.js          ← Cloudflare Worker (sync + global CORS proxy)
    ├── wrangler.toml      ← worker config
    └── package.json
```

---

## Run it locally (recommended for testing localhost APIs)

```bash
npm start
```

That boots two services in one terminal:

| service | url                                      | what it does                                 |
| ------- | ---------------------------------------- | -------------------------------------------- |
| web     | http://localhost:5173                    | serves `index.html` (the app UI)             |
| proxy   | http://localhost:5174/?url=&lt;target&gt; | forwards any method to any URL with CORS open |

Open http://localhost:5173/ in your browser. Click the gear icon ⚙ → **Use local proxy** → **Save**. Now you can test:

- `http://localhost:3000/...` (your local backend)
- `http://192.168.x.x/...` (LAN devices)
- `https://staging.your-api.com/...` (CORS-restricted dev APIs)
- `https://api.public-thing.com/...` (any public API)

…with **GET, POST, PUT, PATCH, DELETE** — all methods, all origins.

**No Node? Use the bash launcher:**
```bash
./start.sh
```
Same effect (uses `python3 -m http.server` for web + `node proxy.js` for proxy).

**VS Code Live Server extension:** open the folder, right-click `index.html` → **Open with Live Server**. Run `node proxy.js` in a side terminal if you also want the proxy.

> Why a proxy at all?
> Browsers block cross-origin requests unless the target API explicitly says `Access-Control-Allow-Origin: <your origin>`. Most localhost backends and many internal services don't set that header. The proxy stands in front of the real API, says "yes you may" via CORS headers, and forwards your call. The data path is identical to a normal API call.

---

## Make it accessible globally

Two parts:

1. **Hosting the page** — GitHub Pages serves `index.html` so any device can open it from a public URL.
2. **Cloud proxy + cross-device sync** — one tiny Cloudflare Worker handles **both**: per-user state sync **and** a CORS proxy for public APIs.

You can do part 1 alone if you only want a public URL with no sync. Add part 2 when you want either feature.

---

## Part 1 — Host the page on GitHub Pages

### Option A: brand-new repo (cleanest)

1. Create a new public repo on GitHub, e.g. `api-test-studio`.
2. From this folder, push everything:
   ```bash
   git init
   git add .
   git commit -m "Initial deploy"
   git branch -M main
   git remote add origin https://github.com/<your-username>/api-test-studio.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `/ (root)` → Save**.
4. Wait ~30 seconds. Your URL will be:
   ```
   https://<your-username>.github.io/api-test-studio/
   ```
5. Open it on any device. You're done with part 1.

### Option B: drop into an existing user/org page repo

If you already have `<you>.github.io`, just copy `index.html` and `.nojekyll` into that repo and push. The page is now at `https://<you>.github.io/`.

> The page works from any origin — there is no server. State is kept in `localStorage` per browser. To share state across devices, do part 2.

---

## Part 2 — Cross-device sync via Cloudflare Worker

You'll spin up a free Cloudflare Worker with one KV namespace. Total time: ~5 minutes. Free tier covers personal use comfortably (100k reads + 1k writes/day).

### Prereqs

- A free Cloudflare account: https://dash.cloudflare.com/sign-up
- Node.js 18+ installed locally
- `wrangler` CLI: `npm install -g wrangler` (or use `npx wrangler`)

### Steps

1. From the repo root:
   ```bash
   cd worker
   npm install
   npx wrangler login            # opens browser, authorize once
   ```

2. Create the KV namespace:
   ```bash
   npx wrangler kv:namespace create STATE
   ```
   Wrangler prints something like:
   ```
   [[kv_namespaces]]
   binding = "STATE"
   id = "abcdef0123456789abcdef0123456789"
   ```
   Copy that `id` value into `wrangler.toml`, replacing `REPLACE_WITH_KV_ID`.

3. Deploy:
   ```bash
   npx wrangler deploy
   ```
   Wrangler prints your worker URL, e.g.:
   ```
   https://api-test-studio-sync.<your-subdomain>.workers.dev
   ```

4. Open the GitHub Pages URL from part 1 in a browser.
5. Click the gear icon ⚙ to open Settings. Scroll to **☁ Cloud sync**.
6. Paste the worker URL into **Sync server URL**.
7. Click **Generate** to create a User Token (long random string). Copy it.
8. Click **Save** → click **↑ Push to cloud**.
9. On every other device: open the same GitHub Pages URL, paste the same worker URL + the same token, click **↓ Pull from cloud**. Everything appears.

> Tick **Auto-push on every change** if you want every edit to flow up automatically (debounced ~1.5 s).

### Rotating / sharing tokens

- The token is a shared secret. Anyone with it can read/write that bucket.
- To rotate: generate a new token on one device, push, then update every other device.
- Different teammates → different tokens. Different projects → different tokens.

---

## How sync works internally

```
Device A ──PUT /v1/state──▶ Worker ──KV.put(u:<token>)──▶ Cloudflare KV
Device B ──GET /v1/state──▶ Worker ──KV.get(u:<token>)──▶ JSON payload
```

- **Endpoint**: `https://your-worker.../v1/state`
- **Auth header**: `X-User-Token: <your token>`
- **Body**: the app's full state (cases, runs, headers, base URL, swagger spec).
- **CORS**: open (`*`) so the GitHub Pages origin can call it.
- **Limits**: 100 KB per user, 90-day idle TTL (refreshed on each push).

If you outgrow KV, swap the worker for one backed by D1/Durable Objects without changing the app contract.

---

## Proxy modes — which to use when

| target API                         | best proxy                       | why                                                       |
| ---------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `http://localhost:3000` (your dev)  | **Local proxy** (`proxy.js`)      | Cloudflare can't reach your machine; only local can.      |
| `http://192.168.x.x` (LAN device)  | **Local proxy**                  | Same — private IP, only reachable from your network.       |
| Public API w/ CORS already         | **None** (leave blank)           | Direct fetch; nothing to add.                              |
| Public API w/o CORS                | **Cloud proxy** (`/v1/proxy`)     | Works from any browser/device; deploy once, use forever.   |
| Public API + you're on Pages build | **Cloud proxy**                   | The local proxy isn't reachable from a public URL.         |

In the app: ⚙ Settings → click **Use local proxy** for option 1/2, **Use cloud proxy** for option 4/5, **Clear** for option 3.

---

## Troubleshooting

**"Cannot POST /?url=..." in Send response**
You have a free public CORS proxy (e.g. `corsproxy.io`) set in Settings. Those only forward GET. The app v1.7+ auto-skips them for write methods. Use the bundled local or cloud proxy instead — both support every HTTP method.

**Local proxy errors with `ECONNREFUSED localhost:5174`**
The proxy isn't running. Start it with `npm start` (boots both web + proxy together) or run `node proxy.js` in a side terminal.

**Local proxy says `400 Cannot proxy to private/local hosts` from cloud worker**
Cloudflare can't reach private IPs. Use the **local proxy** for localhost/LAN targets. The cloud proxy is only for public URLs.

**Push returns 401**
Token must be 16-128 chars `[A-Za-z0-9_-]`. Use the **Generate** button.

**Push returns 413**
Payload over 100 KB. Trim runs/history or raise `MAX_BYTES` in `worker.js` and redeploy.

**Worker URL CORS-blocked**
Confirm `worker.js` includes the `Access-Control-Allow-*` headers (it does by default). Don't put a proxy *in front of* the worker — call it directly.

**localStorage on a new device shows nothing**
That's expected — localStorage is per-browser. Pull from cloud once on each new device.

---

## File reference

- `index.html` — the entire single-file app (vanilla JS, no build).
- `worker/worker.js` — Cloudflare Worker source.
- `worker/wrangler.toml` — Worker config; edit the KV `id` after creating the namespace.
- `worker/package.json` — has `npm run deploy` and `npm run kv:create` shortcuts.
