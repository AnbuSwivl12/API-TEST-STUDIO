# API Test Studio

Single-file Scalar/Postman-style API test runner. Static HTML — designed to run on GitHub Pages and used from any browser, on any device.

```
API test studio/
├── index.html       ← the app (single self-contained file, v2.0)
├── package.json     ← worker deploy scripts
├── .nojekyll        ← tells GitHub Pages to serve files as-is
├── .gitignore
├── README.md        ← this file
└── worker/
    ├── worker.js        ← Cloudflare Worker — cross-device sync + CORS proxy
    ├── wrangler.toml    ← worker config
    └── package.json
```

---

## Deploy to GitHub Pages

The repo is already on GitHub. Just enable Pages:

1. Open https://github.com/AnbuSwivl12/API-TEST-STUDIO/settings/pages
2. **Build and deployment**:
   - **Source:** *Deploy from a branch*
   - **Branch:** `main` / `/ (root)`
3. Click **Save**.
4. Wait ~30 seconds, then refresh the same page — GitHub will show the live URL at the top.

Your URL will be:
```
https://anbuswivl12.github.io/API-TEST-STUDIO/
```

That's the URL you share with anyone, on any device.

### If the URL shows 404

- Make sure `index.html` is at the root of `main` branch (not in a subfolder).
- Make sure `.nojekyll` exists at the root (it does — empty file).
- Pages can take 1–2 minutes on first publish. Hard-refresh (Cmd+Shift+R / Ctrl+Shift+R).
- The URL is case-sensitive in some clients — try both `API-TEST-STUDIO` and lowercase if one fails.

### If you see an old version

GitHub Pages caches aggressively. After pushing changes:
- Wait 60 seconds.
- Hard-refresh (Cmd+Shift+R).
- Or open **Settings → Pages → Visit site** to force a fresh load.

---

## Cross-device sync (optional — Cloudflare Worker)

Without sync, each device's localStorage is independent — open the URL on a new device and you start fresh. The bundled worker fixes that with a per-user-token sync layer **and** a CORS proxy for public APIs that don't allow your origin.

### Deploy the worker (5 min, free tier)

Prereqs: Node 18+, a free Cloudflare account.

```bash
cd worker
npm install
npx wrangler login                     # opens browser, authorize once
npx wrangler kv:namespace create STATE # copy the printed id
```

Paste the `id` into `wrangler.toml` (replace `REPLACE_WITH_KV_ID`). Then:

```bash
npx wrangler deploy
```

Wrangler prints your worker URL, e.g.
```
https://api-test-studio-sync.<your-subdomain>.workers.dev
```

### Wire it into the app

1. Open the GitHub Pages URL.
2. Click ⚙ → scroll to **☁ Cloud sync**.
3. Paste the worker URL into **Sync server URL**.
4. Click **Generate** to create a User Token, copy it.
5. (Optional) Tick **Auto-push on every change**.
6. Click **Save** → **↑ Push to cloud**.
7. On any other device: open the same Pages URL, paste the same worker URL + token, click **↓ Pull from cloud**.

### Use the worker as a CORS proxy

If your target API doesn't return CORS headers for the GitHub Pages origin:

1. Settings ⚙ → **CORS proxy URL** field → click **☁ Use cloud proxy** → it pre-fills `<your-worker>/v1/proxy?url=`.
2. Save.

Now every request the app makes goes through `your-worker/v1/proxy?url=<target>` — the worker forwards method/headers/body and returns the response with open CORS.

---

## How sync works internally

```
Device A ──PUT /v1/state──▶ Worker ──KV.put(u:<token>)──▶ Cloudflare KV
Device B ──GET /v1/state──▶ Worker ──KV.get(u:<token>)──▶ JSON payload
```

- **Endpoints**: `https://your-worker.../v1/state`, `https://your-worker.../v1/proxy?url=`
- **Auth**: `X-User-Token: <your token>` (16-128 chars, `[A-Za-z0-9_-]`)
- **CORS**: open (`*`) so the GitHub Pages origin can call it.
- **Limits**: 100 KB per user, 90-day idle TTL (refreshed on each push).

---

## Troubleshooting

**Pages shows 404 or "Page not found"**
Pages probably isn't enabled yet. Settings → Pages → set source to `main` / root → Save.

**Endpoint requests fail with CORS error**
The target API doesn't allow the GitHub Pages origin. Either configure CORS on the API, or set the proxy URL in Settings to `<your-worker>/v1/proxy?url=`.

**"Cannot POST /?url=..." in Send response**
You set a public free proxy (e.g. `corsproxy.io`). Those only forward GET. The app auto-skips them for write methods, but you should clear that field and use **Use cloud proxy** instead.

**Push returns 401**
Token must be 16-128 chars `[A-Za-z0-9_-]`. Use the **Generate** button.

**Push returns 413**
Payload over 100 KB. Trim runs/history or raise `MAX_BYTES` in `worker.js` and redeploy.

**Worker URL CORS-blocked**
Confirm `worker.js` includes the `Access-Control-Allow-*` headers (it does by default). Don't put a proxy *in front of* the worker — call it directly.

**localStorage on a new device shows nothing**
Expected — localStorage is per-browser. Pull from cloud once on each new device.
