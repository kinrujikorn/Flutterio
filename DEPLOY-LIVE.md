# Deploying Live ✦ preview (Model A)

> **Goal:** people who clone PageMapper get a working **Live ✦** tab (the real venio
> page) **without installing Flutter**. You build + host the venio web bundle
> **once**; everyone else just points `--app-url` at that hosted URL.

```
[you, once]  venio (+ preview code + fixtures) ──build web──▶ build/web ──deploy──▶ https://venio-preview.vercel.app
[everyone]   clone PageMapper → npm install/build → run with --app-url <that URL>  → Live works
```

The graph + Insights + Coupling already work for any cloner with zero of this.
Model A is only needed if you also want the Live tab.

---

## Who does what

| Step | Who | Needs |
|------|-----|-------|
| 1. Preview code committed on venio `web-preview-uat` | ✅ done | — |
| 2. **Record fixtures** (real data) | **you** | a real login (once) |
| 3. Build venio web | you | fvm + Flutter 3.44.1 |
| 4. **Deploy the build** | **you** | a Vercel (or any static host) account |
| 5. Wire `--app-url` | you | — |
| 6. Use it | anyone | just Node + the clone |

Steps 2 and 4 need **your** credentials, so they can't be automated for you.

---

## Step 2 — Record fixtures (optional but recommended)

Without this, Live pages render their real structure but with **empty data**
(empty lists / loading-then-empty). Fixtures make them show realistic content,
fully offline.

1. Run the real app where the backend works — mobile/emulator through a proxy
   (Proxyman/Charles), or the web build through a CORS proxy — and **log in**.
2. Browse the pages you want populated.
3. Export the traffic as **HAR** (DevTools → Network → "Save all as HAR with
   content"; or export from the proxy).
4. Convert + install:
   ```bash
   node scripts/har-to-fixtures.js session.har preview_fixtures.json
   # SANITIZE preview_fixtures.json — it holds whatever the session returned.
   cp preview_fixtures.json <venio>/apps/venio_app/web/preview_fixtures.json
   ```
   Then commit it on `web-preview-uat` so the build picks it up.

> Never hardcode a password. The login happens once, by you, in a real browser/app.

## Step 3 — Build the venio web bundle

```powershell
pwsh scripts/build-venio-preview.ps1
# → <venio>/apps/venio_app/build/web   (static files)
```

(Uses the direct fvm binary — see the script header for why.)

## Step 4 — Deploy the bundle (static host)

One-time: `npm i -g vercel` then `vercel login`. Then:

```bash
vercel deploy "C:/Users/kin/Documents/GitHub/venio-mobile-app/apps/venio_app/build/web" --prod
```

Vercel serves it as a static site and prints a URL, e.g.
`https://venio-preview.vercel.app`. (Netlify `netlify deploy --dir=build/web --prod`
or GitHub Pages work the same — any static host.)

No `vercel.json` is required: venio uses **hash routing** (`/#/route`), so the host
only ever serves `index.html` + assets. The app fetches `preview_fixtures.json`
from its own origin (same-origin, no CORS).

## Step 4b — Password-protect it (shared password, free plan)

The deploy is public by default — anyone with the link can view it. To gate it
behind one shared password on any Vercel plan, `build-venio-preview.ps1` already
copies a Basic-Auth Edge Middleware (`scripts/preview-middleware.js` →
`build/web/middleware.js`) into the bundle. It protects **everything** — pages,
the JS bundle, and `preview_fixtures.json` — so nothing leaks without the password.

Enable it by setting the password as a Vercel env var (one-time), then redeploy:

```bash
vercel env add PREVIEW_PASS production     # type the shared password when prompted
vercel env add PREVIEW_USER production      # optional; defaults to "venio"
vercel deploy "<...>/apps/venio_app/build/web" --prod   # redeploy so the env var applies
```

Now the site prompts for `venio` / `<your password>` before anything loads. Give
the team the password out-of-band (Slack/1Password) — never commit it.

> If `PREVIEW_PASS` is unset the gate is **off** (fail-open, so a misconfig can't
> lock everyone out) — so you must set it to actually protect the deploy.
> Prefer zero-code? Vercel Dashboard → Settings → **Deployment Protection**
> (Vercel Authentication = team-only, free; Password Protection = Pro) instead.

## Step 5 — Point PageMapper at it

Run with the hosted URL:

```bash
node dist/cli.js <venio> --app-url https://venio-preview.vercel.app
```

Or bake it into `.claude/launch.json` (the `pagemapper` config's `runtimeArgs`)
so the Live tab is on by default for everyone who clones.

## Step 6 — What cloners do

Nothing extra:
```bash
git clone https://github.com/kinrujikorn/Flutterio.git
cd Flutterio && npm install && npm run build
node dist/cli.js <venio-local> --app-url https://venio-preview.vercel.app
```
Click a page node → **Live ✦** → the real page (with your recorded data). No Flutter on their machine.

---

## Refreshing

When venio changes (or you record new fixtures): re-run **Step 3 → Step 4**. The
hosted bundle is a **snapshot** — cloners always see whatever you last deployed.
Consider a GitHub Action on the venio repo to rebuild + redeploy automatically.
