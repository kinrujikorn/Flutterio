# PageMapper — Design Spec

**Date:** 2026-06-20
**Status:** Approved (user: "เอาเลยลุย")

## Purpose

A local tool that reads a Flutter/Dart project and visualizes how files and
pages connect to each other, as a beautiful, easy-to-read interactive graph.

Primary question to answer: *"which file connects to which file, which page
navigates to which page."*

## Target projects

Validated against `venio-mobile-app`:
- Flutter/Dart **melos monorepo** (~592 `.dart` files)
- Layout: `apps/venio_app` + `packages/{core, design_system, features/*}`
- Clean Architecture per feature: `domain / data / presentation`
- Navigation via **go_router**: `context.go('/path')`,
  `context.go(SomePage.routePath)`, `GoRoute(path: ...)`
- Imports: `package:xxx/xxx.dart` (cross-package) + relative `../...`

## Architecture (Approach A)

Single Node + TypeScript tool. One command:

```
pagemapper <path-to-project>
```

Flow: **scan → parse → build graph JSON → serve local web UI → open browser.**

Reading the local path directly (no browser sandbox limits) handles hundreds of
files quickly and is portable.

### Tech stack (the tool itself)
- **Backend/parser:** Node + TypeScript
- **Frontend:** static HTML/JS + **Cytoscape.js** (`fcose` layout, compound
  nodes for grouping)
- **Server:** minimal Node http server serving `web/` + `/graph.json`

## Modules (clear, isolated responsibilities)

1. **Scanner** (`src/scanner.ts`)
   - Walk `.dart` files, respect `.gitignore` + skip `.dart_tool`, `build`, `test` (configurable)
   - Read `melos.yaml` / `pubspec.yaml` to map package roots + names
   - Classify each file → `{ package, feature, layer }` where layer ∈
     `domain | data | presentation | other`

2. **Dart Parser** (`src/parser/*`) — lightweight regex/heuristic, no full AST
   - **imports.ts** — extract `import` statements; resolve `package:` and
     relative paths to real file paths within the project
   - **navigation.ts** — collect route definitions (`GoRoute(path:)`, static
     `routePath`/`routePathFor` consts on `*Page` classes) → map path→page;
     collect `context.go/push/pushNamed(...)` calls → page→page edges (resolve
     both string literals and `SomePage.routePath` refs)
   - **widgets.ts** — declared classes (`*Page`, `*Widget`, extends
     StatelessWidget/StatefulWidget) and which widget classes are referenced in
     another file's build → component-usage edges
   - **api.ts** — datasource/repository classes + dio/http call sites → service edges

3. **Graph Builder** (`src/graph-builder.ts`)
   - Merge parser output into one `GraphData` (see schema)
   - Nodes: files and pages. Edges typed: `import | navigate | uses | api`
   - Grouping metadata: package → feature → layer (for compound nodes + colors)

4. **Web UI** (`web/`)
   - View switcher: **Page Flow** / **File Dependency** / **Components** / **API**
   - Filter by feature/package; color by layer; search nodes
   - Click node → detail panel (path, type, in/out neighbors) + highlight neighbors
   - `fcose` layout; compound nodes group by package/feature

## Data contract (`GraphData`)

```ts
type EdgeType = 'import' | 'navigate' | 'uses' | 'api';
type Layer = 'domain' | 'data' | 'presentation' | 'other';

interface GraphNode {
  id: string;            // stable id (file path, or page:<Class>)
  label: string;         // display name
  kind: 'file' | 'page'; // node category
  path: string;          // file path relative to project root
  package?: string;      // e.g. "auth", "core"
  feature?: string;      // feature folder name if any
  layer?: Layer;
  routePath?: string;    // for pages
}

interface GraphEdge {
  id: string;
  source: string;        // node id
  target: string;        // node id
  type: EdgeType;
  label?: string;        // e.g. nav literal '/dashboard'
}

interface GraphData {
  projectRoot: string;
  generatedAt: string;
  packages: { name: string; root: string }[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Record<string, number>;
}
```

This schema is the interface between parser/builder (producer) and Web UI
(consumer); both sides develop against it independently.

## Incremental build order
1. Scaffold + types + Scanner + **File-import** parse + UI skeleton (see a graph)
2. Page navigation view
3. Component usage + API views

## Out of scope (YAGNI for v1)
- Non-Dart languages
- Live file-watch / auto-refresh
- Persisted history / diffing between runs
- Static single-file HTML export (possible later)

## Testing
- Unit tests for parser (sample Dart snippets → expected edges)
- Smoke test: run against `venio-mobile-app`, assert known edges exist
  (e.g. `login_page` → `/dashboard`)
