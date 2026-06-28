# Impact / Blast-Radius Analysis — Design Spec

**Date:** 2026-06-27
**Status:** Draft
**Feature area:** Web UI (`web/app.js`) — client-side only

---

## Purpose

When a developer selects a file node, answer two questions immediately:

1. **"If I change this file, what breaks?"** — the reverse transitive closure
   over `import` edges: every file that transitively imports the selected node.
2. **"What does this file depend on?"** — the forward transitive closure: every
   file this node transitively imports.

Surface counts (direct dependents, total transitive dependents, affected
features, affected pages) in the detail panel and let the user highlight the
blast-radius set on the graph with one click.

The computation runs entirely in the browser over `state.data` — no round-trip
to the server, no changes to `graph.json`, no new API endpoint.

---

## Design

### Why client-side BFS over the full edge set

The feature is intentionally **not** precomputed by the producer (`graph-builder.ts`):

- Precomputed transitive-closure matrices are O(N²) in space; at 600 nodes that
  is 360 000 pairs before any serialization overhead. Keeping `graph.json` small
  matters (it is fetched on every page load and embedded wholesale in `--export`
  HTML).
- Blast radius is **filter-dependent in display** but must be computed over the
  full graph for correctness. Running BFS in JS over ~600 nodes with ≤ 3 000
  edges takes < 2 ms (see Performance section); the cost is negligible.
- Rerunning on every selection naturally reflects the current `state.data` (which
  updates on SSE live reload) without any cache invalidation logic.
- Producer-side precomputation would also need to be re-run whenever the user
  switches focus/filter context — the client already has everything it needs.

### Algorithm

Two BFS passes per selection, each over `state.data.edges` (not the Cytoscape
visible set):

```ts
// Build adjacency on first use per data version; invalidate when state.data changes.
// Forward adjacency: source -> [target, ...]
// Reverse adjacency: target -> [source, ...]

function buildAdjacency(edges: GraphEdge[], edgeType: 'import' | null) {
  const fwd = new Map<string, Set<string>>();
  const rev = new Map<string, Set<string>>();
  for (const e of edges) {
    if (edgeType && e.type !== edgeType) continue;
    if (!fwd.has(e.source)) fwd.set(e.source, new Set());
    fwd.get(e.source)!.add(e.target);
    if (!rev.has(e.target)) rev.set(e.target, new Set());
    rev.get(e.target)!.add(e.source);
  }
  return { fwd, rev };
}

function bfs(start: string, adj: Map<string, Set<string>>): Set<string> {
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of (adj.get(cur) ?? [])) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  visited.delete(start); // exclude the selected node itself
  return visited;
}
```

Only `import` edges participate. `navigate`, `uses`, and `api` edges represent
runtime relationships that do not imply compile-time breakage; including them
would overstate the blast radius.

**Direct dependents** = `rev.get(nodeId) ?? new Set()` (one hop only, before BFS).

**Transitive dependents** = `bfs(nodeId, rev)` (all ancestors in the import
DAG — cycles are handled by the `visited` guard).

**Forward closure** = `bfs(nodeId, fwd)` (all transitive dependencies).

### Adjacency cache

Build the adjacency maps once per `state.data` version. Invalidate (rebuild) when
`state.data` is replaced (SSE reload). Store as a module-level variable:

```js
var _adjCache = null; // { fwd, rev, dataId }

function getAdj() {
  var dataId = state.data.generatedAt; // stable string per snapshot
  if (!_adjCache || _adjCache.dataId !== dataId) {
    _adjCache = { dataId: dataId, ...buildAdjacency(state.data.edges, 'import') };
  }
  return _adjCache;
}
```

This means the first selection after a reload pays the build cost (~1 ms); all
subsequent selections within the same data snapshot are O(N + E) BFS only.

### Derived metrics

Given `dependents` (transitive reverse closure set) and `nodeMap` (id → GraphNode):

```ts
directDependents:      rev.get(id).size          // 1-hop importers
transitiveDependents:  dependents.size            // full reverse closure
affectedFeatures:      new Set(
                         [...dependents].map(id => nodeMap[id]?.feature).filter(Boolean)
                       ).size
affectedPages:         [...dependents].filter(id => nodeMap[id]?.kind === 'page').length
forwardDeps:           forwardClosure.size        // what this file pulls in
```

---

## UI placement — `showDetail`

Insert an **"Impact"** section immediately after the existing metrics row
(lines/imports/exports counts) and before the neighbors list in the detail panel.
The section renders only for `kind === 'file'` nodes; page nodes omit it.

```
┌─────────────────────────────────────────────────────┐
│  auth/presentation/login_page.dart                  │
│  package: auth · layer: presentation                │
│                                                     │
│  ── Impact ────────────────────────────────────     │
│  Direct importers:      3                           │
│  Transitive dependents: 14  (2 features, 1 page)   │
│  Forward dependencies:  22                          │
│                                                     │
│  [Highlight blast radius]  [Clear]                  │
│                                                     │
│  ── Neighbors ─────────────────────────────────     │
│  ...                                                │
└─────────────────────────────────────────────────────┘
```

"Highlight blast radius" adds a CSS class `blast-radius` to all Cytoscape nodes
in the transitive-dependents set and dims the rest (same mechanism as the
existing neighbor-highlight). "Clear" removes the class and restores normal
appearance. If the user selects a new node while blast-radius is active, clear
and recompute for the new node automatically.

The count line collapses features/pages into a parenthetical so the numbers
remain scannable without extra rows:

```js
// e.g. "14  (2 features, 1 page)"
var detail = [];
if (affectedFeatures > 0) detail.push(affectedFeatures + ' feature' + (affectedFeatures !== 1 ? 's' : ''));
if (affectedPages > 0)    detail.push(affectedPages + ' page' + (affectedPages !== 1 ? 's' : ''));
var suffix = detail.length ? '  (' + detail.join(', ') + ')' : '';
```

---

## Interaction with focus mode and filters

- **BFS always runs over `state.data.edges`** (the full unfiltered edge set).
  This is intentional: a file that is hidden by the current feature filter may
  still transitively import the selected node; omitting it would undercount the
  true blast radius.
- **Highlight respects the current visible set:** only Cytoscape nodes that are
  currently rendered (i.e. pass the active filter) are styled with
  `blast-radius`; nodes that exist in the closure but are filtered out do not
  receive the class. The count in the panel still reflects the full closure so
  the developer sees the true number.
- **Focus mode** (existing feature that collapses to a subgraph) is compatible:
  entering focus mode while blast-radius is active clears the blast-radius
  highlight (the focus subgraph replaces the cy element set). The Impact section
  in the panel remains and the button can be pressed again to re-highlight within
  the focus view.
- **Live reload (SSE):** when `state.data` is replaced, clear any active
  blast-radius highlight and clear `_adjCache`; the next selection rebuilds from
  the new data.

---

## Performance

Target graph: ~600 nodes, ~3 000 edges (venio-mobile-app).

- **Adjacency build:** two `Map` inserts per edge = ~6 000 operations, well
  under 1 ms.
- **BFS:** worst case visits all 600 nodes and 3 000 edges = O(N + E).
  In practice ≤ 0.5 ms measured in V8 on a mid-range laptop.
- **DOM update:** one `innerHTML` write to the panel — no layout thrash.
- **No debounce needed.** The click handler is synchronous; at < 2 ms total the
  user perceives it as instant.

For pathological graphs (> 5 000 nodes), wrap BFS in `requestAnimationFrame` so
the UI thread is not blocked. This is not required for the current target but
should be documented as the scaling path.

---

## Data contract

No new fields in `GraphData`. The feature reads:

```ts
state.data.edges   // GraphEdge[] — full unfiltered set
state.data.nodes   // GraphNode[] — for kind/feature/package lookups
```

Both are already present. The blast-radius computation is a pure client-side
function over these arrays.

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| Node has zero importers | Counts show 0/0; button disabled ("No dependents") |
| Circular imports (A→B→A) | BFS `visited` guard terminates; cycle members all appear in each other's closure |
| Node is a barrel file (re-exports only) | Likely high fan-in; counts are accurate; no special casing needed |
| Very deep transitive chain (depth > 20) | BFS still terminates; no stack overflow (iterative queue) |
| Page node selected | Impact section is hidden; page nodes are navigation targets, not import sources |
| `--export` mode (no server) | Runs identically; `state.data` is loaded from `window.__PM_GRAPH__` |

---

## Testing

1. **Unit** (`test/impact.test.ts`): construct small `GraphData` fixtures with
   known import graphs; assert that `bfs(id, rev)` returns exactly the expected
   dependent sets, including cycles and disconnected components.
2. **Integration / smoke**: run `node dist/cli.js <venio> --json /tmp/g.json`;
   load the JSON in a test; pick a known central file (e.g. `core/src/di.dart`);
   assert `transitiveDependents > 50` (sanity that BFS is traversing the graph).
3. **Manual UI**: open PageMapper on venio; select `di.dart`; verify the panel
   shows plausible counts and the highlight button colours the expected nodes.
   Screenshot testing is not reliable for the Cytoscape canvas (see CLAUDE.md
   Gotchas) — use `cy.nodes('.blast-radius').length` via console eval instead.

---

## Out of scope

- **Producer-side precomputation** — rejected (space cost, cache invalidation
  complexity, export-size impact; client BFS is fast enough).
- **Edge-type toggles in blast radius** — only `import` edges are considered;
  adding `navigate`/`uses` would misrepresent compile-time impact.
- **Exporting the blast-radius set** — not in this iteration; can be a follow-on
  (copy node list to clipboard, or highlight in `--check` output).
- **Blame / churn overlay on blast-radius nodes** — that is the Hotspots feature
  (separate spec); the two features are composable but not coupled.
- **Server-side API for impact queries** — unnecessary; the client has the full
  graph. Adding a `/impact` endpoint would add latency with no benefit.
