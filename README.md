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
- **Impact / blast radius** → the same panel shows how far a change ripples: how
  many files depend on it (transitively, across the *whole* graph — not just
  what's on screen), how many features and pages it touches, and a one-click
  **Highlight blast radius**. The answer to *"what breaks if I change this?"*
- **Hotspots** → the *Hotspots (size by churn)* toggle (left, shown when git
  history is available) sizes and red-tints files by how often they change —
  big & red = changed a lot.
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
| **Policy violations** | a forbidden dependency you declared in `.pagemapper.json` (your own rules) |
| **Circular dependencies** | files that import each other in a loop |
| **God files** | files that far too many things depend on (or that depend on far too much) |
| **Hotspots** | files that change *often* in git **and** are depended on by many — the highest-leverage place to refactor or add tests |
| **Unreachable pages** | screens nothing navigates to — possibly dead |
| **Untested pages** | screens no test file imports — likely missing coverage |
| **Deep pages** | screens buried many taps from the entry |
| **Orphan files** | files with no imports in or out — possible dead code |
| **Temporal coupling** | file pairs that keep changing together in git but don't import each other — a *hidden* dependency |

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

## 6. Browse every API — with a mock request & response

Click the **`</>` button** in the top bar to open the **API Catalog**: every HTTP
call the app makes, in one searchable list — no more digging through datasource
code to figure out what an endpoint sends and returns.

For each endpoint you get:
- the **method + path** (`GET activity/v1/Activity/ActivityReport`, with `{id}`
  params), the owning service, and the feature;
- a **mock request** and **mock response** as ready-to-read JSON — generated
  deterministically from the Dart request/response models (freezed `@JsonKey`
  fields, nested models, lists, enums all resolved). It's a *shape*, not real
  data — no network, no AI — so you understand the contract at a glance.

Filter by method (GET/POST/PUT/PATCH/DELETE) or search by path/service. On the
venio app it surfaces ~390 endpoints with ~290 typed responses.

> Like everything else, the catalog rides along in `graph.json`, so `--json` and
> the standalone `--export` HTML include it too.

---

## 7. Share a map

- **PNG** — the toolbar button downloads the current view as an image.
- **Standalone HTML** — one self-contained file (graph + UI + fonts all inlined)
  that opens offline in any browser, no server:

  ```bash
  node dist/cli.js <project> --export map.html
  ```

  Send the file, or host it anywhere static. (CLI export runs the accurate LSP
  analysis first.)

---

## 8. Use it in CI (catch regressions)

`--check` runs the analysis once and **fails the build** if there are too many
problems — great as a pull-request gate:

```bash
# fail if any high-severity finding (layer violation, cycle, cross-feature import) exists
node dist/cli.js <project> --no-open --check --max-high 0
```

It prints a per-category report and exits non-zero when a threshold is crossed.
Thresholds: `--max-high <n>` (default 0), `--max-total <n>` (default unlimited).

**Gate on *new* problems only.** A big existing codebase already has findings —
blocking on all of them is a non-starter. Snapshot a baseline once, then fail CI
only when a PR *adds* new findings:

```bash
# once, on main:
node dist/cli.js <project> --no-open --json pagemapper-baseline.json
# on every PR — fails only if the PR introduces NEW high-severity findings:
node dist/cli.js <project> --no-open --check --baseline pagemapper-baseline.json --max-high 0
```

`--diff out.json --baseline base.json` writes the full added/removed delta
(nodes, edges, findings) for dashboards or PR comments.

> Insights now include **git-derived** signals (hotspots, temporal coupling).
> These read your `git log` — add `--no-git` to skip, or `--git-commits <n>` to
> widen/narrow the history window (default 800).

---

## 9. Accuracy & live updates (good to know)

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
| `--baseline <file>` | with `--check`, gate only on findings *new* vs this baseline graph |
| `--diff <file>` | write the added/removed delta vs `--baseline` and exit |
| `--no-git` | skip git-history mining (hotspots + temporal coupling) |
| `--git-commits <n>` | git-log history window (default 800) |
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
- Hotspots & temporal coupling need a git repo with history; they're skipped
  on a shallow clone or non-git project (everything else still works).

## Tests

```bash
npm test
```
