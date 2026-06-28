// graph-builder.ts — Turn scan + parse results into the GraphData the UI consumes.
//
// Nodes:
//   - one `file` node per scanned dart file (id = relPath)
//   - one `page` node per PageInfo (id = "page:<ClassName>"), carrying
//     routePath/package/feature/layer derived from its declaring file.
//
// Edges (deduped, stable ids):
//   - import:   file -> file  (internal ImportEdge, toRel != null)
//   - navigate: file -> page  (NavEdge, target page resolved when possible)
//   - uses:     file -> file/page (UsesEdge, to the declaring file or page node)
//   - api:      file -> file/service (ApiEdge)

import type {
  GraphData,
  GraphEdge,
  GraphNode,
  InsightInputs,
  ParseResult,
  ScanResult,
} from './types.js';
import { computeInsights, computePackageCoupling } from './insights.js';

/** Build the `page:<ClassName>` node id. */
function pageId(className: string): string {
  return `page:${className}`;
}

/** A short label for a file node: its basename. */
function fileLabel(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? relPath : relPath.slice(i + 1);
}

export function buildGraph(
  scan: ScanResult,
  parse: ParseResult,
  inputs: InsightInputs = {},
): GraphData {
  const nodes: GraphNode[] = [];
  const nodeIds = new Set<string>();

  // --- File nodes ---
  for (const f of scan.files) {
    const node: GraphNode = {
      id: f.relPath,
      label: fileLabel(f.relPath),
      kind: 'file',
      path: f.relPath,
      layer: f.layer,
    };
    if (f.package) node.package = f.package;
    if (f.feature) node.feature = f.feature;
    nodes.push(node);
    nodeIds.add(node.id);
  }

  // --- Page nodes (one per page class; dedupe by class name) ---
  const fileByRel = new Map(scan.files.map((f) => [f.relPath, f]));
  const pageByClass = new Map<string, string>(); // className -> node id
  for (const p of parse.pages) {
    const id = pageId(p.className);
    if (nodeIds.has(id)) continue;
    const owner = fileByRel.get(p.fileRel);
    const node: GraphNode = {
      id,
      label: p.className,
      kind: 'page',
      path: p.fileRel,
    };
    if (p.routePath) node.routePath = p.routePath;
    if (owner?.package) node.package = owner.package;
    if (owner?.feature) node.feature = owner.feature;
    if (owner?.layer) node.layer = owner.layer;
    nodes.push(node);
    nodeIds.add(id);
    pageByClass.set(p.className, id);
  }

  // Map a declaring file rel -> its page node id (for routing `uses` to pages).
  const pageByFile = new Map<string, string>();
  for (const p of parse.pages) pageByFile.set(p.fileRel, pageId(p.className));

  // --- Edges ---
  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();

  function addEdge(
    source: string,
    target: string,
    type: GraphEdge['type'],
    label?: string,
  ): void {
    if (!nodeIds.has(source) || !nodeIds.has(target)) return;
    if (source === target) return;
    const id = `${type}:${source}->${target}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    const edge: GraphEdge = { id, source, target, type };
    if (label) edge.label = label;
    edges.push(edge);
  }

  // import: internal file -> file.
  for (const imp of parse.imports) {
    if (imp.external || !imp.toRel) continue;
    addEdge(imp.fromRel, imp.toRel, 'import');
  }

  // navigate: page -> page when the call site's file declares a page (the
  // common case: navigation lives inside a *Page widget), else file -> page.
  // This keeps the Page Flow view (page nodes only) connected instead of
  // dropping every edge because its source was a file node.
  for (const nav of parse.navEdges) {
    if (!nav.targetClass) continue;
    const targetNode = pageByClass.get(nav.targetClass);
    if (!targetNode) continue;
    const sourceNode = pageByFile.get(nav.fromFileRel) ?? nav.fromFileRel;
    const base = nav.routePath ?? nav.rawTarget;
    // Surface the `extra:` payload on the edge so the data handed to the next
    // page is visible in the flow, e.g. "/login ‹company›".
    const label = nav.extra ? `${base} ‹${nav.extra}›` : base;
    addEdge(sourceNode, targetNode, 'navigate', label);
  }

  // uses: file -> page node (if the declaring file is a page) else -> file node.
  // We map widgetClass back to a declaring file via the widget list.
  const widgetDeclFile = new Map<string, string>(); // class -> fileRel (first decl)
  for (const w of parse.widgets) {
    if (!widgetDeclFile.has(w.className)) widgetDeclFile.set(w.className, w.fileRel);
  }
  for (const use of parse.usesEdges) {
    const declFile = widgetDeclFile.get(use.widgetClass);
    if (!declFile) continue;
    const target = pageByFile.get(declFile) ?? declFile;
    addEdge(use.fromFileRel, target, 'uses', use.widgetClass);
  }

  // api: file -> service. When the target is an in-project file (an
  // LSP-resolved service/datasource declaration), link straight to that real
  // file node. Otherwise (heuristic class-name or `receiver.verb` labels, e.g.
  // external dio/http calls) materialize one synthetic endpoint node per target
  // so the UI still has a stable, visible endpoint.
  const serviceNodes = new Map<string, string>(); // label -> node id
  function ensureServiceNode(label: string, kind: string): string {
    const existing = serviceNodes.get(label);
    if (existing) return existing;
    const id = `svc:${label}`;
    serviceNodes.set(label, id);
    if (!nodeIds.has(id)) {
      nodes.push({ id, label, kind: 'file', path: `(${kind}) ${label}` });
      nodeIds.add(id);
    }
    return id;
  }
  for (const api of parse.apiEdges) {
    const targetNode = nodeIds.has(api.target)
      ? api.target
      : ensureServiceNode(api.target, api.kind);
    addEdge(api.fromFileRel, targetNode, 'api', api.kind);
  }

  // --- Stats ---
  const stats: Record<string, number> = {
    files: scan.files.length,
    packages: scan.packages.length,
    nodes: nodes.length,
    edges: edges.length,
  };
  for (const n of nodes) {
    const key = `node_${n.kind}`;
    stats[key] = (stats[key] ?? 0) + 1;
  }
  for (const e of edges) {
    const key = `edge_${e.type}`;
    stats[key] = (stats[key] ?? 0) + 1;
  }

  // --- History/coverage overlays on nodes (keyed by file relPath == node.path) ---
  if (inputs.git?.churn?.length) {
    const churnByRel = new Map(inputs.git.churn.map((c) => [c.relPath, c.commits]));
    for (const n of nodes) {
      const c = churnByRel.get(n.path);
      if (c !== undefined) n.churn = c;
    }
  }
  if (inputs.coveredRel && inputs.coveredRel.length) {
    const covered = new Set(inputs.coveredRel);
    for (const n of nodes) n.tested = covered.has(n.path);
  }

  const graph: GraphData = {
    projectRoot: scan.projectRoot,
    generatedAt: new Date().toISOString(),
    packages: scan.packages.map((p) => ({ name: p.name, root: p.root })),
    nodes,
    edges,
    stats,
  };
  graph.insights = computeInsights(graph, inputs);
  stats.insights = graph.insights.summary.total;
  graph.coupling = computePackageCoupling(graph);
  return graph;
}
