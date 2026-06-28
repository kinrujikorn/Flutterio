# PageMapper — Feature Roadmap

**Date:** 2026-06-27
**Status:** Living document (update as tiers ship)

---

## What PageMapper does today

PageMapper is a local Node + TypeScript tool that reads a Flutter/Dart monorepo
and renders an interactive dependency/architecture graph in a local browser tab.
It requires no changes to the target repo — pure read-only static analysis.

**Pipeline:**
```
scanner.ts → parser/ (regex) OR lsp/ (Dart language-server)
           → graph-builder.ts → insights.ts → server.ts → web/ UI
```

**Core outputs:**
- **File dependency graph** — who imports whom, colored by Clean-Architecture layer.
- **Page flow graph** — go_router navigation edges between `*Page` widgets.
- **Component / API views** — widget-usage and Dio call-site edges.
- **Coupling dashboard** — per-package Martin Ca / Ce / Instability metrics.
- **Architecture lint** — 7 deterministic, pure-function insight categories:

| Insight | What it flags |
|---|---|
| `layer-violation` | `domain` importing `presentation` etc. |
| `cross-feature-import` | Feature A reaching into Feature B's `/src/` internals |
| `circular-dep` | Import cycles (Tarjan SCC) |
| `god-file` | Fan-in / fan-out outliers (barrel files excluded) |
| `dead-page` | Routed pages with no incoming navigation edge |
| `nav-depth` | Pages reachable only via an unusually deep nav path (BFS) |
| `orphan-file` | Files with zero import edges in or out |

All findings are deterministic (same code → same output) and keyed by stable
content-addressed ids, making them safe to diff across runs.

---

## Feature plan

### Tier 1 — Baseline/Diff + Impact analysis + Git hotspots

These three features form a coherent "risk surface" story: know what changed,
how far it ripples, and which files change most often. They are the highest
ROI for teams already using PageMapper in CI.

**Baseline / Diff** ([spec](./2026-06-27-baseline-diff.md))
Snapshot a `GraphData` as a committed baseline. Subsequent `--check` runs gate
CI on *newly-added* findings only, not the total. `--diff <out.json>` writes a
machine-readable `GraphDiff` for dashboards or PR annotations. Removes the
"too many findings to adopt" barrier on brownfield repos.

**Impact analysis** ([spec](./2026-06-27-impact-analysis.md))
Client-side reverse transitive closure over import edges in the web UI detail
panel: "if this file changes, how many files / features / pages are affected?"
Expressed as a blast-radius count and a breakdown by package, with a subgraph
highlight. Zero server changes — runs in the browser over the already-loaded
`GraphData`.

**Git hotspots** ([spec](./2026-06-27-git-hotspots.md))
`src/git.ts` runs `git log --name-only` over a configurable window, computes
per-file churn (commit count, author count, last-change date) and attaches it
to `GraphNode.churn`. `computeHotspots` in `insights.ts` flags files that are
both high-churn and high fan-in — the files most likely to cause cascading
breakage. The web UI gains a "size by churn" Cytoscape display toggle.

---

### Tier 2 — Policy config + Temporal coupling + Test coverage

These features extend the lint engine with inputs that go beyond the import
graph alone. They are independent of each other and can ship in any order
within the tier.

**Policy config** ([spec](./2026-06-27-policy-config.md))
Load `.pagemapper.json` from the project root. Teams declare `forbidden`
dependency rules (`from` / `to` selectors on package, feature, layer, or
path glob). `evaluatePolicy` produces `policy-violation` findings via the
same insights pipeline, rendered generically by the UI. Zero AST changes;
pure overlay on the existing graph.

**Temporal coupling** ([spec](./2026-06-27-temporal-coupling.md))
`src/git.ts` also computes `CoChangePair`: file-pairs that change together in
commits but share no import edge. High co-change support + no structural link =
hidden coupling. `computeTemporalCoupling` in `insights.ts` flags these as
`temporal-coupling` findings. Pairs with an existing import edge are excluded
(that coupling is already visible).

**Test coverage** ([spec](./2026-06-27-test-coverage.md))
`src/coverage.ts` reads each test file, resolves its internal imports via the
existing `parser/imports.ts` + `parser/context.ts` stack, and records which
source files are transitively covered. `computeUntestedPages` flags `*Page`
nodes whose declaring file is absent from the covered set. Attaches
`GraphNode.tested: boolean` for future UI overlays.

---

### Tier 3 — Angular support + Report export + LLM Q&A

These features expand the tool's surface area significantly. They are
planned but not being actively implemented in the current sprint.
([combined spec](./2026-06-27-future-angular-llm-report.md))

**Angular support**
Swap `scanner.ts` + `parser/` for TypeScript/Angular equivalents. The
`graph-builder.ts` → `insights.ts` → `server.ts` → `web/` stack is
language-agnostic and reusable without modification.

**Structured report export**
`--report <out.html|pdf>` produces a self-contained human-readable architecture
report: graph thumbnail, coupling table, insight summary, hotspot list. Useful
for async code reviews and architecture sign-off gates.

**LLM Q&A**
`/refine` endpoint (already stubbed in `server.ts`) accepts a natural-language
question about the graph and streams an answer via the Anthropic API. Context
is injected from the graph JSON + relevant node neighborhoods, not the raw
source.

---

### Tier 4 — Infra / polish

Ongoing improvements that unblock or improve the above tiers.

- **LSP caching** — the Dart language-server currently blows the 120s budget
  when run over the full venio monorepo. Cache the symbol/ref output to disk
  (keyed by file mtime) so repeated runs and watch-mode only re-analyze changed
  files. Scoping to one app (`apps/venio_app`) is the immediate workaround.
- **Command palette** — `Cmd+K` fuzzy-search over nodes, insight categories, and
  UI actions. Improves navigability at 500+ node scale.
- **Saved views** — named URL-hash snapshots ("auth slice", "core cluster") that
  can be shared with teammates or embedded in Confluence.

---

## Summary table

| Feature | Impact | Effort | Status |
|---|---|---|---|
| Baseline / Diff | High — unblocks brownfield CI adoption | Medium | Implementing now |
| Impact analysis | High — instant blast-radius estimate | Low | Implementing now |
| Git hotspots | High — surfaces churn risk | Medium | Implementing now |
| Policy config | Medium — team-defined rules | Low | Implementing now |
| Temporal coupling | Medium — hidden coupling detection | Medium | Implementing now |
| Test coverage | Medium — untested page detection | Medium | Implementing now |
| Angular support | High — doubles addressable projects | High | Planned |
| Report export | Medium — async review artifact | Medium | Planned |
| LLM Q&A | Medium — lowers graph-reading skill floor | High | Planned |
| LSP caching | High — removes 120s budget constraint | Medium | Planned |
| Command palette | Low — UX polish | Low | Planned |
| Saved views | Low — collaboration | Low | Planned |

---

## Recommended 3-phase sequence

### Phase 1 — CI-ready insights (Tier 1)

Ship Baseline/Diff, Git hotspots, and Impact analysis together. These three
compose into a coherent "risk surface" workflow for CI pipelines:

1. `--json pagemapper-baseline.json` — snapshot the current state.
2. On every PR: `--check --baseline pagemapper-baseline.json --max-high 0` —
   block on new regressions only.
3. Impact analysis in the UI tells reviewers which files are blast-radius
   sensitive before they approve.
4. Hotspot display toggle shows which nodes are high-churn at a glance.

**Exit criteria:** `diffGraphs` unit tests pass; `--baseline` flag accepted in
`parseArgs`; hotspot findings appear in `--json` output; impact panel renders
in the detail pane.

### Phase 2 — Extended lint engine (Tier 2)

Ship Policy config, Temporal coupling, and Test coverage. Each is independent;
temporal coupling has a soft dependency on the git-log parsing already built
in Phase 1 (`collectGit` in `src/git.ts`).

Order within the phase:
1. **Policy config** — smallest delta; validates the `InsightInputs` plumbing
   end to end.
2. **Test coverage** — validates `ScannedTestFile` + `coveredRel` path.
3. **Temporal coupling** — reuses `GitInsightData.coChange` already computed.

**Exit criteria:** `.pagemapper.json` loaded and respected; `policy-violation`,
`untested-page`, `temporal-coupling` findings appear in `--json` output; all
new insight keys appear in the UI's existing generic category renderer.

### Phase 3 — Broader platform (Tier 3 + 4)

LSP caching is a prerequisite for Angular support (TypeScript LSP will have the
same budget problem). Implement caching first, then Angular scanner, then the
report and LLM features in parallel (they are independent).

Command palette and saved views can ship incrementally alongside any Phase 3
work — they touch only `web/app.js`.

---

## Spec index

| Spec file | Feature(s) covered |
|---|---|
| [2026-06-20-pagemapper-design.md](./2026-06-20-pagemapper-design.md) | Foundational architecture (Tier 0) |
| [2026-06-27-baseline-diff.md](./2026-06-27-baseline-diff.md) | Baseline / Diff mode |
| [2026-06-27-impact-analysis.md](./2026-06-27-impact-analysis.md) | Impact / blast-radius analysis |
| [2026-06-27-git-hotspots.md](./2026-06-27-git-hotspots.md) | Git churn + hotspot findings |
| [2026-06-27-temporal-coupling.md](./2026-06-27-temporal-coupling.md) | Temporal coupling findings |
| [2026-06-27-policy-config.md](./2026-06-27-policy-config.md) | Policy / forbidden-dependency config |
| [2026-06-27-test-coverage.md](./2026-06-27-test-coverage.md) | Test coverage + untested-page findings |
| [2026-06-27-future-angular-llm-report.md](./2026-06-27-future-angular-llm-report.md) | Angular support, report export, LLM Q&A |
