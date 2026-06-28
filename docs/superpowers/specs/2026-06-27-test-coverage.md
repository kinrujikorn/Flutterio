# Test Coverage Mapping — Design Spec

**Date:** 2026-06-27
**Status:** Draft

## Purpose

Surface which pages have no test file referencing them, giving teams a fast,
zero-setup signal of blind spots in their test suite without requiring a coverage
run or instrumented build. The result appears as the `untested-page` insight
category and as a `tested` boolean on each `GraphNode`.

## Why pages, not all files (v1 rationale)

Flagging every uncovered file would produce hundreds of findings in a typical
monorepo — domain entities, DTOs, constants, generated code — most of them
unactionable noise. Pages (route targets, `*Page` classes) are the highest-signal
boundary: they are user-visible, often contain conditional logic, and are the
most likely entry points for both manual QA and widget tests. Restricting v1 to
`kind: 'page'` nodes keeps the finding list short enough to act on.

## Design

### 1. Scanner — collecting test files

`scanner.ts` already classifies files. It gains a parallel walk: any `.dart` file
under a `test/` or `integration_test/` directory (anywhere in the monorepo) is
appended to `ScanResult.testFiles` as a `ScannedTestFile { absPath, relPath }`.
These files are **never** added to `ScanResult.files` and never become graph nodes;
they are a separate input lane consumed only by `coverage.ts`.

### 2. `src/coverage.ts` — import-based coverage computation

```ts
import type { ScanResult } from './types.js';

export interface CoverageResult {
  /** Project-relative POSIX paths referenced (directly or transitively through
   *  one barrel) by at least one test file. */
  coveredRel: string[];
}

export function computeCoverage(scan: ScanResult): CoverageResult;
```

**Algorithm (single-pass, shallow):**

1. Build a `Set<string>` of all known source `relPath` values from `scan.files`
   for O(1) membership tests.
2. For each `ScannedTestFile` in `scan.testFiles`:
   a. Read the file with `fs.readFileSync`.
   b. Build a parse context: `buildContext(testFile.absPath, scan)` from
      `parser/context.ts` — provides package-root lookup for `package:` URI
      resolution.
   c. Call `parseImports(source, context)` from `parser/imports.ts` — returns
      `ImportEdge[]` with `toRel` already resolved to project-relative paths.
   d. For each edge where `!edge.external && edge.toRel !== null`: if `toRel` is
      in the known-source set, add it to the `covered` accumulator.
3. Return `{ coveredRel: [...covered] }`.

`computeCoverage` does not recurse into imported files — it operates one import
hop from the test file. This is intentional (see Limits below).

### 3. Graph builder — stamping `node.tested`

`buildGraph(scan, parse, inputs?)` in `src/graph-builder.ts` already accepts an
optional `InsightInputs` argument. When `inputs?.coveredRel` is present, the
builder stamps each `GraphNode` whose `path` appears in `coveredRel` with
`tested: true`; all other nodes get `tested: false`. Nodes for which the
coverage pass did not run leave `tested` absent (`undefined`), preserving
backward compatibility with callers that pass only two arguments.

The `path` field on a `GraphNode` of `kind: 'page'` is the `fileRel` of the
`PageInfo` that produced it (the file declaring the `*Page` class). The same
`relPath` is what `computeCoverage` emits, so the join is a direct string
equality on POSIX paths.

### 4. Insights engine — `computeUntestedPages`

`computeInsights(graph, inputs?)` in `src/insights.ts` gains:

```ts
function computeUntestedPages(graph: GraphData): InsightCategory {
  // key: 'untested-page'
  // label: 'Untested Pages'
  // description: 'Pages with no test file that imports them — no widget or
  //   integration test references this page.'
}
```

Fires for every node where `node.kind === 'page' && node.tested === false`.
(`tested === undefined` means coverage didn't run; those nodes are skipped so
the category stays empty and does not appear in the UI.)

Each `Insight` item:

| Field    | Value |
|----------|-------|
| `id`     | `node.id` |
| `severity` | `'medium'` — untested pages are a gap, not an architectural error |
| `title`  | `node.label` (the page class name) |
| `detail` | `"No test file imports <fileRel>. Consider adding a widget or integration test."` |
| `nodes`  | `[node.id]` |
| `edges`  | omitted |

The category only attaches to `InsightsReport` when `inputs?.coveredRel` was
provided; when absent the category is not emitted (backward-compatible).

### 5. CLI wiring

No new flags are needed. The coverage pass runs automatically when
`scan.testFiles` is non-empty (which it is whenever the scanner finds test
files — that is, always, unless `--no-lsp` or a custom scanner skip list
excluded those directories). `computeCoverage(scan)` is called in `cli.ts`
after the scan, its result is passed into `buildGraph` as part of `InsightInputs`,
and the engine does the rest.

Cost: reading every test file adds one `fs.readFileSync` + one regex parse per
test file. For a monorepo with ~100 test files this is <100 ms and does not
affect the watch-mode hot path (the coverage result is computed once at startup
and not recomputed on file-change unless a test file itself changes).

## Data contract

```ts
// src/types.ts (already present — listed here for completeness)

interface ScannedTestFile {
  absPath: string;
  relPath: string;
}

interface ScanResult {
  // ...existing fields...
  testFiles?: ScannedTestFile[];   // absent when scanner skips test dirs
}

interface GraphNode {
  // ...existing fields...
  tested?: boolean;  // true=covered, false=uncovered, absent=not run
}

// InsightInputs.coveredRel?: string[]  — project-relative POSIX paths
```

`computeCoverage` is a pure function of `ScanResult`; it has no network I/O,
no git calls, and no side effects. It is safe to call in parallel with other
pipeline stages that don't write to the filesystem.

## Heuristic limits and known false-negatives

**Barrel re-exports.** If a test imports `package:auth/auth.dart` (a barrel)
that re-exports `login_page.dart`, the coverage pass marks only the barrel
as covered, not `login_page.dart`. The shallow single-hop design makes this
the most common false-negative. Mitigation: teams that use barrel imports
heavily will see more untested-page findings than they expect; the detail text
explains the import-based heuristic so they can investigate.

**Generated files.** Files under `*.g.dart` or `*.freezed.dart` are already
excluded from `ScanResult.files` by the scanner; they cannot appear in
`coveredRel` regardless.

**Integration tests importing only `main.dart`.** A full-app integration test
typically imports only the app entrypoint. It covers every page at runtime but
the static import graph shows only one file. These pages are marked untested.
This is a known limitation of the static-analysis approach vs. a real coverage
run.

**Pages declared in the same file as a widget.** If a file declares both
`SomePage` and `SomeWidget` and a test imports the file (targeting `SomeWidget`),
the page is also marked covered. This is a false-positive, not a false-negative,
so it is acceptable noise (under-reports untested pages).

## Combination with `dead-page`

A page that is both dead (no incoming `navigate` edges) and untested is flagged
by two separate categories. The UI renders each category independently. Teams
can cross-filter: a dead + untested page is the lowest-priority candidate for
coverage investment; an untested page that is heavily navigated-to is the
highest priority.

`computeUntestedPages` and `computeDeadPages` are independent functions sharing
no state; either can run without the other.

## Testing

- **Unit — `coverage.ts`:** synthetic `ScanResult` with two source files and one
  test file that imports one of them → `coveredRel` contains exactly that file.
  Second case: test file imports an external package only → `coveredRel` is empty.
- **Unit — `computeUntestedPages`:** graph with three page nodes (`tested: true`,
  `tested: false`, `tested: undefined`) → exactly one finding, for the `false`
  node.
- **Integration:** run `--json` against the venio monorepo; assert that
  `insights.summary['untested-page']` is a non-negative integer; assert that
  every node with `tested: true` has its `path` in a test file's import list
  (spot-checked for two known widget tests).
- **Barrel edge case:** test file that imports a barrel re-exporting a page →
  the page is **not** in `coveredRel` (confirms shallow-pass behaviour is stable,
  not accidentally widened).

## Out of scope

- **Line/branch coverage** — requires `flutter test --coverage` and LCOV parsing;
  adds a build dependency and significant latency. Deferred.
- **Widget-level coverage** — tracking which individual widgets inside a page are
  exercised; requires AST-level analysis or runtime instrumentation.
- **Transitive import closure** — following imports recursively from test files;
  would widen `coveredRel` substantially and make the heuristic harder to reason
  about. Revisit if barrel false-negatives become a significant complaint.
- **Coverage trend over time** — comparing covered-page counts across runs;
  handled by the separate diff/baseline feature (`src/diff.ts`).
