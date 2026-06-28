# Baseline / Diff Mode — Design Spec

**Date:** 2026-06-27
**Status:** Draft

## Purpose

Let CI enforce "no new debt" rather than "no debt at all". Teams adopting
PageMapper on brownfield repos often have hundreds of pre-existing findings.
Blocking CI on the total count makes the tool unusable on day one.

Baseline / diff mode snapshots the current `GraphData` as a **baseline**
(typically committed alongside the codebase) and, on every subsequent run,
gates CI on **newly-added findings only**. Fixes (findings removed since the
baseline) are reported as wins. The same delta is also available as a machine-
readable `GraphDiff` for dashboards or future UI "Changes" views.

## Design

### `src/diff.ts` — `diffGraphs`

```ts
import { GraphData, GraphDiff, DiffInsightRef } from './types.js';

export function diffGraphs(baseline: GraphData, current: GraphData): GraphDiff;
```

Three-pass comparison:

1. **Nodes** — set-difference on `node.id`. Ids are stable POSIX-relative paths
   (e.g. `packages/auth/lib/presentation/login_page.dart`) or prefixed page ids
   (`page:LoginPage`). No hashing needed; paths are the canonical key.

2. **Edges** — set-difference on `edge.id`. Edge ids are built by
   `graph-builder.ts` as `${source}→${target}:${type}` — deterministic as long as
   the source and target files exist under the same paths.

3. **Insights** — each finding is keyed as `"${category}:${id}"`. The `id` field
   on `Insight` must be stable across runs (see "Finding key stability" below).
   A finding is *added* if the key exists in `current` but not in `baseline`;
   *removed* if it exists in `baseline` but not in `current`.

Return shape matches `GraphDiff` from `src/types.ts` exactly:

```ts
interface GraphDiff {
  baselineAt?: string;           // baseline.generatedAt (may be absent in old snapshots)
  currentAt: string;             // current.generatedAt
  nodes:    { added: string[]; removed: string[] };
  edges:    { added: string[]; removed: string[] };
  insights: {
    added:   DiffInsightRef[];   // regressions
    removed: DiffInsightRef[];   // fixes
    summary: Record<string, { added: number; removed: number }>;
    // keys: per InsightKey value + "total"
  };
}
```

### Finding key stability

The `id` field of each `Insight` must be **deterministic and content-addressed**
so that running the tool twice on the same unmodified codebase produces identical
ids. Convention per category:

| Category | `id` formula |
|---|---|
| `layer-violation` | `${sourceRelPath}→${targetRelPath}` |
| `cross-feature-import` | `${sourceRelPath}→${targetRelPath}` |
| `circular-dep` | sorted relPaths of cycle members joined with `\|` |
| `god-file` | relPath of the file |
| `dead-page` | relPath of the page file |
| `nav-depth` | `${relPath}@${depth}` |
| `orphan-file` | relPath |
| `hotspot` | relPath |
| `temporal-coupling` | `${a}\|${b}` (a < b, both POSIX relPaths) |
| `policy-violation` | `${ruleName ?? from+':'+to}:${sourceRelPath}→${targetRelPath}` |
| `untested-page` | relPath of page file |

Any category not listed falls back to a numeric index — those findings will
not diff stably and should be converted to content-addressed ids before
shipping.

Renamed files break stable ids (see "Edge cases"). This is acceptable: a rename
shows up as a removed finding on the old path and an added finding on the new
path, which is correct behavior (CI should re-confirm the new file is clean).

### CLI changes — `src/cli.ts`

Two new flags in `parseArgs`:

```
--baseline <graph.json>   Load a previous graph snapshot for diff comparison.
                          Changes --check semantics: thresholds apply to the
                          ADDED column only, not the total.

--diff <out.json>         Compute GraphDiff vs --baseline and write it to
                          <out.json>, then exit with code 0.
                          Requires --baseline. Incompatible with --json.
```

#### `--check` + `--baseline` exit codes

Without `--baseline`: existing behavior — threshold on `insights.summary.total`
and `insights.summary.high`.

With `--baseline`:

1. Call `diffGraphs(baseline, current)` → `GraphDiff`.
2. Count `addedHigh` = `diff.insights.added.filter(r => r.severity === 'high').length`.
3. Count `addedTotal` = `diff.insights.added.length`.
4. Gate on `--max-high` (default 0) and `--max-total` (default unlimited) applied
   to `addedHigh` / `addedTotal`.
5. Exit non-zero if either threshold is exceeded.
6. Print a summary table regardless:

```
PageMapper baseline diff
  Nodes:    +3 added, -1 removed
  Edges:    +12 added, -2 removed
  Findings: +2 added, -5 removed (fixes)

  Added findings (regressions):
    [HIGH] cross-feature-import  packages/auth → packages/dashboard (internal)
    [MED]  god-file              packages/core/lib/utils/helpers.dart

  Removed findings (fixed):
    [HIGH] circular-dep          auth|dashboard|core
    ...

EXIT 1 — 2 new high findings exceed --max-high 0
```

#### `--diff` without `--check`

Writes `GraphDiff` as JSON to the specified file and exits 0. Does not start the
HTTP server. Use for dashboards, PR annotations, or feeding the future UI "Changes"
tab. Baseline is still required.

## Data contract

```ts
// src/diff.ts (full public surface)

/** Compare two graph snapshots.
 *  baseline.insights may be absent (older snapshots); treated as empty.
 *  Returns a deterministic GraphDiff; order within added/removed arrays is
 *  category-alphabetical then id-alphabetical for stable serialization. */
export function diffGraphs(baseline: GraphData, current: GraphData): GraphDiff;
```

`GraphDiff`, `DiffInsightRef` are imported from `src/types.ts`; `diffGraphs`
adds no new types.

## CI usage example

```yaml
# .github/workflows/pagemapper.yml
- name: Run PageMapper check (new debt only)
  run: |
    node dist/cli.js apps/venio_app \
      --check \
      --no-open \
      --no-watch \
      --baseline pagemapper-baseline.json \
      --max-high 0 \
      --max-total 5
```

To ratchet the baseline forward (accept current state as the new zero):

```bash
node dist/cli.js apps/venio_app --json pagemapper-baseline.json --no-open --no-watch
git add pagemapper-baseline.json
git commit -m "chore: ratchet pagemapper baseline"
```

The baseline file is committed to the repo. It is a full `GraphData` JSON, so
it also acts as the last-known-good graph for the "Changes" UI view.

## Future UI: "Changes" view

`GraphDiff` is designed to be consumed client-side with no server changes. When
a baseline is provided via a future `--catalog` or static export flag, the web
UI can:

- Overlay added/removed nodes with a `+`/`-` badge and distinct color.
- List added/removed edges in the detail panel.
- Show the "Findings" panel split into Regressions / Fixes columns.
- Let users jump between "current" and "baseline" graph states by toggling a
  switch (client-only, no re-scan needed — both snapshots are embedded).

This is explicitly **out of scope** for the current implementation; the data
contract is designed to make it cheap to add later.

## Edge cases

**Baseline from a different branch / commit.**
Node and edge ids may not align if files were added or renamed on the other
branch. `diffGraphs` treats every unrecognized id as added/removed — correct
behavior, though the diff may be noisy. The `baselineAt` timestamp in the output
helps the reader understand how stale the baseline is.

**Renamed files.**
A rename produces one removed id (old path) and one added id (new path) for
nodes, edges, and all findings that were keyed to that path. CI will report the
old findings as fixed and new findings (if any) as regressions. Teams should
ratchet the baseline after intentional renames.

**Baseline missing `insights` field.**
Older snapshots produced before the insights engine existed will have
`baseline.insights === undefined`. `diffGraphs` treats a missing or empty
`insights` as zero baseline findings: all current findings appear as *added*.
This is conservative and safe — the first run after upgrading will report the
full finding set as "new", prompting the team to commit a fresh baseline.

**`--diff` without `--baseline`.**
`parseArgs` must reject this combination with a clear error message and exit 1.
Do not fall through to the main pipeline.

**Baseline written by a future version with unknown `InsightKey` values.**
`diffGraphs` compares keys as opaque strings — unknown categories pass through
into `DiffInsightRef.category` unchanged. The summary `Record` accumulates them
under their raw key. No version guard needed.

**Empty project (zero nodes).**
All baseline nodes appear as *removed*; no added nodes. Exit 0 if thresholds
are not exceeded. This is a valid (if unusual) result.

## Testing

- Unit: `diffGraphs(A, A)` → all arrays empty, summary all zeros.
- Unit: add one node to `current` → `nodes.added` has that id, others empty.
- Unit: remove one insight from `current` → `insights.removed` has it.
- Unit: `baseline.insights` absent → all current findings appear in `insights.added`.
- Integration (`--check --baseline`): write a baseline with one `high` finding,
  run against a graph that introduces a second `high` finding → exit 1, output
  shows 1 added.
- Integration (`--diff`): write `GraphDiff` JSON, assert it is valid JSON and
  contains `currentAt`.
- Stability: run twice on the same unmodified project, diff the two outputs →
  all arrays must be empty.

## Out of scope

- Merging or rebasing baselines across branches (use `git merge-base` externally).
- Per-file or per-author delta attribution (use `src/git.ts` for churn).
- Server-side diff endpoint (`/diff.json`) — the server always serves the current
  graph; diffs are CLI / static-export concerns only.
- Automatic baseline update on passing CI (too fragile; keep it a manual ratchet).
