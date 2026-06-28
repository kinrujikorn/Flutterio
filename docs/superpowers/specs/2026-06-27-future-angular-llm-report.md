# PageMapper — Future: Angular Support, LLM Q&A, Report Export

**Date:** 2026-06-27
**Status:** Design direction (not scheduled)

---

## 1. Angular / TypeScript Support

### Purpose

Everything downstream of `buildGraph` (insights, coupling, diff, web UI) is
language-agnostic — it operates solely on `GraphData`. The only language-specific
layer is scanner + parser. Adding Angular means shipping `src/scanner-ts.ts` +
`src/parser-ts/` that emit the same `GraphData` shape, leaving the entire
downstream pipeline untouched.

### Design

**Entry point.** `cli.ts` detects language: if the root contains `angular.json`
(or `--lang angular`), route to `scanAngular` + `parseAngular`; otherwise keep the
existing Dart path. Both return the same `ScanResult` / `ParseResult` types.

**`src/scanner-ts.ts`**
- Walk `.ts` files under `src/`; skip `node_modules`, `dist`, `*.spec.ts`.
- Read `angular.json` → project names (= packages). Read `tsconfig.json` path
  aliases → resolve `@app/…` and `@feature/…` imports.
- Infer `feature` from directory segment (e.g. `src/app/features/auth/` →
  `feature: "auth"`).
- Classify `layer` by folder name: `domain`, `data`, `presentation`, `shared`,
  `core` → maps to existing `Layer` union (add `shared`/`core` as `other`).

**`src/parser-ts/` modules**

| Module | Extracts |
|---|---|
| `imports.ts` | ES `import … from '…'` + `@NgModule({ imports:[…] })` → `import` edges |
| `routes.ts` | `Routes` array literals → page nodes with `routePath`; `Router.navigate([…])` + `routerLink` → `navigate` edges |
| `components.ts` | `@Component({ selector })` classes → `page` node (if routed) or `file` node; template `<app-foo>` tag references → `uses` edges |
| `services.ts` | `@Injectable` classes; `HttpClient.get/post/…` call sites → `api` edges |

**Concept mapping to `GraphNode` / `GraphEdge`**

| Angular concept | GraphNode `kind` | Notes |
|---|---|---|
| Routed component | `page` | `routePath` from `Routes` array |
| Non-routed component | `file` | `kind: 'file'`, layer `presentation` |
| Service / injectable | `file` | layer `data` or `domain` |
| NgModule / standalone module | package grouping | `package` = module name or `angular.json` project name |

| Angular relationship | GraphEdge `type` |
|---|---|
| `import … from` / NgModule `imports:[]` | `import` |
| `Router.navigate` / `routerLink` | `navigate` |
| Template `<app-foo>` usage | `uses` |
| `HttpClient` call site | `api` |

Standalone components (Angular 17+): treat `imports: [ComponentA]` in
`@Component` metadata the same as NgModule imports.

**Effort:** M — scanner + four parser modules + CLI wire-up. Insights/UI: zero
changes required.

**Key risks**
- Template analysis requires parsing HTML strings inside `.ts` decorators or
  separate `.html` files; limit to selector name matching, not full template AST.
- Path alias resolution (`tsconfig` `paths`) must be implemented carefully or many
  import edges will be missing.
- Nx / Angular monorepos add their own project graph; read `project.json` per
  project as the package boundary.

**Minimal first slice**
Scanner + `imports.ts` only → file-dependency graph renders in the existing UI.
Routes + components add the page-flow view. Services add API view. Ship in layers.

---

## 2. NL Architecture Q&A

### Purpose

Let engineers ask free-text questions about their own codebase graph —
"why does feature auth depend on feature dashboard?", "suggest how to break this
circular dependency" — and get answers grounded in the actual graph data, not
hallucinated structure. Opt-in, requires an API key.

### Design

**Plumbing.** `server.ts` already has a `/refine` endpoint stub. Extend it:

```
POST /refine
Body: { question: string; nodeIds?: string[] }
Response: { answer: string; cited: string[] }   // cited = node/edge ids used
```

The handler:
1. Serialises a compact graph summary (nodes with label/kind/layer/package, edges
   with type/source/target) capped at ~60 k tokens (drop leaf `file` nodes if
   needed, keep `page` nodes + high-fanout files).
2. Appends the user question.
3. Calls the configured LLM (Claude via Anthropic SDK or OpenAI; key read from
   `PAGEMAPPER_LLM_KEY` env var; model configurable in `.pagemapper.json`
   `llm.model`).
4. Streams the response back to the client as SSE or returns JSON.

**UI.** The detail panel gains a collapsible "Ask about this node" text input that
prefills `nodeIds` with the selected node. A global search bar variant sends the
raw question. Answers render as Markdown in the panel; cited node ids are
highlighted in the graph.

**Effort:** M — the serialisation + prompt engineering is the hard part; the HTTP
plumbing is small.

**Key risks**
- Graph JSON for large monorepos (~600 files) can exceed context window; the
  summary strategy (keep pages + high-degree files) must be tuned.
- Quality of answers degrades if the graph has many missing edges (regex parser
  misses dynamic imports); LSP mode (`--lsp`) significantly improves recall.
- API key must never be committed; document env-var pattern clearly. Rate limits
  and latency are user-visible (stream to avoid perceived hangs).

**Minimal first slice**
Hard-coded prompt template + `PAGEMAPPER_LLM_KEY` env var + `/refine` endpoint
that echoes the serialised graph summary. Wire to a single "Ask" button in the UI
that prints the answer in a `<pre>`. No streaming, no citation highlighting yet.

---

## 3. Architecture Report Export

### Purpose

One command produces a shareable, human-readable architecture document —
stats summary, top findings, coupling table, hotspot list — without requiring the
recipient to run PageMapper locally. Target formats: Markdown file, Confluence
page (via MCP), Notion page (via MCP).

### Design

**CLI flag**

```
pagemapper <path> --report <out.md>           # Markdown file
pagemapper <path> --report confluence         # push via Atlassian MCP
pagemapper <path> --report notion             # push via Notion MCP
pagemapper <path> --report <out.md> --baseline <prev.json>  # delta report
```

**`src/report.ts`** — pure function:

```ts
function buildReport(data: GraphData, options: ReportOptions): ReportDocument
interface ReportDocument { title: string; sections: ReportSection[] }
interface ReportSection { heading: string; body: string }   // Markdown body
```

Sections (in order):

| Section | Content |
|---|---|
| Summary | `generatedAt`, file count, page count, package count, total findings, high-severity count |
| Top findings | `insights.categories` sorted by severity; top 10 findings as a table (category, file, severity, message) |
| Coupling table | `coupling` array: package, Ca, Ce, Instability, flagged if Instability > 0.8 |
| Hotspots | Top 10 by churn × fan-in (if `--git` was not skipped) |
| Delta (optional) | Added / removed insights vs baseline; node/edge counts changed |

**Renderers**

- `renderMarkdown(doc)` → string written to `--report <out.md>`.
- `renderConfluence(doc, mcpClient)` — converts Markdown body to Confluence
  storage format and calls `createConfluencePage` / `updateConfluencePage` MCP
  tools; page title = `doc.title`; parent page ID read from `.pagemapper.json`
  `confluence.parentPageId`.
- `renderNotion(doc, mcpClient)` — calls `notion-create-pages` MCP tool; parent
  page ID from `.pagemapper.json` `notion.parentPageId`.

MCP connectors (`mcp__2a19e056…__createConfluencePage`,
`mcp__cc1d1a82…__notion-create-pages`) are already wired in the agent environment;
the renderer just calls the resolved tool function.

**Effort:** S (Markdown) + M (Confluence/Notion MCP integration).

**Key risks**
- Confluence storage format is verbose XML; keep a thin mapping layer and validate
  with a real page in a sandbox space before shipping.
- Notion block structure differs from Markdown; tables require the `table`/`row`
  block types, not Markdown pipe syntax.
- Delta report requires a valid baseline `--json` snapshot from a prior run; users
  must opt into snapshot-on-merge in CI to get useful diffs.

**Minimal first slice**
`--report <out.md>` only: `buildReport` + `renderMarkdown`. No MCP, no delta.
Gate behind a build flag so existing `--export` is unaffected. Confluence/Notion
renderers ship in a follow-up once the document model is stable.

---

## Cross-cutting notes

- All three features are **opt-in** and additive: no existing flags change
  behaviour, no existing tests break.
- Angular support and Report export have zero LLM dependency; LLM Q&A is the only
  network-calling feature and must be clearly documented as such.
- Priority order by value/effort ratio: **Report export (S)** → **Angular (M)**
  → **LLM Q&A (M)**.

## Out of scope

- Full TypeScript AST parsing (ts-morph / tsc API) — regex heuristics are
  sufficient for the same reasons as the Dart parser.
- Multi-turn conversation history in LLM Q&A (stateless per request for now).
- PDF export (Markdown → PDF requires a headless renderer dependency; not worth
  the weight for v1 report).
- Real-time collaborative annotation of the graph.
