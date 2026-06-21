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

/** Result of scanning a project: file list + package map + root. */
export interface ScanResult {
  projectRoot: string;
  packages: PackageInfo[];
  files: ScannedFile[];
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
  | 'orphan-file';

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
}
