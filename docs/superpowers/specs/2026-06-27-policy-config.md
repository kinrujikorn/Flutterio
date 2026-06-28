# Architecture Policy (.pagemapper.json)

**Date:** 2026-06-27
**Status:** Draft

## Purpose

Turn PageMapper's fixed 7 lint rules into an extensible, project-owned policy
engine. Teams declare forbidden cross-module dependencies in a `.pagemapper.json`
file at the project root. The analyzer reads it once at startup and surfaces
violations as `policy-violation` insights — the same way `dependency-cruiser`
lets teams encode custom architecture constraints as checked-in configuration.

Primary questions answered: *"Does any feature import another feature's
internals?"*, *"Does the auth package ever reach into billing?"*, *"Does any
new file in `legacy/` slip through to production code?"*

## Design

### Module: `src/policy.ts`

Two exported functions:

```ts
export function loadPolicy(root: string): PolicyConfig;
export function evaluatePolicy(graph: GraphData, cfg: PolicyConfig): Insight[];
```

`loadPolicy` is a pure I/O function; `evaluatePolicy` is a pure function over
the graph — both are individually unit-testable.

### Config discovery

`loadPolicy(root)` looks for `.pagemapper.json` at `path.join(root, '.pagemapper.json')`.
`root` is the project root passed to the CLI (same value used by `scanner.ts`).
No recursive parent search — one deterministic location per project.

### `.pagemapper.json` schema

```jsonc
{
  "forbidden": [
    {
      "name": "No cross-feature imports into auth internals",
      "from": "*",
      "to": "feature:auth",
      "severity": "high"
    },
    {
      "name": "auth must not reach billing",
      "from": "feature:auth",
      "to": "feature:billing"
    },
    {
      "name": "No direct legacy usage",
      "from": "*",
      "to": "path:**/legacy/**",
      "severity": "medium"
    },
    {
      "name": "domain must not depend on presentation",
      "from": "layer:domain",
      "to": "layer:presentation"
    },
    {
      "name": "Lock down a specific package",
      "from": "package:core",
      "to": "pkg:design_system"
    }
  ]
}
```

All fields follow `PolicyConfig` / `PolicyRule` in `src/types.ts`.

### Selector grammar

A selector is a string matched against a `GraphNode`. Evaluation order:

| Prefix | Matches on | Example |
|---|---|---|
| `package:NAME` or `pkg:NAME` | `node.package === NAME` | `package:auth` |
| `feature:NAME` or `feat:NAME` | `node.feature === NAME` | `feature:billing` |
| `layer:NAME` | `node.layer === NAME` | `layer:domain` |
| `path:GLOB` | `minimatch(node.path, GLOB)` — path relative to project root | `path:**/legacy/**` |
| `*` | any node (always true) | `*` |
| bare GLOB (no prefix) | `minimatch(node.relPath, GLOB)` — shorthand for `path:` | `**/legacy/**` |

`NAME` is an exact equality check (case-sensitive). GLOB uses `minimatch` with
`{ dot: true }` so dotfiles and nested `**/` patterns work as expected.

### Matching semantics

`evaluatePolicy` iterates over every edge where `edge.type === 'import'`.
For each edge it resolves the source node and target node from `graph.nodes`.
A rule fires if and only if:

```
matchesSelector(sourceNode, rule.from) && matchesSelector(targetNode, rule.to)
```

Both conditions must hold simultaneously. Rules are independent — all rules are
checked against every import edge; multiple rules can fire on the same edge.

The same edge can be flagged by more than one rule. Each rule produces its own
`Insight` (distinct `id`), so the UI and `--check` counter reflect every
distinct violation.

### Output shape

`evaluatePolicy` returns `Insight[]` for consumption by `computeInsights` in
`insights.ts`. The caller wraps the array into an `InsightCategory`:

```ts
{
  key: 'policy-violation',
  label: 'Policy Violations',
  description: 'Import edges forbidden by .pagemapper.json rules.',
  items: evaluatePolicy(graph, cfg),
}
```

Each `Insight` produced:

```ts
{
  id: `policy:${ruleIndex}:${edge.id}`,   // stable across runs while graph is stable
  severity: rule.severity ?? 'high',
  title: rule.name ?? `${rule.from} → ${rule.to}`,
  detail: `Import from ${sourceNode.path} to ${targetNode.path} is forbidden by rule "${rule.name ?? rule.from + ' → ' + rule.to}".`,
  nodes: [edge.source, edge.target],
  edges: [edge.id],
}
```

`ruleIndex` is the 0-based index in `cfg.forbidden` for stable ids even when
`name` is absent.

### Severity default

If a `PolicyRule` omits `severity`, the violation is treated as `'high'`. This
is explicit in the type definition (`severity?: Severity` with a documented
default) so callers need not special-case it.

### Integration into the pipeline

`graph-builder.ts` → `buildGraph(scan, parse, inputs?)`:

1. If `inputs?.policy` is present, pass it to `computeInsights` via `InsightInputs`.
2. `computeInsights` calls `evaluatePolicy(graph, inputs.policy)` and appends
   the resulting `InsightCategory` to `InsightsReport.categories`.
3. `buildGraph` is backward-compatible: callers that pass no `inputs` get the
   original 7 categories, no policy evaluation runs.

`cli.ts` wires policy automatically: after scanning, call
`loadPolicy(projectRoot)` and attach the result to `InsightInputs.policy` before
calling `buildGraph`. No new CLI flag required — presence of `.pagemapper.json`
is the opt-in.

## Data contract

```ts
// src/types.ts — already present, shown for reference

export interface PolicyRule {
  name?: string;       // shown in finding title and detail
  from: string;        // selector — see grammar above
  to: string;          // selector — see grammar above
  severity?: Severity; // default 'high'
}

export interface PolicyConfig {
  forbidden?: PolicyRule[];
}

// InsightInputs (partial, relevant field):
export interface InsightInputs {
  policy?: PolicyConfig;
  // ...
}
```

## Edge cases

| Situation | Behaviour |
|---|---|
| No `.pagemapper.json` | `loadPolicy` returns `{}`. `evaluatePolicy` with empty `forbidden` returns `[]`. No `policy-violation` category emitted. |
| File exists but is not valid JSON | `loadPolicy` catches the parse error, prints `[pagemapper] warn: .pagemapper.json is not valid JSON — ignoring.` to stderr, returns `{}`. |
| File exists but has unexpected fields | Extra fields are ignored (no strict schema validation at runtime). |
| `forbidden` present but empty array | `evaluatePolicy` returns `[]`. No findings, no category. |
| `from` or `to` is an unrecognised prefix (e.g. `"xyz:foo"`) | Treated as a bare glob (`minimatch(node.relPath, selector)`). Logs a warning once per unknown prefix if `process.env.DEBUG` is set. |
| Source or target node not found in graph | Edge is skipped silently (graph consistency is `graph-builder.ts`'s responsibility). |
| Multiple rules match the same edge | Each rule produces a separate `Insight`. The UI and `--check` counter count each separately. |
| `severity` set to a value outside `high\|medium\|low` | Treated as `'high'` (fallback). |
| Project root is not a git repo | Not relevant to this module — `loadPolicy` only reads a JSON file. |

## Testing

**Unit tests (`test/policy.test.ts`):**

1. `loadPolicy` returns `{}` when `.pagemapper.json` is absent.
2. `loadPolicy` returns `{}` and logs a warning when the file is malformed JSON.
3. `loadPolicy` returns the parsed config when the file is well-formed.
4. `evaluatePolicy` returns `[]` for empty `forbidden`.
5. `evaluatePolicy` fires on a `package:` selector that matches.
6. `evaluatePolicy` does NOT fire when only `from` matches (`to` does not).
7. `evaluatePolicy` fires on `feature:` selector.
8. `evaluatePolicy` fires on `layer:` selector.
9. `evaluatePolicy` fires on `path:GLOB` selector with a nested path.
10. `evaluatePolicy` fires on bare glob selector (no prefix).
11. `evaluatePolicy` uses `'high'` severity when `rule.severity` is absent.
12. `evaluatePolicy` uses the rule's severity when present.
13. `evaluatePolicy` ignores non-`import` edges.
14. Two rules matching the same edge produce two separate findings.

**Smoke test:**
Run `node dist/cli.js <venio-path> --json /tmp/out.json` with a
`.pagemapper.json` that forbids `layer:domain → layer:presentation`. Assert
`insights.summary['policy-violation'] > 0` (venio has at least one such edge).

## Future extensions (out of scope now)

- **Allow exceptions** — `allow` list within a rule; a matching edge is
  exempted even if it matches a `forbidden` rule (dependency-cruiser pattern).
- **Required dependencies** — `required` array: at least one import from
  `from` to `to` must exist, else a violation fires.
- **Custom layer ranks** — `.pagemapper.json` could define a `layers` array
  to replace the hard-coded `domain | data | presentation | other` ordering
  used by `layer-violation`.
- **`--policy <file>`** CLI flag — load policy from a path other than
  `.pagemapper.json` (useful for CI environments with multiple profiles).
- **JSON Schema for `.pagemapper.json`** — publish a `$schema` URL so editors
  give autocomplete.
