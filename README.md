# PageMapper

**See how your Flutter codebase fits together — as an interactive map in your browser.**

Point it at a Flutter/Dart project and it draws the connections: which page goes
to which page, which file imports which file, and where the architecture is
starting to tangle. Great for onboarding, code review, and untangling a big
monorepo.

It answers questions like:
- *"Which screens can you reach from the dashboard?"*
- *"What depends on this file — and what breaks if I change it?"*
- *"Are we breaking our own architecture rules?"*

---

## 1. Get it running (2 minutes)

```bash
npm install
npm run build
node dist/cli.js <path-to-your-flutter-project>
```

Example:

```bash
node dist/cli.js "C:/Users/kin/Documents/GitHub/venio-mobile-app"
```

That scans the project, builds the map, starts a local server, and opens your
browser. First paint is instant; a more accurate pass (Dart LSP) loads in the
background and updates the page live — no refresh needed.

> Developing PageMapper itself? Skip the build with `npm run dev -- <project>`.

---

## 2. What you're looking at

The map has **four views** — switch them with the tabs at the top:

| View | Shows | Answers |
|------|-------|---------|
| **Page Flow** | page → page navigation | "which screen leads to which screen?" |
| **File Dependency** | file → file imports | "what depends on what?" |
| **Components** | which widget is used where | "where is this component used?" |
| **API** | calls to services / datasources | "what hits the backend?" |

Every dot (node) is a file or a page, **colored by architecture layer**:
🟪 presentation · 🟨 domain · 🟩 data · ⬜ other.

In **Page Flow**, edge labels even show the route and the data passed along, e.g.
`/customer/profile ‹customer.customerId›`.

---

## 3. Getting around

- **Click a node** → a panel opens with its path, package, layer, and clickable
  neighbors (what it points to / what points to it). Its connections light up; the
  rest dims.
- **Search** (top bar) → jump to any file or page by name.
- **Filters** (left) → narrow to specific packages or features. *Group by package*
  bundles a big monorepo into tidy clusters.
- **Toolbar** → re-run layout, fit to screen, reset, download PNG/HTML.
- **Shareable link** → your current view, filters, and toggles are saved in the
  URL. Copy the link and a teammate opens the *exact* same view.

---

## 4. Insights — find the problems automatically

The **Insights** panel (left side) lints the architecture and lists what it finds.
Click any finding and the map jumps to it and highlights exactly the files/edges
involved.

| Finding | What it means |
|---------|---------------|
| **Layer violations** | a core layer importing an outer one (e.g. `domain → data`) — breaks clean architecture |
| **Cross-feature deep imports** | a feature reaching into another feature's `src/` internals instead of its public API |
| **Circular dependencies** | files that import each other in a loop |
| **God files** | files that far too many things depend on (or that depend on far too much) |
| **Unreachable pages** | screens nothing navigates to — possibly dead |
| **Deep pages** | screens buried many taps from the entry |
| **Orphan files** | files with no imports in or out — possible dead code |

Below it, the **Coupling** dashboard rates each package's *Instability* (how much
it depends outward vs. how much depends on it) and flags the "watch zone" —
packages many things rely on that are still churning. Click a package to light it
up on the map.

Everything here is computed deterministically from the code — no guessing, no AI.

---

## 5. See what a page actually is

Click a node → **View source** opens its real `.dart` file. The code viewer has
three tabs:

- **Source** — the actual file.
- **Preview UI** — a quick *wireframe* of the page, built by parsing its widget
  tree (Scaffold/AppBar/Column/buttons/Text…) into HTML. It resolves your own
  design-system widgets, real theme colors, and localized strings. It's a
  structural sketch — offline and free, no AI — not the live app.
- **Live ✦** — the **real page** running in the actual Flutter engine. See below.

### Live ✦ — the real running page

For a faithful, real-engine preview, PageMapper can embed the **actual app**
compiled to Flutter Web and deep-link to a page's route:

```bash
node dist/cli.js <project> --app-url http://localhost:4572
```

Now the Live tab shows the genuine page — real widgets, theme, and fonts. Because
there's no backend in a preview, data comes from **recorded fixtures** (so pages
show realistic content offline instead of spinning forever).

You build the venio web bundle **once** and host it as a static site; then anyone
who clones PageMapper just passes that URL via `--app-url` and Live works — **no
Flutter needed on their machine**. Full step-by-step in
**[DEPLOY-LIVE.md](DEPLOY-LIVE.md)** (and `scripts/build-venio-preview.ps1`). If
it's not set up, the Source and Preview UI tabs still work everywhere.

---

## 6. Share a map

- **PNG** — the toolbar button downloads the current view as an image.
- **Standalone HTML** — one self-contained file (graph + UI + fonts all inlined)
  that opens offline in any browser, no server:

  ```bash
  node dist/cli.js <project> --export map.html
  ```

  Send the file, or host it anywhere static. (CLI export runs the accurate LSP
  analysis first.)

---

## 7. Use it in CI (catch regressions)

`--check` runs the analysis once and **fails the build** if there are too many
problems — great as a pull-request gate:

```bash
# fail if any high-severity finding (layer violation, cycle, cross-feature import) exists
node dist/cli.js <project> --no-open --check --max-high 0
```

It prints a per-category report and exits non-zero when a threshold is crossed.
Thresholds: `--max-high <n>` (default 0), `--max-total <n>` (default unlimited).

---

## 8. Accuracy & live updates (good to know)

- **Dart LSP** — if the Dart SDK is on your PATH, PageMapper uses the real Dart
  analysis server for precise results (correct classes, real `uses`/`api` edges
  instead of guesses). It runs in the background and updates the page live. Run
  `flutter pub get` in the target project first for best results. Skip it with
  `--no-lsp`. Re-run anytime with the **Re-run LSP** toolbar button.
- **Watch** — edits to the project update the map automatically (your view,
  filters, and selection are preserved). Turn it off with `--no-watch` for a
  fixed snapshot. Switch git branches and the map follows.

---

## All options

Watch and LSP are **on by default**.

| flag | meaning |
|------|---------|
| `--port <n>` | server port (default 4567, picks next free) |
| `--no-open` | don't auto-open the browser |
| `--no-watch` | analyze once, serve a static snapshot |
| `--no-lsp` | heuristic analysis only (no Dart LSP) |
| `--json <file>` | write the graph JSON and exit |
| `--export <file.html>` | write a standalone interactive HTML and exit |
| `--check` | CI mode: report + exit non-zero past thresholds |
| `--max-high <n>` / `--max-total <n>` | `--check` thresholds |
| `--app-url <url>` | base URL of the real app on Flutter Web (Live tab) |
| `--catalog <url>` / `--catalog-build <dir>` | component-catalog URL / auto-rebuilt catalog dir |

---

## How it works

```
scan .dart + packages → parse (imports, navigation, widgets, API)
  → build typed graph → compute insights → serve web UI (Cytoscape.js)
```

Node + TypeScript backend (raw HTTP server, no framework); a vanilla-JS +
Cytoscape.js front end with everything (libs + fonts) vendored, so it runs fully
offline. Architecture details and contributor notes live in
[CLAUDE.md](CLAUDE.md).

## Limitations

- Flutter/Dart only.
- Very dynamic route construction may not resolve a navigation target.
- Without the Dart LSP, `uses`/`api` edges fall back to heuristics and can
  over-match (the LSP pass fixes this).

## Tests

```bash
npm test
```
