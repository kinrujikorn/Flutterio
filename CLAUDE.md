# CLAUDE.md

Guidance for working in this repo. **PageMapper** is a local tool that reads a codebase and renders an interactive dependency/architecture graph (files↔files, pages↔pages) plus an insights/lint layer. The repo folder is `Flutterio`; the npm package is named `pagemapper`. Primary analysis target is the Flutter monorepo at `C:\Users\kin\Documents\GitHub\venio-mobile-app`.

## Commands

```bash
npm run build          # tsc -p tsconfig.json  → dist/  (run after any src/ change)
npm run dev            # tsx src/cli.ts        (run TS directly, no build)
npm test               # node --import tsx --test test/*.test.ts

# Run the tool (after build):
node dist/cli.js <project-path> [flags]
```

CLI flags (see `parseArgs` in `src/cli.ts`):
- `--port N` (default 4567) · `--no-open` (don't launch browser)
- `--watch` (default ON) / `--no-watch` · `--lsp` (default ON) / `--no-lsp`
- `--json <outfile>` — write the graph JSON and exit (no server)
- `--export <outfile>` — write a standalone self-contained HTML and exit
- `--check` — CI mode: print insights summary, exit non-zero if thresholds exceeded
  - `--max-high N` (default 0) · `--max-total N` (default unlimited)
- `--catalog <url>` · `--catalog-build <dir>` · `--app-url <url>` — wire the Live/preview tabs

Dev servers are defined in `.claude/launch.json`: `pagemapper` (4567, analyzes venio + watch + catalog/app URLs), `harness-web` (4571, component catalog), `venioapp-web` (4572, venio Flutter web build for the Live tab).

## Architecture

Pipeline (each stage is a module under `src/`):
`scanner.ts` (find dart files, infer package/feature/layer) → `parser/` (regex: imports, navigation, widgets, api) **or** `lsp/` (Dart `dart language-server` for accurate symbols/refs; falls back to regex) → `graph-builder.ts` (nodes + edges + stats) → `insights.ts` (lint findings + coupling metrics) → `server.ts` (raw `node:http`) → `web/` UI.

- **`src/types.ts` is the single source of truth** for the producer↔UI contract: `GraphNode` (kind `file`|`page`, layer, package, feature, routePath), `GraphEdge` (type `import`|`navigate`|`uses`|`api`), `GraphData` (+ `insights`, `coupling`), `InsightsReport`, `PackageCoupling`. Change types here first; everything downstream of `buildGraph` is language-agnostic.
- `src/preview.ts` + `preview-context.ts` — deterministic Flutter widget-tree → HTML renderer (the "Preview UI" tab; no LLM, no app build).
- `src/export.ts` — standalone HTML (embeds the graph as `window.__PM_GRAPH__`; the UI disables server-only features when that global is present).
- `src/server.ts` endpoints: `/graph.json`, `/events` (SSE live update), `/capabilities`, `/preview`, `/source`, `/export.html`, `/refine`.

### Insights engine (`src/insights.ts`)
`computeInsights(graph)` returns categories (each = a findings list rendered generically by the UI): `layer-violation`, `cross-feature-import` (a feature importing another feature's `/src/` internals), `circular-dep` (Tarjan SCC), `god-file` (import fan-in/out outliers, barrels excluded), `dead-page`, `nav-depth` (BFS depth from entry), `orphan-file`. `computePackageCoupling(graph)` returns per-package Ca/Ce/Instability (Martin metrics) for the Coupling dashboard. Both attach to `GraphData` in `graph-builder.ts`. Findings are **deterministic** — verify by running with `--json` and inspecting `insights.summary` / `coupling`.

## Web UI (`web/`)

**No framework.** Vanilla JS + HTML + CSS. **No build step** — files are served as-is; edit + reload.
- Graph: **Cytoscape.js + fcose**, all libs + the Hanken Grotesk font **vendored in `web/vendor/`** (no CDN, offline-safe).
- `web/app.js` is one ~1300-line IIFE, ES5 style (`var`, function declarations), DOM via `innerHTML` strings, a single `state` object. UI state (view/filters/toggles) persists in the URL hash. If you add a big frontend feature, split this file first (graph / panels / insights).
- The cytoscape instance is reachable as `document.getElementById('cy')._cyreg.cy`.

## Gotchas (learned the hard way — heed these)

- **Verifying the Flutter Live preview**: the headless `Claude_Preview` screenshot tool **cannot capture a CanvasKit (Flutter web) canvas** (continuous repaint → 30s timeout; a cold-loaded backgrounded tab is also 0×0). Verify Flutter pages via console logs + the route hash, not screenshots. For the PageMapper UI (cytoscape) screenshots also often time out — verify via the cy instance / DOM eval instead, which is stronger than a screenshot anyway.
- **Building venio Flutter web** (for the Live tab): use the **direct fvm binary** `C:\Users\kin\fvm\versions\3.44.1\bin\flutter.bat build web -t lib/main_web_preview.dart --no-wasm-dry-run --no-tree-shake-icons`. Do **not** use the `fvm` shim — it resolves to the global Flutter 3.38.6 and fails with `Can't load Kernel binary (expected 125, found 130)`.
- **Parallel subagents**: partition by file ownership so no two agents edit the same file concurrently (this repo's history is fresh; worktree isolation isn't reliable here).
- **Deployment (Vercel)**: only **static output** can be hosted — the analyzer/watch server, Dart LSP, and Flutter builds can't run on Vercel serverless. Generate `graph.json` (+ optionally venio `build/web` + fixtures) locally/CI, then deploy the static `web/` UI + that data. Insights need ZERO changes to the venio repo (pure read-only analysis); only the Live tab needs in-repo venio code.

## The venio Live preview (optional feature, lives in the venio repo)

Live mode opens the **real** venio app compiled to Flutter Web and deep-links to a page's route. Its support code lives in `venio-mobile-app` on branch `web-preview-uat` (untracked → commit it or `git clean` will wipe it):
- `apps/venio_app/lib/main_web_preview.dart` — preview entrypoint: sets `gPreviewBypassAuth = true`, reads the route from `Uri.base.fragment` into `gPreviewInitialRoute`, then `bootstrap(...)`.
- `apps/venio_app/lib/router/app_router.dart` — `gPreviewBypassAuth` (redirect returns null = no auth/PIN/RBAC gating) and `gPreviewInitialRoute` (used as `GoRouter.initialLocation` — REQUIRED, else a fresh web boot ignores the hash and sticks on `/splash`).
- `apps/venio_app/lib/preview_mocks.dart` — seeds `UserInfoCache` + swaps every named Dio adapter for a mock that replays recorded fixtures from `web/preview_fixtures.json` (origin-served), falling back to empty 200s so pages never hang. Production never runs this (gated on `gPreviewBypassAuth`).
- Record real data: run the app where the backend works, DevTools → Save HAR → `node scripts/har-to-fixtures.js session.har preview_fixtures.json` → drop into `apps/venio_app/web/` → rebuild. **Sanitize before sharing** (real data). Never hardcode passwords; the user logs in themselves or supplies a token.
