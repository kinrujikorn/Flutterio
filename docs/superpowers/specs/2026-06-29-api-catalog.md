# PageMapper — API Catalog

**Date:** 2026-06-29
**Status:** Implemented (verified on `venio-mobile-app`: ~391 endpoints, ~287 typed responses)

## Purpose

List **every HTTP API the app calls**, each with its method + path and a
**deterministically generated mock request/response** (JSON), so a reader
understands an endpoint's contract at a glance instead of tracing complex
datasource/model code. No network, no real data, no LLM — the same deterministic
spirit as `preview.ts` (Flutter widget-tree → HTML).

## Pipeline

```
scan files → buildModelRegistry (parser/models.ts) ─┐
           → parseEndpointConsts (api-catalog.ts)   ├─ extractCatalog → GraphData.apiCatalog
           → scan Dio call sites (api-catalog.ts) ──┘        │
                                                     mock-gen.ts (type → JSON)
```

`buildApiCatalog(scan)` reads all files once, then `extractCatalog(contents,
featureByRel)` (pure, unit-tested) does the work. Attached as
`GraphData.apiCatalog`, so `/graph.json`, `--json`, and the standalone `--export`
HTML all include it. It is **heavy** (reads every file) so it runs on the
one-shot paths (`--json`/`--export`/`--check`) and the LSP refine / no-lsp
background enrich — never on the fast first-paint graph.

## Data contract (`src/types.ts`)

```ts
interface ApiEndpoint {
  id: string;            // "GET activity/v1/Activity/ActivityReport"
  method: string;        // GET | POST | PUT | PATCH | DELETE | CALL
  path: string;          // interpolations normalized: '/users/$id' → 'users/{id}'
  fromFileRel: string;
  service?: string;      // enclosing datasource/repository class
  feature?: string;
  requestType?: string;  // Dart request model class, if derivable
  responseType?: string; // Dart response model class, if derivable
  responseIsList?: boolean;
  mockRequest?: unknown;  // synthesized JSON body
  mockQuery?: unknown;    // synthesized query params (GET/DELETE)
  mockResponse?: unknown; // synthesized JSON payload
  partial?: boolean;      // a type/path couldn't be fully resolved
}
interface ApiCatalog { generatedAt: string; endpoints: ApiEndpoint[]; stats: Record<string, number>; }
```

## Extraction (grounded in venio's real patterns, surveyed)

- **Call sites**: `_client.verb<...>('path', ...)` in `*remote_datasource*.dart`.
  `CALL_RE` self-filters to Dio-ish receivers (`_x` / `*Client` / `*Dio`).
- **Path**: string literal; `$id`/`${expr}` interpolation → `{id}`;
  `XEndpoints.method()` constants resolved via `parseEndpointConsts`; local
  `static const _p = '...'` resolved in-file; otherwise kept verbatim + `partial`.
- **Response**: the enclosing method's `Future<T>` / `Future<List<T>>` return type
  (primary signal; `>+` absorbs `>>`). `Future<void>` / `Future<Response>` → `{}`.
- **Request**: `data: {...}` literal → keys; `data: x.toJson()` → trace `x` to its
  `XModel(...)` construction → registry mock; `const <String,dynamic>{}` → `{}`;
  list → JSON-Patch sample; `Stream<...>` → `<binary upload>`.
- **Query**: `queryParameters: {...}` → `mockQuery`.

## Model parsing (`parser/models.ts`) → `Registry`

- **freezed** (dominant): `const factory X({ @JsonKey(name:'K') Type f, required
  Type f2, @Default(v) Type f3 }) = _X;` → fields `{name, jsonKey, type}`.
- **plain class** with `final Type name;` + `fromJson` → fields (key = field name).
- **enum** `E { a(1), b(2); }` → first variant int (enums serialize as ints).
- `.g.dart` / `.freezed.dart` are excluded by the scanner.

## Mock generation (`mock-gen.ts`)

`mockValue(type, registry, hint)` → primitives (string sample biased by field
name), `List<T>`→`[mock(T)]`, `Map`→`{key: mock(V)}`, nested model → recurse
(depth + cycle guards), enum → its int, unknown capitalized type → placeholder +
`partial`. Fully deterministic.

## UI

Header `</>` button (shown only when a catalog exists) → `#api-modal` (reuses the
code-modal card styling): search box, method filter chips with counts, a
color-coded endpoint list, and a detail pane with Query / Request / Response JSON
blocks (lightweight syntax highlight). Reads `state.data.apiCatalog` — no fetch.
"View source" jumps to the call-site file (when `/source` is available).

## Edge cases / limits

- Regex over Dart, not an AST — best-effort; unresolved types/paths are flagged
  `partial` rather than dropped. Plain-class JSON keys default to the field name
  (PascalCase wire keys via handwritten `fromJson` aren't mined in v1).
- Dedupe by `method + path` (keeps the first occurrence).
- The mock is a **shape**, not real data.

## Testing

`test/api-catalog.test.ts` — mock generator (primitives/list/map/enum/cycle/
partial), model registry (freezed + @JsonKey + @Default + plain + enum), and
`extractCatalog` over synthetic Dart (interpolated path, list response, void→{},
inline data map, Endpoints constant, `toJson` request model, stats). Verify on a
real repo with `--json` and inspect `apiCatalog.stats` / `endpoints`.

## Out of scope (later)

- Resolving handwritten-`fromJson` PascalCase wire keys; multi-alias readers.
- Base-URL families (tenant vs venioCrm vs identity) as a path prefix.
- Grouping the UI list by feature/service; copy-as-curl; OpenAPI export.
