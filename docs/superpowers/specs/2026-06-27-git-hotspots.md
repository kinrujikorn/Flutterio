# Git Churn / Hotspots — Design Spec

**Date:** 2026-06-27
**Status:** Draft
**Files touched:** `src/git.ts` (new), `src/insights.ts`, `src/graph-builder.ts`,
`src/cli.ts`, `web/app.js`

---

## Purpose

Surface **refactor priority** signals from the project's own git history. A
*hotspot* (CodeScene terminology) is a file that is **frequently changed AND
heavily depended on** — the combination means each change carries high blast
radius. PageMapper mines this data with a single `git log` call and attaches it
to graph nodes so the UI can render a "size by churn" overlay and the insights
engine can flag hotspot outliers for the architect's attention.

---

## Design

### Scope

`src/git.ts` is a standalone, pure data-collection module. It has no knowledge
of graph nodes or insights; it only maps git paths to project-relative POSIX
paths and aggregates commit-level statistics. The insights engine (`src/insights.ts`)
owns the hotspot threshold logic; `src/graph-builder.ts` wires the two together.

### Git invocation (`collectGit`)

Single `git log` call — never more:

```
git log
  --name-only
  --pretty=format:__COMMIT__%H%n%ae%n%ai
  --diff-filter=AM
  [--max-count=<commits>]
  [--after=<ISO-date>]
  -- <...scanned dart files>
```

Parameters:
- `commits` — max commits to walk (default **500**). Caps runtime; shallow clones
  hit this before running out of history.
- `sinceDays` — also set `--after` to `<today - sinceDays>d` (default **365**).
  Both limits apply; whichever is reached first stops the walk.
- `files` — the list of scanned `.dart` file paths (absolute). Passing them as
  `--` arguments restricts git to only those paths: one call, no loops.

Why `--diff-filter=AM`? Excludes renames (`R`) and deletions (`D`) — a rename
does not indicate the destination file was "worked on" in the normal sense and
would inflate churn of the new path.

### Parsing

Output format emits a `__COMMIT__` sentinel line followed by hash, author email,
ISO timestamp, then a blank line, then one touched filename per line (relative to
the repo root), then another blank line before the next commit.

```
__COMMIT__<hash>
<author-email>
<ISO-date>
(blank)
apps/venio_app/lib/auth/login_page.dart
packages/core/lib/api/dio_client.dart
(blank)
__COMMIT__<next-hash>
...
```

The parser streams line-by-line (no full string load) and accumulates:
- `commitFiles: Map<hash, string[]>` — list of touched relPaths per commit
- `fileCommits: Map<relPath, Set<hash>>`
- `fileAuthors: Map<relPath, Set<email>>`
- `fileLastChange: Map<relPath, string>` — ISO date of latest commit

### Path normalisation (Windows)

`git log` always emits POSIX paths relative to the repo root even on Windows.
The scanned file list is absolute Windows paths. Conversion:

1. Compute `repoRoot` by running `git rev-parse --show-toplevel` (one extra
   call, cached). Result on Windows may be a POSIX-ified path like
   `/c/Users/kin/…` — normalise to `C:\Users\kin\…` before use.
2. For each file in `files`, compute `relPath = path.relative(repoRoot, absPath)`
   then replace all `\` with `/` — this is the canonical key used throughout.
3. Git output paths are already POSIX-relative; they match directly.

Only paths present in the caller-supplied `files` set are retained in the output
(`ChurnInfo` and `CoChangePair`). Paths git reports that fall outside the scanned
set (e.g. `pubspec.lock`, deleted files) are silently skipped.

### Output shape

```ts
// src/types.ts — already defined; reproduced here for clarity
interface ChurnInfo {
  relPath: string;   // project-relative POSIX path
  commits: number;   // commits touching this file in the window
  authors: number;   // distinct author count
  lastChange?: string; // ISO date of the most recent commit
}

interface CoChangePair {
  a: string;         // relPath, sorted so a < b (lexicographic)
  b: string;
  together: number;  // commits where both changed
  support: number;   // together / commits_touching_either (0..1)
}

interface GitInsightData {
  churn: ChurnInfo[];     // one entry per scanned file that appeared in history
  coChange: CoChangePair[]; // pairs with together >= 2 (noise filter)
  commitsScanned: number;
}
```

`coChange` is only populated here as a data contract; the hotspot spec does not
consume it — that is the temporal-coupling insight's concern.

### Public API

```ts
// src/git.ts
export interface GitOptions {
  commits?: number;    // default 500
  sinceDays?: number;  // default 365
}

export async function collectGit(
  root: string,          // absolute repo root (or project root; git will find .git)
  files: string[],       // absolute paths of scanned dart files
  opts?: GitOptions,
): Promise<GitInsightData>
```

Returns `{ churn: [], coChange: [], commitsScanned: 0 }` (no error thrown) when:
- `root` is not inside a git repository (`git rev-parse` exits non-zero)
- `git` is not on PATH
- The commit window yields zero commits (shallow clone with depth < `commits` and
  no commits newer than `sinceDays`)

A `console.warn` is emitted in these cases so the operator knows git data is absent.

---

## Hotspot insight (`computeHotspots` in `src/insights.ts`)

### Algorithm

Inputs: `graph: GraphData`, `git: GitInsightData`

1. Build a `churnByRelPath: Map<string, number>` from `git.churn`.
2. Compute **fan-in** per node: count of import-type edges where the node is the
   target. Call this `fanIn[nodeId]`.
3. Compute outlier thresholds over all *file* nodes that have at least one data
   point:
   - **Churn threshold:** value at the **80th percentile** of `churn` across
     scanned files present in git history. Files absent from history are treated
     as churn = 0 and excluded from the percentile calculation.
   - **Fan-in threshold:** `mean(fanIn) + 1 × stddev(fanIn)` across all file
     nodes. Pure leaf files (fanIn = 0) are included so the mean is realistic.
4. A node is a hotspot if **both** conditions hold:
   - `churn >= churnThreshold`
   - `fanIn >= fanInThreshold`
5. For each hotspot node, emit one `Insight`:
   - `id`: `hotspot:<nodeId>`
   - `severity`: `'high'` if `churn >= 2 × churnThreshold`, else `'medium'`
   - `title`: `<label> (churn: <N> commits, fan-in: <M>)`
   - `detail`: `"Changed <N> times in the analysis window and imported by <M>
     files. High-churn + high-fan-in = high refactor priority."`
   - `nodes`: `[nodeId]`

### Rationale for thresholds

80th-percentile for churn: avoids flagging the top quintile uniformly, focuses
on the tail. Mean+1SD for fan-in: catches genuine hubs while the majority of
files (fan-in 0 or 1) remain below the bar. Both thresholds are computed at
runtime so they adapt to the project size without per-project tuning.

### Integration points

**`src/graph-builder.ts` — `buildGraph`**

```ts
// After building nodes, attach churn from git.churn:
for (const c of inputs?.git?.churn ?? []) {
  const node = nodeByRelPath.get(c.relPath);
  if (node) node.churn = c.commits;
}
// Then pass inputs to computeInsights as before (backward compatible).
```

`node.churn` is `number | undefined`; absent when `--no-git` or no history.

**`src/insights.ts` — `computeInsights`**

`computeHotspots` is a private function called from `computeInsights` when
`inputs?.git` is present. Its `InsightCategory` entry:

```ts
{
  key: 'hotspot',
  label: 'Hotspots',
  description:
    'Files that are both frequently changed (high churn) and heavily ' +
    'imported (high fan-in). High refactor priority — a change ripples far.',
  items: [...findings],
}
```

---

## CLI flag: `--no-git`

Added to `parseArgs` in `src/cli.ts`. When set, `collectGit` is never called;
`inputs.git` remains `undefined`; hotspot and temporal-coupling categories are
omitted from the report. Default is to run git collection (the single `git log`
call is fast, typically < 2 s for 500 commits on a local repo).

```
--no-git    Skip git history mining (disables hotspot + temporal-coupling insights)
```

---

## Web UI: "Size by churn" toggle

`web/app.js` gains a toggle button in the toolbar (alongside existing view
switcher buttons). When active:

- Node size is mapped from `data.churn` (the `GraphNode.churn` value echoed into
  the cytoscape element's data object by the existing data-loading path).
- Mapping: linear scale, `min-size = 20px`, `max-size = 60px`, clamped at the
  99th percentile of churn values present in the graph (avoids one extreme outlier
  dominating the scale).
- Nodes without `churn` data render at the default size.
- The hotspot `InsightCategory` items highlight nodes when clicked (standard
  generic insight-panel behavior — no special UI code needed).

Implementation note: the cytoscape style update is a single `cy.style().update()`
call after modifying the size mapper. No server round-trip is needed — `churn`
is already embedded in `graph.json`.

---

## Performance

| Step | Typical cost (venio ~592 files) |
|---|---|
| `git rev-parse --show-toplevel` | < 50 ms |
| `git log --name-only … -- <592 files>` | 1–3 s (500 commits, local) |
| In-process parse + aggregation | < 100 ms |
| Total | < 4 s |

The scanned file list is passed as positional arguments directly to git. Argument
list length for 592 files is well within OS limits. For very large monorepos
(> 5 000 files), callers may need to chunk, but that is out of scope here.

---

## Edge cases

| Condition | Behaviour |
|---|---|
| Not a git repo | `collectGit` returns empty `GitInsightData`; `console.warn`; hotspot category absent from report |
| Shallow clone (depth < `commits`) | git walks to the earliest available commit; `commitsScanned` reflects actual count; thresholds computed on available data |
| All files have churn = 0 | No hotspot findings (percentile = 0; threshold logic requires `churn >= threshold` where threshold > 0 — enforced by `if (churnThreshold === 0) return []`) |
| `git` not on PATH | `spawnSync` throws ENOENT; caught; `console.warn`; returns empty |
| File appears in git but not in scanned set | Silently skipped (filtered out by the `files` set membership check) |
| Renamed file | Old path accumulates history; new path starts fresh. No attempt to follow renames (would require `--follow`, one call per file — unacceptable cost). Document in CLI `--help`. |
| Single author repo | `authors = 1` for all entries; hotspot logic is unaffected (author count is metadata only, not a threshold input) |
| Ties at the 80th-percentile boundary | Both tied files are included (`>=` comparison). |

---

## Determinism caveats

Git history is **not** static:
- New commits shift the window; the same file's churn count rises over time.
- Rebases and force-pushes rewrite history; `commitsScanned` and all counts change.
- `--json` output from two runs on the same repo at different times will differ.

This is expected and documented. `--check` / `--baseline` diff mode is not
affected: it compares *findings by id*, and `hotspot:<nodeId>` ids are stable
as long as the file exists and remains above both thresholds.

---

## Testing

| Test | Location | What it checks |
|---|---|---|
| `git.test.ts` — happy path | `test/git.test.ts` | Feed a fake `git log` stdout string into the parser; assert `ChurnInfo` counts + `commitsScanned` |
| `git.test.ts` — Windows paths | same | Fake `git rev-parse` output with POSIX `/c/Users/…` form; assert relPath normalisation |
| `git.test.ts` — not a repo | same | Stub `git rev-parse` exit 128; assert empty return, no throw |
| `insights.test.ts` — hotspot thresholds | `test/insights.test.ts` | Synthetic graph with known churn + fan-in distribution; assert correct files flagged at 80th-pct / mean+SD |
| `insights.test.ts` — all-zero churn | same | Assert empty findings, no division-by-zero |
| Integration smoke | `test/smoke.test.ts` (existing) | Run with `--json` against venio; assert `insights.summary.hotspot` is a non-negative integer |

---

## Out of scope

- Following renames (`--follow`) — O(files) git calls; not acceptable for the
  single-call budget.
- Author-level attribution or blame (`git blame`) — out of scope for this insight.
- Co-change / temporal-coupling insight — shares `GitInsightData` but is specified
  separately.
- Remote git hosts (GitHub API) — all analysis is local.
- Churn weighting by lines changed (`--numstat`) — commit count is sufficient and
  faster to parse.
- Configurable percentile or fan-in multiplier via `.pagemapper.json` — can be
  added later; hardcoded defaults are good enough for v1.
