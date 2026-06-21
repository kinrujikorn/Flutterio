# PageMapper

Reads a Flutter/Dart project and visualizes how files and pages connect — as a
beautiful, interactive graph in your browser.

Answers questions like *"which page navigates to which page?"* and *"what does
this file depend on?"* across a whole monorepo.

![views: Page Flow · File Dependency · Components · API](docs/superpowers/specs/2026-06-20-pagemapper-design.md)

## Quick start

```bash
npm install
npm run build
node dist/cli.js <path-to-flutter-project>
```

This scans the project, builds the graph, starts a local server, and opens your
browser. Example:

```bash
node dist/cli.js "C:/Users/kin/Documents/GitHub/venio-mobile-app"
```

During development you can skip the build step:

```bash
npm run dev -- <path-to-flutter-project>      # via tsx
```

### Options

Watch and LSP are **on by default**.

| flag | meaning |
|------|---------|
| `--port <n>` | server port (default: first free from 4567) |
| `--no-open` | don't auto-open the browser |
| `--no-watch` | disable live updates (analyze once, serve a static snapshot) |
| `--no-lsp` | skip the Dart LSP refine (heuristic analysis only) |
| `--catalog <url>` | base URL of a built component catalog for faithful Live previews |
| `--catalog-build <dir>` | catalog app dir; on watch changes, auto-rebuild it (`flutter build web`) |
| `--json <file>` | write the graph JSON to a file and exit (no server) |
| `--export <file.html>` | write a self-contained interactive HTML file and exit |

### Sharing / export

Two ways to share a graph:

- **PNG** — the toolbar **PNG** button downloads the current view as an image.
- **Standalone HTML** — one self-contained, fully interactive file (graph data,
  Cytoscape, the stylesheet, and fonts all inlined) that opens offline in any
  browser with no server. Get it from the toolbar **HTML** button, or the CLI:

  ```bash
  node dist/cli.js <path-to-flutter-project> --export graph.html
  ```

  The CLI export runs the accurate LSP analysis first (unless `--no-lsp`).

### Accuracy: Dart LSP refine

If the Dart SDK is on your PATH, PageMapper uses the real **Dart analysis
server** (`dart language-server`) for accurate results — proper class detection,
widget/page/service classification, and reference-based `uses` and `api` edges
instead of token guesses. On the venio repo this cut `uses` edges from 422 to
~128 (false positives removed, real ones added) and turned `api` edges into
links to the **real service files** (e.g. a use-case → `auth_repository.dart`)
instead of synthetic endpoint nodes.

To stay snappy, the browser **opens immediately** with the fast heuristic graph,
then the LSP pass runs in the background (~tens of seconds on a large repo) and
the accurate graph is **pushed to the open page live** — no refresh. If Dart
isn't installed or the analysis fails, it silently keeps the heuristic graph.
The `navigate` and `import` views are identical either way; `uses`/`api` differ.
Use `--no-lsp` to skip it entirely.

You can also re-run the analysis on demand with the **Re-run LSP** button in the
graph toolbar (handy after edits, since live watch rebuilds use the fast
heuristic). It re-analyzes on the server and live-updates the open page.

> Tip: run `flutter pub get` / `dart pub get` in the target project first so the
> analyzer can resolve external supertypes (e.g. `StatelessWidget`) for fully
> accurate classification.

### Live updates (watch)

Edits to the project update the graph automatically — a debounced file watcher
re-analyzes whenever a `.dart` file changes and pushes the new graph to the
browser over Server-Sent Events. The open page updates in place: your current
view, filters, and selection are preserved, and the camera only re-fits when the
set of nodes actually changes.

Each change pushes the **fast heuristic graph immediately**, then — debounced
longer so rapid saves coalesce — automatically (a) re-runs the **LSP refine**
for accuracy (when `--lsp`) and (b) rebuilds the **Live catalog** and refreshes
the open Live preview (when `--catalog-build <dir>` is set; needs Flutter on
PATH). So switching git branches or editing widgets keeps the graph, accuracy,
and faithful previews all current with no manual step. Use `--no-watch` for a
static snapshot.

## The graph

Four views, switchable in the UI:

- **Page Flow** — `page → page` navigation (`context.go/push`, go_router routes).
  The clearest answer to "which page connects to which page". Edge labels show
  the route and any `extra:` payload handed to the next page, e.g.
  `/customer/profile ‹customer.customerId›`. Isolated pages are hidden (count
  shown in the view label).
- **File Dependency** — `import` edges between files, colored by layer. Use the
  package filter / *Group by package* toggle to tame large monorepos.
- **Components** — widget/component usage (`uses` edges).
- **API** — service / datasource / HTTP call edges.

Nodes are colored by Clean-Architecture layer (presentation / domain / data /
other). Click any node for a detail panel (path, package, feature, route, and
clickable in/out neighbors) — its neighborhood highlights, the rest dims. The
panel also has a **View source** button that opens the node's actual `.dart`
file in a code viewer (served on demand from the project). Search jumps to any
node; filters narrow by package and feature.

### UI preview (widget-tree mockup)

In the code viewer, a **Preview UI** tab renders an approximate mockup of how
the page would look. Flutter widgets can't be rendered faithfully from static
source (that needs the running app with its real state and dependencies), so
this parses the widget tree in the page's `build()` method and maps known
widgets (Scaffold, AppBar, Column/Row, buttons, Text, ListView, TextField, …)
to HTML/CSS — a structural wireframe, not the live app.

It is **deterministic, offline, and free** — no AI, no API key, no network. To
look closer to the real app, the renderer also:

- **Resolves the app's own widgets** — when it hits a custom widget (e.g. a
  design-system `VenTextField`/`VenPrimaryButton`), it finds that class in the
  project and renders *its* `build()` tree, so components show their real shapes
  (recursively, with depth + cycle guards).
- **Uses real theme colors** — `Color(0x…)` literals and color tokens
  (`VenColors.primary`, …) are resolved to the project's actual hex values.
- **Humanizes localization keys** — `context.t('auth.login.sign_in')` → "Sign In".

The mockup renders in a sandboxed phone frame (no scripts) and is cached per
file (content-hashed). It's still a structural approximation — widgets whose
look depends on constructor args or runtime state, and values from APIs, show as
placeholders.

### Faithful render (Live ✦) — real Flutter engine

For a pixel-faithful preview, point PageMapper at a built **Flutter-Web
component catalog** (Widgetbook-style):

```bash
node dist/cli.js <project> --catalog http://localhost:4571
```

When set, the code viewer gains a **Live ✦** tab that embeds
`<catalogUrl>?widget=<ClassName>` in a phone frame — the component rendered by
the *actual Flutter engine* (real theme, fonts, states), not an approximation.
The node's class is derived from its file (snake_case → PascalCase); widgets
without a catalog entry fall back to the catalog index.

The catalog lives in the Flutter project (e.g. `apps/preview_catalog/` — a tiny
app that depends on the design-system package and maps `?widget=<Name>` to a
real component; add a component with one line in its `catalog` map). One-time
setup:
1. Run codegen so generated parts exist: `dart run build_runner build` in
   packages using `freezed`/`json_serializable` (e.g. `packages/core`).
2. Build it: `cd apps/preview_catalog && flutter build web --pwa-strategy=none`.
3. Serve `build/web` (any static server) and pass its URL via `--catalog`:
   `npx http-server apps/preview_catalog/build/web -p 4571` then
   `pagemapper <project> --catalog http://localhost:4571`.

**Scope:** this is faithful for **components** (design-system widgets take simple
props, so a catalog entry is cheap). Full **pages** additionally need their
runtime mocked (BLoC/Cubit + DI graph + localization + router) — author those
incrementally as catalog entries; until then pages use the deterministic
preview. Notes: the app must build for web (web-incompatible plugins like
secure-storage/local-auth need stubbing; iOS `.xcassets` asset declarations may
need web-conditionalizing).

## How it works

```
scan (find .dart + packages) → parse (imports, navigation, widgets, API)
  → build graph (typed nodes/edges) → serve web UI (Cytoscape.js)
```

- **Scanner** (`src/scanner.ts`) — walks `.dart` files, reads `pubspec.yaml` to
  map packages, classifies each file into package/feature/layer.
- **Parser** (`src/parser/*`) — fast regex/heuristic extraction of imports,
  go_router pages + navigation, widget usage, and service calls.
- **LSP analyzer** (`src/lsp/*`) — drives `dart language-server` for accurate
  class detection, classification, and reference-based `uses` edges; merges over
  the heuristic baseline. Returns `null` (→ heuristic fallback) if Dart is
  absent or analysis fails.
- **Graph builder** (`src/graph-builder.ts`) — merges into a single `GraphData`
  (the contract in `src/types.ts`).
- **Export** (`src/export.ts`) — inlines the UI + data + fonts into one
  portable, offline HTML file (scripts embedded as base64 `data:` URIs).
- **Preview** (`src/preview.ts`) — deterministic parser that turns a page's
  `build()` widget tree into an HTML/CSS wireframe (no AI, no network).
- **Web UI** (`web/`) — vanilla JS + Cytoscape.js (`fcose` layout). A calm,
  minimal dark theme (light toggle, persisted) with **Hanken Grotesk** as the
  typeface. All dependencies — including the font — are vendored under
  `web/vendor/`, so it works fully offline.

## Limitations (v1)

- Dart/Flutter only.
- Navigation resolves route literals and `Page.routePath` constants; fully
  dynamic route construction may not resolve a target.
- Without the LSP refine (no Dart SDK, or `--no-lsp`), `uses` / `api` edges fall
  back to token heuristics and can over-match. The LSP pass fixes both.
- The LSP refine spawns a fresh analysis server per run, so live (watch)
  rebuilds use the heuristic for speed — use **Re-run LSP** to refresh accuracy.

See [the design spec](docs/superpowers/specs/2026-06-20-pagemapper-design.md)
for the full design.

## Tests

```bash
npm test
```

Unit tests for each parser plus a smoke test against a real repo.
