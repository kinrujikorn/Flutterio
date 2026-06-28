# Temporal Coupling (Co-Change) Insight

**Date:** 2026-06-27
**Status:** Draft

## Purpose

Reveal pairs of files that habitually change together in the same commit even
though no import edge connects them. These pairs represent real coupling that
static analysis cannot see: shared data contracts, coordinated config changes,
parallel feature work that never merged, or implicit runtime dependencies. Left
unchecked, they cause surprise breakage when one file is modified without its
hidden partner.

The insight surfaces as the `temporal-coupling` category in `InsightsReport`.
It depends on `GitInsightData` (from `src/git.ts`) being supplied; when git
history is unavailable the category is simply omitted.

## Design

### Data collection — `src/git.ts`

`collectGit(root, files, opts)` runs once per analysis pass:

```ts
collectGit(
  root: string,                              // project root (abs)
  files: ScannedFile[],                      // scanned file set
  opts: { commits?: number; sinceDays?: number }
): Promise<GitInsightData>
```

It executes one `git log` invocation scoped to the project root:

```
git log --name-only --pretty=format:__COMMIT__%H__%ae__%ai -n <commits> [--since=<N>.days]
```

Each commit record is parsed into:
- `hash`, `authorEmail`, `date` (ISO string)
- `changedFiles`: raw paths from `--name-only` output, mapped to project-relative
  POSIX paths. Only files present in the scanned set are kept (external paths,
  deleted files, and unresolvable paths are dropped).

From these records, `collectGit` computes:

**Churn (`ChurnInfo[]`)** — per file: commit count, distinct author count,
most recent commit date. Straight aggregation over all commits touching the file.

**Co-change (`CoChangePair[]`)** — per unordered file pair `{a, b}` (a < b
lexicographically for stable ids):
- `together` = number of commits where both a and b appear in `changedFiles`
- `support` = `together / |commits touching a OR b|`

Only pairs whose `together >= MIN_TOGETHER` AND `support >= MIN_SUPPORT` survive.
See Thresholds below.

**Mega-commit exclusion:** commits that touch more than `MAX_FILES_PER_COMMIT`
project files (default 30) are skipped entirely before pair counting. A commit
touching 200 files generates ~20000 pairs and contributes no useful signal; it is
a mass-refactor or auto-format run, not implicit coupling.

Output is sorted by `together DESC, support DESC` and capped at `TOP_K` pairs
(default 200) before being stored in `GitInsightData.coChange`. This bounding
happens in `collectGit` so the insight engine only sees the pre-filtered list.

### Insight computation — `insights.ts`

`computeTemporalCoupling(graph, git)` is called from `computeInsights` when
`inputs.git` is present:

```ts
function computeTemporalCoupling(
  graph: GraphData,
  git: GitInsightData
): InsightCategory
```

For each `CoChangePair` in `git.coChange`:
1. Resolve `a` and `b` to node ids (match `GraphNode.path`). Skip the pair if
   either file is not in the graph (deleted, outside scanned set, etc.).
2. Check for an existing import edge in either direction between the two nodes.
   If an import edge exists, the coupling is already visible to static analysis
   — skip the pair (not a hidden dependency).
3. Also skip if the pair shares the same feature AND the coupling is a
   presentation↔data or data↔domain import that would be expected under Clean
   Architecture. These are low-information findings; let the `layer-violation`
   category handle structural issues.
4. Emit one `Insight` per surviving pair.

#### Insight shape

```ts
{
  id: `tc:${a}::${b}`,          // stable; a<b sorted
  severity: deriveSeverity(pair),
  title: `${basename(a)} ↔ ${basename(b)}`,
  detail: `Changed together ${together}× (support ${(support*100).toFixed(0)}%) `
        + `with no import edge — hidden coupling.`,
  nodes: [nodeIdFor(a), nodeIdFor(b)],
  edges: [],                    // no edge to highlight; there is none
}
```

Severity derivation:

| `together` | `support` | severity |
|---|---|---|
| >= 10 | >= 0.7 | `high` |
| >= 5  | >= 0.5 | `medium` |
| otherwise (>= MIN thresholds) | | `low` |

### Thresholds (compile-time constants in `src/git.ts`)

| Constant | Default | Rationale |
|---|---|---|
| `MIN_TOGETHER` | 3 | Fewer than 3 co-changes is noise; three is the minimum pattern |
| `MIN_SUPPORT` | 0.5 | At least half the commits touching either file touched both |
| `MAX_FILES_PER_COMMIT` | 30 | Caps mega-commit pair explosion; auto-format runs have 100+ files |
| `TOP_K` | 200 | Bounds the co-change list; pairs beyond 200 have low `together` anyway |

These constants are exported so callers can override them in tests without
rebuilding. They are NOT CLI flags (too niche; advanced users can adjust source).

## Data contract

Relevant types (from `src/types.ts` — do not redeclare):

```ts
interface CoChangePair {
  a: string;        // relPath, a < b lexicographically
  b: string;
  together: number;
  support: number;  // 0..1
}

interface GitInsightData {
  churn: ChurnInfo[];
  coChange: CoChangePair[];
  commitsScanned: number;
}

// InsightKey already includes 'temporal-coupling'.
// InsightInputs.git?: GitInsightData enables the category.
```

`InsightCategory` for temporal coupling:

```ts
{
  key: 'temporal-coupling',
  label: 'Temporal Coupling',
  description:
    'File pairs that change together frequently but share no import edge '
    + '— hidden dependencies invisible to static analysis.',
  items: Insight[],   // one per surviving pair
}
```

## Integration points

**`src/graph-builder.ts` / `buildGraph`:** already receives `inputs?: InsightInputs`
and forwards it to `computeInsights`. No further changes needed for the insight
to appear — just supply `inputs.git`.

**`src/cli.ts`:** `--no-git` skips `collectGit`, leaving `inputs.git` undefined,
and the temporal-coupling category is absent. Default (git history available):
`collectGit` is called with `{ commits: 500 }`. The flag `--baseline` / diff mode
work without change because `diffGraphs` keys findings by `category + id`.

**Web UI:** the `temporal-coupling` category renders automatically through the
generic insight panel (no UI code changes needed). The detail panel's "Impact /
blast radius" section still works: the two highlighted nodes are reachable via the
existing reverse-transitive-closure traversal even though there is no edge between
them (the nodes themselves are highlighted, not an edge path).

**`GraphNode.churn`:** populated by `buildGraph` from `ChurnInfo.commits` matched
by `relPath`. The "Hotspots" display toggle in the UI sizes nodes by this field.
Temporal coupling findings are complementary: hotspots identify frequently changed
individual files; temporal coupling identifies pairs that change together.

## Edge cases

- **Renamed files:** `git log --name-only` shows the name at commit time. If a
  file was renamed after the window, the old name won't match any `ScannedFile`
  and the pair is silently dropped. Acceptable; the rename itself is a commit that
  resets co-change counts.
- **Git not available:** `collectGit` rejects with an error. `cli.ts` catches it,
  logs a warning (`[git] skipping history: <reason>`), and continues with
  `inputs.git = undefined`. The category is absent from output.
- **Monorepo with many packages:** pairs that cross package boundaries are allowed
  and are often the most interesting (cross-package hidden coupling). No special
  filtering.
- **Single-author projects:** `authors` in `ChurnInfo` will be 1 for every file;
  that field is for context only and does not affect temporal coupling logic.
- **Short history (< MIN_TOGETHER commits total):** `git.coChange` will be empty;
  the category appears with zero items (not suppressed) so the UI signals the
  feature ran but found nothing.
- **Pair already covered by an existing insight:** no deduplication. A pair flagged
  as `temporal-coupling` may also appear indirectly in `god-file` or
  `circular-dep`. Each category is independent.

## Testing

Unit tests (`test/temporal-coupling.test.ts`):

1. **Basic detection:** construct a `GitInsightData` with one pair `(a, b,
   together=5, support=0.6)`, a `GraphData` with nodes for both files and no
   import edge between them. Assert the category contains exactly one finding with
   the correct id, severity `medium`, and `nodes = [idA, idB]`.

2. **Import edge suppression:** add an import edge `a → b` to the graph. Assert
   the pair is absent from the category.

3. **Threshold filtering:** pairs with `together=2` or `support=0.3` must not
   appear.

4. **Severity bands:** verify all three severity derivations using fabricated
   pairs at the boundary values in the severity table.

5. **Mega-commit exclusion:** in `collectGit` unit: a synthetic commit log with
   40 files must not contribute any pairs to `coChange`. A commit with 10 files
   must contribute.

6. **TOP_K cap:** generate 300 pairs all above threshold; assert `coChange.length
   <= 200` and the retained pairs are the top-200 by `together`.

7. **Git unavailable:** mock `git log` to reject; assert `buildGraph` succeeds,
   `insights.categories` contains no `temporal-coupling` entry.

Integration smoke test: run `collectGit` against the `Flutterio` repo itself
(small history), assert `GitInsightData` shape is valid and `commitsScanned > 0`.

## Out of scope

- **Tri-file (or N-way) co-change groups** — pairwise is sufficient for actionable
  findings; N-way mining is combinatorially expensive and rarely more useful.
- **Branch-aware history** — only the default `HEAD` lineage is mined. Merge
  commits are included; their changed-file lists are the union across parents from
  `--name-only`.
- **Configurable thresholds via CLI or `.pagemapper.json`** — the constants are in
  source; the policy system (`PolicyConfig`) handles architectural rules, not
  mining parameters.
- **Displaying a synthetic "co-change edge" in the Cytoscape graph** — adding
  phantom edges risks confusing the import-edge-based layout. Findings are surfaced
  through the insights panel only, with node highlighting.
- **Time-decay weighting** (recent commits count more) — uniform counting is
  simpler, deterministic, and sufficient for the initial signal.
