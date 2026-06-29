// Shared data contracts for PageMapper.
// This file is the single source of truth for the interface between the
// scanner/parser/graph-builder (producers) and the web UI (consumer).

export type Layer = 'domain' | 'data' | 'presentation' | 'other';

export type EdgeType = 'import' | 'navigate' | 'uses' | 'api';

/** A package discovered in the monorepo (from melos/pubspec). */
export interface PackageInfo {
  /** Dart package name, e.g. "core", "auth", "design_system". */
  name: string;
  /** Absolute path to the package root (the dir containing pubspec.yaml). */
  root: string;
}

/** A scanned source file with its classification. */
export interface ScannedFile {
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to the project root, POSIX separators. */
  relPath: string;
  /** Owning package name, if resolvable. */
  package?: string;
  /** Feature folder name (under packages/features/<feature>), if any. */
  feature?: string;
  /** Clean-architecture layer inferred from the path. */
  layer: Layer;
}

/** A discovered test file (under test/ or integration_test/). Kept separate
 *  from `files` so it never pollutes the graph, but available for the
 *  test-coverage overlay (which files do tests reference?). */
export interface ScannedTestFile {
  absPath: string;
  relPath: string;
}

/** Result of scanning a project: file list + package map + root. */
export interface ScanResult {
  projectRoot: string;
  packages: PackageInfo[];
  files: ScannedFile[];
  /** Test files found under test/ / integration_test/ (not part of the graph). */
  testFiles?: ScannedTestFile[];
}

// ---- Parser outputs -------------------------------------------------------

/** A single import edge: `fromRel` imports the file resolved to `toRel`. */
export interface ImportEdge {
  fromRel: string;
  /** Resolved project-relative path, or null if external/unresolved. */
  toRel: string | null;
  /** Raw import string, e.g. "package:core/core.dart" or "../foo.dart". */
  raw: string;
  /** True when the import points outside the project (pub package, dart sdk). */
  external: boolean;
}

/** A page (route target) declared in the project. */
export interface PageInfo {
  /** Page class name, e.g. "LoginPage". */
  className: string;
  /** File the class is declared in (project-relative). */
  fileRel: string;
  /** Route path if known, e.g. "/login". May be undefined. */
  routePath?: string;
}

/** A navigation edge: a call site in `fromFileRel` navigates to a route. */
export interface NavEdge {
  fromFileRel: string;
  /** Raw target as written, e.g. "/dashboard" or "SetPinPage.routePath". */
  rawTarget: string;
  /** Resolved route path if determinable. */
  routePath?: string;
  /** Resolved target page class if determinable. */
  targetClass?: string;
  /** Navigation method: go | push | pushNamed | replace | other. */
  method: string;
  /** The `extra:` payload expression passed with navigation, if any (e.g.
   * "company", "customer.customerId") — the data handed to the next page. */
  extra?: string;
}

/** A widget/component class declared in a file. */
export interface WidgetInfo {
  className: string;
  fileRel: string;
  /** What it extends, e.g. "StatelessWidget", "StatefulWidget", "State". */
  base?: string;
}

/** A usage edge: `fromFileRel` references widget class `widgetClass`. */
export interface UsesEdge {
  fromFileRel: string;
  widgetClass: string;
}

/** An API/service edge: a call site references a service/datasource/http call. */
export interface ApiEdge {
  fromFileRel: string;
  /** Target service/datasource class or endpoint label. */
  target: string;
  /** "service" | "datasource" | "http". */
  kind: string;
}

export interface ParseResult {
  imports: ImportEdge[];
  pages: PageInfo[];
  navEdges: NavEdge[];
  widgets: WidgetInfo[];
  usesEdges: UsesEdge[];
  apiEdges: ApiEdge[];
}

// ---- Final graph (producer -> web UI) -------------------------------------

export interface GraphNode {
  id: string;
  label: string;
  kind: 'file' | 'page';
  path: string;
  package?: string;
  feature?: string;
  layer?: Layer;
  routePath?: string;
  /** Git commits that touched this file in the analyzed window (churn/hotspot
   *  overlay). Absent when git history isn't available. */
  churn?: number;
  /** True when at least one test file references this file/page. Absent when
   *  the test-coverage pass didn't run. */
  tested?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label?: string;
}

// ---- Insights / architecture lint -----------------------------------------

export type InsightKey =
  | 'layer-violation'
  | 'cross-feature-import'
  | 'circular-dep'
  | 'god-file'
  | 'dead-page'
  | 'nav-depth'
  | 'orphan-file'
  | 'hotspot'
  | 'temporal-coupling'
  | 'policy-violation'
  | 'untested-page';

export type Severity = 'high' | 'medium' | 'low';

/** A single flagged finding (one cycle, one bad import, one dead page, …). */
export interface Insight {
  /** Stable id, unique within its category. */
  id: string;
  severity: Severity;
  /** Short headline, e.g. "domain → presentation". */
  title: string;
  /** Human-readable explanation of the specific finding. */
  detail: string;
  /** Node ids to highlight when this finding is selected. */
  nodes: string[];
  /** Edge ids to highlight (the offending import(s) / cycle path). */
  edges?: string[];
}

export interface InsightCategory {
  key: InsightKey;
  label: string;
  /** One-line description of what the rule checks and why it matters. */
  description: string;
  items: Insight[];
}

export interface InsightsReport {
  categories: InsightCategory[];
  /** Per-category counts plus `total`. */
  summary: Record<string, number>;
}

/** Package-level coupling metrics (Robert C. Martin). */
export interface PackageCoupling {
  package: string;
  /** Afferent coupling — number of other packages that depend on this one. */
  ca: number;
  /** Efferent coupling — number of other packages this one depends on. */
  ce: number;
  /** Instability `Ce / (Ca + Ce)` — 0 = maximally stable, 1 = maximally unstable. */
  instability: number;
  /** File count in the package (for context). */
  files: number;
  /** True for the risk "watch zone": heavily depended-on yet still unstable. */
  watch: boolean;
}

export interface GraphData {
  projectRoot: string;
  generatedAt: string;
  packages: { name: string; root: string }[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Record<string, number>;
  /** Architecture-lint findings derived from the graph. */
  insights?: InsightsReport;
  /** Per-package coupling/instability metrics. */
  coupling?: PackageCoupling[];
  /** Browsable list of API calls with deterministic mock request/response. */
  apiCatalog?: ApiCatalog;
}

// ---- Git history overlay (churn + temporal coupling) ----------------------

/** Per-file change frequency mined from `git log`. */
export interface ChurnInfo {
  /** Project-relative POSIX path. */
  relPath: string;
  /** Number of commits that touched this file within the window. */
  commits: number;
  /** Distinct author count. */
  authors: number;
  /** ISO date of the most recent commit touching it, if known. */
  lastChange?: string;
}

/** A pair of files that changed together across commits — implicit (temporal)
 *  coupling. Surfaced as a finding when the pair has NO import edge between
 *  them: a hidden dependency static analysis can't see. */
export interface CoChangePair {
  /** relPath of one file (sorted ascending so a<b for stable ids). */
  a: string;
  /** relPath of the other file. */
  b: string;
  /** Commits in which both files changed. */
  together: number;
  /** Co-change support: together / (commits touching either), 0..1. */
  support: number;
}

/** Output of the git-history mining pass (src/git.ts). */
export interface GitInsightData {
  churn: ChurnInfo[];
  coChange: CoChangePair[];
  /** Commits inspected (for thresholds + display). */
  commitsScanned: number;
}

// ---- Architecture policy (.pagemapper.json) -------------------------------

/** One forbidden-dependency rule. `from`/`to` are selectors matched against a
 *  node — see src/policy.ts for the selector grammar (package:/feature:/layer:/
 *  path:/glob). An import whose source matches `from` and target matches `to`
 *  is a violation. */
export interface PolicyRule {
  /** Optional human label shown in the finding. */
  name?: string;
  from: string;
  to: string;
  /** Severity for violations. Default 'high'. */
  severity?: Severity;
}

/** Project policy loaded from `.pagemapper.json`. */
export interface PolicyConfig {
  /** Forbidden cross-module dependencies. */
  forbidden?: PolicyRule[];
}

// ---- Extra inputs to the insight engine -----------------------------------

/** Optional, history/config-derived inputs that enable the extended insight
 *  categories. All optional — when omitted, only the pure graph-derived
 *  categories run (fully backward compatible). */
export interface InsightInputs {
  /** Git churn + co-change, from src/git.ts. Enables hotspot + temporal-coupling. */
  git?: GitInsightData;
  /** relPaths referenced by test files, from src/coverage.ts. Enables untested-page. */
  coveredRel?: string[];
  /** Architecture policy, from src/policy.ts. Enables policy-violation. */
  policy?: PolicyConfig;
}

// ---- Graph diff (baseline comparison) -------------------------------------

/** A reference to one finding, for the diff's added/removed lists. */
export interface DiffInsightRef {
  category: string;
  id: string;
  title: string;
  severity: Severity;
}

/** Structural + insight delta between a baseline graph and the current one. */
export interface GraphDiff {
  baselineAt?: string;
  currentAt: string;
  /** Node ids added / removed. */
  nodes: { added: string[]; removed: string[] };
  /** Edge ids added / removed. */
  edges: { added: string[]; removed: string[] };
  insights: {
    /** Findings present now but not in the baseline (regressions). */
    added: DiffInsightRef[];
    /** Findings in the baseline but gone now (fixes). */
    removed: DiffInsightRef[];
    /** Per-category {added, removed}, plus a `total` key. */
    summary: Record<string, { added: number; removed: number }>;
  };
}

// ---- API Catalog (browsable endpoint list + deterministic mocks) ----------

/** One HTTP API call discovered in the project, with a synthesized mock. The
 *  mocks are generated deterministically from the Dart request/response model
 *  classes — no real data, no network, no LLM — so a reader understands the API
 *  shape without tracing the code. */
export interface ApiEndpoint {
  /** Stable id, e.g. "GET /api/v1/users/:id". */
  id: string;
  /** HTTP method uppercased (GET/POST/PUT/DELETE/PATCH), or "CALL" if unknown. */
  method: string;
  /** Endpoint path as written; `${expr}` interpolations are normalized to :param. */
  path: string;
  /** Call-site file (project-relative). */
  fromFileRel: string;
  /** Owning service/datasource/repository class, if resolvable. */
  service?: string;
  /** Feature folder, if any. */
  feature?: string;
  /** Dart type name of the request body, if derivable. */
  requestType?: string;
  /** Dart type name of the response payload, if derivable. */
  responseType?: string;
  /** Whether the response is a list of `responseType`. */
  responseIsList?: boolean;
  /** Synthesized mock request body (JSON-able value), or null. */
  mockRequest?: unknown;
  /** Synthesized mock query parameters (for GET/DELETE), if any. */
  mockQuery?: unknown;
  /** Synthesized mock response (JSON-able value), or null. */
  mockResponse?: unknown;
  /** True when a type couldn't be resolved and the mock is a placeholder. */
  partial?: boolean;
}

/** All discovered endpoints + summary counts, attached to GraphData. */
export interface ApiCatalog {
  generatedAt: string;
  endpoints: ApiEndpoint[];
  /** `total` plus per-method counts (e.g. GET, POST). */
  stats: Record<string, number>;
}
