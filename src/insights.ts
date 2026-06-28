// insights.ts — Derive architecture-lint findings from the built graph.
//
// Pure function over GraphData (nodes + edges). Four checks:
//   1. layer-violation — clean-architecture dependency-direction breaks
//      (domain importing data/presentation, data importing presentation).
//   2. circular-dep    — import cycles (strongly-connected components ≥2 files)
//      via Tarjan's SCC algorithm over the internal import edges.
//   3. dead-page       — page nodes with no incoming navigate/uses edge
//      (potentially unreachable; router-driven shell branches and deep-link-
//      only pages can surface here, so it's a signal, not a verdict).
//   4. orphan-file     — file nodes with no incident edge of any kind.
//   5. nav-depth       — deep / hard-to-reach pages, by BFS over navigate edges
//      from the app entry (a UX discoverability signal).
//
// The result rides along on GraphData.insights so the UI, exports, and the
// standalone HTML all get it for free from one graph fetch.

import type {
  ChurnInfo,
  CoChangePair,
  GraphData,
  GraphEdge,
  GraphNode,
  Insight,
  InsightCategory,
  InsightInputs,
  InsightsReport,
  Layer,
  PackageCoupling,
} from './types.js';
import { evaluatePolicy } from './policy.js';

/** Clean-architecture rank: a file may depend on the same or a *lower* rank.
 *  Depending on a higher rank (e.g. domain → presentation) is a violation. */
const LAYER_RANK: Record<Layer, number> = {
  domain: 0,
  data: 1,
  presentation: 2,
  other: -1, // excluded from the check
};

function shortPath(p: string): string {
  // Drop the long monorepo prefix for readability; keep the meaningful tail.
  const parts = p.split('/');
  return parts.length <= 4 ? p : '…/' + parts.slice(-3).join('/');
}

function computeLayerViolations(
  nodes: GraphNode[],
  edges: GraphEdge[],
  byId: Map<string, GraphNode>,
): Insight[] {
  const items: Insight[] = [];
  for (const e of edges) {
    if (e.type !== 'import') continue;
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src?.layer || !dst?.layer) continue;
    const sr = LAYER_RANK[src.layer];
    const dr = LAYER_RANK[dst.layer];
    if (sr < 0 || dr < 0) continue; // skip 'other'
    if (sr < dr) {
      // Lower-rank (more central) layer depends on a higher-rank layer.
      items.push({
        id: `lv:${e.id}`,
        severity: 'high',
        title: `${src.layer} → ${dst.layer}`,
        detail: `${shortPath(src.path)} (${src.layer}) imports ${shortPath(
          dst.path,
        )} (${dst.layer}). The ${src.layer} layer must not depend on ${dst.layer}.`,
        nodes: [src.id, dst.id],
        edges: [e.id],
      });
    }
  }
  // Heaviest dependency inversions first (domain→presentation before data→presentation).
  items.sort((a, b) => a.title.localeCompare(b.title));
  return items;
}

/** Tarjan's strongly-connected-components over internal import edges. */
function computeCircularDeps(
  nodes: GraphNode[],
  edges: GraphEdge[],
  byId: Map<string, GraphNode>,
): Insight[] {
  // Adjacency for import edges only.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type !== 'import') continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
  }

  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  // Iterative Tarjan to avoid stack overflow on large graphs.
  for (const start of adj.keys()) {
    if (idx.has(start)) continue;
    type Frame = { v: string; i: number };
    const work: Frame[] = [{ v: start, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const { v } = frame;
      if (frame.i === 0) {
        idx.set(v, index);
        low.set(v, index);
        index++;
        stack.push(v);
        onStack.add(v);
      }
      const neighbors = adj.get(v) ?? [];
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i];
        frame.i++;
        if (!idx.has(w)) {
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      } else {
        if (low.get(v) === idx.get(v)) {
          const comp: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
            if (w === v) break;
          }
          if (comp.length > 1) sccs.push(comp);
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
        }
      }
    }
  }

  // Edge ids whose both endpoints sit in the same SCC (the cycle's edges).
  const items: Insight[] = [];
  sccs.sort((a, b) => b.length - a.length);
  sccs.forEach((comp, n) => {
    const set = new Set(comp);
    const cycleEdges = edges
      .filter((e) => e.type === 'import' && set.has(e.source) && set.has(e.target))
      .map((e) => e.id);
    const names = comp.map((id) => byId.get(id)?.label ?? id);
    items.push({
      id: `cycle:${n}`,
      severity: 'high',
      title: `Cycle of ${comp.length} files`,
      detail: `These files import each other (directly or transitively): ${names
        .slice(0, 8)
        .join(' ↔ ')}${names.length > 8 ? ` …(+${names.length - 8})` : ''}.`,
      nodes: comp,
      edges: cycleEdges,
    });
  });
  return items;
}

function computeDeadPages(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Insight[] {
  const incoming = new Map<string, number>();
  for (const e of edges) {
    if (e.type !== 'navigate' && e.type !== 'uses') continue;
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
  }
  const items: Insight[] = [];
  for (const n of nodes) {
    if (n.kind !== 'page') continue;
    if ((incoming.get(n.id) ?? 0) > 0) continue;
    items.push({
      id: `dead:${n.id}`,
      severity: 'medium',
      title: n.label,
      detail: `No navigation or widget reference points to ${n.label}${
        n.routePath ? ` (${n.routePath})` : ''
      }. It may be unreachable — or reached only via a router shell branch / deep link.`,
      nodes: [n.id],
    });
  }
  items.sort((a, b) => a.title.localeCompare(b.title));
  return items;
}

/** Deep / hard-to-reach pages — a UX discoverability signal. BFS over page→page
 *  `navigate` edges from the app's single entry; pages many taps away are hard
 *  to find.
 *
 *  ENTRY (deterministic): the page whose routePath is `/dashboard`, else `/`,
 *  else `/splash`, else the page with the highest navigate in-degree (ties
 *  broken by node id, ascending). BFS from it gives each reachable page a depth
 *  = taps from entry.
 *
 *  THRESHOLD CHOICE: venio's real nav graph is shallow and fragmented — the
 *  page→page navigate edges form many small components, so BFS from any single
 *  entry reaches only a handful of pages and the maximum observed depth is 1.
 *  A fixed "depth ≥ 4" rule therefore yields ZERO findings on real data, so we
 *  use a tiered rule that's never empty when navigation exists:
 *    - If any reachable page sits at depth ≥ DEEP_THRESHOLD (4), flag every such
 *      page (the genuinely-deep case for apps with real navigation chains).
 *    - Otherwise the graph is too shallow for that rule, so fall back to the
 *      DEEPEST pages: the top DEEPEST_TOP_N (5) reachable pages by depth (depth
 *      ≥ 1, so the entry itself is never flagged).
 *  Items are sorted by depth desc. */
const DEEP_THRESHOLD = 4; // taps-from-entry at/above which a page is "deep"
const VERY_DEEP = 6; // depth at/above which severity escalates to 'medium'
const DEEPEST_TOP_N = 5; // fallback count when no page reaches DEEP_THRESHOLD

function computeNavDepth(
  nodes: GraphNode[],
  edges: GraphEdge[],
  byId: Map<string, GraphNode>,
): Insight[] {
  // 1. Adjacency over page->page navigate edges; track in-degree for entry pick.
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const e of edges) {
    if (e.type !== 'navigate') continue;
    if (byId.get(e.source)?.kind !== 'page' || byId.get(e.target)?.kind !== 'page') continue;
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }

  const pages = nodes.filter((n) => n.kind === 'page');
  if (!pages.length) return [];

  // 2. Pick the entry page deterministically.
  const byRoute = (r: string): GraphNode | undefined =>
    pages.find((p) => p.routePath === r);
  let entry = byRoute('/dashboard') ?? byRoute('/') ?? byRoute('/splash');
  if (!entry) {
    // Highest navigate in-degree; tie-break by node id (ascending) for stability.
    for (const p of pages) {
      const d = inDeg.get(p.id) ?? 0;
      const bd = entry ? inDeg.get(entry.id) ?? 0 : -1;
      if (d > bd || (d === bd && entry !== undefined && p.id < entry.id)) entry = p;
    }
  }
  if (!entry) return [];

  // 3. BFS from entry — depth = taps from entry.
  const depth = new Map<string, number>([[entry.id, 0]]);
  const queue: string[] = [entry.id];
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++];
    const d = depth.get(v)!;
    for (const w of adj.get(v) ?? []) {
      if (depth.has(w)) continue;
      depth.set(w, d + 1);
      queue.push(w);
    }
  }

  const entryLabel = entry.label + (entry.routePath ? ` (${entry.routePath})` : '');
  const maxDepth = Math.max(0, ...depth.values());

  // 4. Select pages to flag: genuinely-deep set, or deepest-N fallback.
  const reachable = [...depth.entries()]
    .filter(([, d]) => d >= 1) // never flag the entry itself
    .map(([id, d]) => ({ id, d }));
  reachable.sort(
    (a, b) =>
      b.d - a.d ||
      (byId.get(a.id)?.label ?? '').localeCompare(byId.get(b.id)?.label ?? ''),
  );
  const flagged =
    maxDepth >= DEEP_THRESHOLD
      ? reachable.filter((r) => r.d >= DEEP_THRESHOLD)
      : reachable.slice(0, DEEPEST_TOP_N);

  // 5. One Insight per deep page.
  const items: Insight[] = [];
  for (const { id, d } of flagged) {
    const n = byId.get(id);
    if (!n) continue;
    items.push({
      id: `navdepth:${id}`,
      severity: d >= VERY_DEEP ? 'medium' : 'low',
      title: `${n.label} (depth ${d})`,
      detail: `${n.label}${n.routePath ? ` (${n.routePath})` : ''} is ${d} navigation ${
        d === 1 ? 'tap' : 'taps'
      } from the entry page ${entryLabel}. Pages this far from the entry are harder for users to discover — consider a more direct path.`,
      nodes: [id],
    });
  }
  return items;
}

function computeOrphanFiles(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Insight[] {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const items: Insight[] = [];
  for (const n of nodes) {
    if (n.kind !== 'file') continue;
    if (n.path.startsWith('(')) continue; // synthetic service/endpoint node
    if ((degree.get(n.id) ?? 0) > 0) continue;
    items.push({
      id: `orphan:${n.id}`,
      severity: 'low',
      title: n.label,
      detail: `${shortPath(n.path)} has no imports in or out and isn't used as a widget — possible dead code.`,
      nodes: [n.id],
    });
  }
  items.sort((a, b) => a.title.localeCompare(b.title));
  return items;
}

/** Cross-feature deep imports: feature A reaching into feature B's `src/`
 *  internals instead of B's public barrel — the canonical melos-monorepo
 *  encapsulation break. Computed from node paths + feature, no extra parsing. */
function computeCrossFeatureImports(
  edges: GraphEdge[],
  byId: Map<string, GraphNode>,
): Insight[] {
  const items: Insight[] = [];
  for (const e of edges) {
    if (e.type !== 'import') continue;
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src?.feature || !dst?.feature) continue;
    if (src.feature === dst.feature) continue; // same feature — internal is fine
    if (!dst.path.includes('/src/')) continue; // importing the public barrel is fine
    items.push({
      id: `xf:${e.id}`,
      severity: 'high',
      title: `${src.feature} → ${dst.feature}/src`,
      detail: `${shortPath(src.path)} (feature "${src.feature}") reaches into an internal file of feature "${dst.feature}": ${shortPath(
        dst.path,
      )}. Depend on ${dst.feature}'s public barrel, not its src/ internals.`,
      nodes: [src.id, dst.id],
      edges: [e.id],
    });
  }
  items.sort((a, b) => a.title.localeCompare(b.title));
  return items;
}

/** "God files" — import fan-in + fan-out outliers (> mean+2σ, floor 20).
 *  High fan-in = a fragile hub whose changes ripple everywhere; high fan-out =
 *  a file doing too much. Pure edge counting over the existing graph. */
function computeGodFiles(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Insight[] {
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const e of edges) {
    if (e.type !== 'import') continue;
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }
  // Exclude public barrels / package entrypoints (a file sitting directly under
  // `lib/`, e.g. `core/lib/core.dart`). They re-export everything, so high
  // fan-in/out is by design — flagging them is noise, not a finding.
  const isBarrel = (p: string): boolean => {
    const i = p.lastIndexOf('/lib/');
    return i !== -1 && !p.slice(i + 5).includes('/');
  };
  const fileNodes = nodes.filter(
    (n) => n.kind === 'file' && !n.path.startsWith('(') && !isBarrel(n.path),
  );
  const totalOf = (id: string) => (inDeg.get(id) ?? 0) + (outDeg.get(id) ?? 0);
  const nonzero = fileNodes.map((n) => totalOf(n.id)).filter((t) => t > 0);
  if (!nonzero.length) return [];
  const mean = nonzero.reduce((a, b) => a + b, 0) / nonzero.length;
  const variance =
    nonzero.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nonzero.length;
  const threshold = Math.max(20, mean + 2 * Math.sqrt(variance));

  const items: Insight[] = [];
  for (const n of fileNodes) {
    const fin = inDeg.get(n.id) ?? 0;
    const fout = outDeg.get(n.id) ?? 0;
    if (fin + fout < threshold) continue;
    const hubEdges = edges
      .filter((e) => e.type === 'import' && (e.source === n.id || e.target === n.id))
      .map((e) => e.id);
    items.push({
      id: `god:${n.id}`,
      severity: 'medium',
      title: `${n.label} (${fin}↓ ${fout}↑)`,
      detail: `${shortPath(n.path)} has ${fin} dependents and imports ${fout} files (${
        fin + fout
      } total; flagged above ${Math.round(
        threshold,
      )}). A hub this central makes changes ripple widely — consider splitting its responsibilities.`,
      nodes: [n.id],
      edges: hubEdges,
    });
  }
  items.sort((a, b) => totalOf(b.nodes[0]) - totalOf(a.nodes[0]));
  return items;
}

/** Per-package coupling/instability (Martin metrics), computed from
 *  cross-package import edges. Ca = packages depending on P, Ce = packages P
 *  depends on, Instability I = Ce/(Ca+Ce). Sorted most-depended-on first.
 *  "watch" = Ca≥4 and I≥0.5 — heavily depended-on yet still unstable. */
export function computePackageCoupling(graph: GraphData): PackageCoupling[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const dependsOn = new Map<string, Set<string>>(); // pkg -> packages it imports
  const dependedBy = new Map<string, Set<string>>(); // pkg -> packages importing it
  const add = (m: Map<string, Set<string>>, k: string, v: string) =>
    (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);

  for (const e of graph.edges) {
    if (e.type !== 'import') continue;
    const s = byId.get(e.source)?.package;
    const t = byId.get(e.target)?.package;
    if (!s || !t || s === t) continue;
    add(dependsOn, s, t);
    add(dependedBy, t, s);
  }

  const fileCount = new Map<string, number>();
  const pkgs = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.package) continue;
    pkgs.add(n.package);
    if (n.kind === 'file' && !n.path.startsWith('(')) {
      fileCount.set(n.package, (fileCount.get(n.package) ?? 0) + 1);
    }
  }

  const rows: PackageCoupling[] = [];
  for (const p of pkgs) {
    const ca = dependedBy.get(p)?.size ?? 0;
    const ce = dependsOn.get(p)?.size ?? 0;
    const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
    rows.push({
      package: p,
      ca,
      ce,
      instability: Math.round(instability * 100) / 100,
      files: fileCount.get(p) ?? 0,
      watch: ca >= 4 && instability >= 0.5,
    });
  }
  rows.sort((a, b) => b.ca - a.ca || b.instability - a.instability);
  return rows;
}

/** Mean + k·σ over a numeric sample (with a floor) — the outlier threshold
 *  shared by the god-file and hotspot checks. */
function outlierThreshold(values: number[], k: number, floor: number): number {
  if (!values.length) return floor;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.max(floor, mean + k * Math.sqrt(variance));
}

/** Hotspots — files that are BOTH frequently changed (git churn) AND heavily
 *  depended on (import fan-in). The CodeScene-style refactor-priority signal:
 *  change-prone code that everything relies on is where risk concentrates.
 *  Needs git history; a no-op without it. */
function computeHotspots(
  nodes: GraphNode[],
  edges: GraphEdge[],
  churn: ChurnInfo[] | undefined,
): Insight[] {
  if (!churn || !churn.length) return [];
  const churnByRel = new Map(churn.map((c) => [c.relPath, c]));
  const inDeg = new Map<string, number>();
  for (const e of edges) {
    if (e.type !== 'import') continue;
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }
  const fileNodes = nodes.filter((n) => n.kind === 'file' && !n.path.startsWith('('));
  const churnVals = fileNodes.map((n) => churnByRel.get(n.path)?.commits ?? 0).filter((v) => v > 0);
  const finVals = fileNodes.map((n) => inDeg.get(n.id) ?? 0).filter((v) => v > 0);
  if (!churnVals.length || !finVals.length) return [];
  const churnT = outlierThreshold(churnVals, 1, 5);
  const finT = outlierThreshold(finVals, 1, 3);

  const items: Insight[] = [];
  const scoreById = new Map<string, number>(); // node id -> churn × fan-in
  for (const n of fileNodes) {
    const ch = churnByRel.get(n.path)?.commits ?? 0;
    const fin = inDeg.get(n.id) ?? 0;
    if (ch < churnT || fin < finT) continue;
    const authors = churnByRel.get(n.path)?.authors ?? 0;
    const hubEdges = edges
      .filter((e) => e.type === 'import' && e.target === n.id)
      .map((e) => e.id);
    scoreById.set(n.id, ch * fin);
    items.push({
      id: `hotspot:${n.id}`,
      severity: ch >= churnT * 1.6 && fin >= finT * 1.6 ? 'high' : 'medium',
      title: `${n.label} (${ch} commits · ${fin}↓)`,
      detail: `${shortPath(n.path)} changed in ${ch} commits${
        authors ? ` by ${authors} author${authors === 1 ? '' : 's'}` : ''
      } and is imported by ${fin} files. Frequently-changed code that many files depend on is a hotspot — the highest-leverage place to refactor or add tests.`,
      nodes: [n.id],
      edges: hubEdges,
    });
  }
  // Rank by churn × fan-in (the hotspot "area"), tie-break by id for stability.
  items.sort(
    (a, b) =>
      (scoreById.get(b.nodes[0]) ?? 0) - (scoreById.get(a.nodes[0]) ?? 0) ||
      a.nodes[0].localeCompare(b.nodes[0]),
  );
  return items;
}

/** Temporal coupling — file pairs that change together across commits but have
 *  NO import edge between them. A hidden dependency the static import graph can't
 *  see (shared implicit contract, parallel hierarchies, copy-paste drift).
 *  Needs git history; a no-op without it. */
function computeTemporalCoupling(
  nodes: GraphNode[],
  edges: GraphEdge[],
  byId: Map<string, GraphNode>,
  coChange: CoChangePair[] | undefined,
): Insight[] {
  if (!coChange || !coChange.length) return [];
  const fileNodeIds = new Set(nodes.filter((n) => n.kind === 'file').map((n) => n.id)); // id === relPath
  const importPair = new Set<string>();
  for (const e of edges) {
    if (e.type === 'import') importPair.add(e.source + '|' + e.target);
  }
  const hasImport = (a: string, b: string): boolean =>
    importPair.has(a + '|' + b) || importPair.has(b + '|' + a);

  const items: Insight[] = [];
  for (const p of coChange) {
    if (items.length >= 40) break; // cap noise
    if (!fileNodeIds.has(p.a) || !fileNodeIds.has(p.b)) continue;
    if (p.support < 0.5) continue;
    if (hasImport(p.a, p.b)) continue;
    const na = byId.get(p.a);
    const nb = byId.get(p.b);
    items.push({
      id: `cochange:${p.a}::${p.b}`,
      severity: p.support >= 0.7 ? 'medium' : 'low',
      title: `${na?.label ?? p.a} ↔ ${nb?.label ?? p.b}`,
      detail: `${shortPath(p.a)} and ${shortPath(p.b)} changed together in ${p.together} commits (${Math.round(
        p.support * 100,
      )}% co-change) yet neither imports the other — a hidden coupling. Changes to one likely require the other.`,
      nodes: [p.a, p.b],
    });
  }
  return items;
}

/** Untested pages — page classes whose declaring file no test imports. Only
 *  runs when at least one test was resolved (coveredRel non-empty); a project
 *  with zero tests is a different problem and would flag every page. */
function computeUntestedPages(
  nodes: GraphNode[],
  coveredRel: string[] | undefined,
): Insight[] {
  if (!coveredRel || !coveredRel.length) return [];
  const covered = new Set(coveredRel);
  const items: Insight[] = [];
  for (const n of nodes) {
    if (n.kind !== 'page') continue;
    if (covered.has(n.path)) continue;
    items.push({
      id: `untested:${n.id}`,
      severity: 'low',
      title: n.label,
      detail: `No test file imports ${n.label}${
        n.routePath ? ` (${n.routePath})` : ''
      } (declared in ${shortPath(n.path)}) — it appears to have no test coverage.`,
      nodes: [n.id],
    });
  }
  items.sort((a, b) => a.title.localeCompare(b.title));
  return items;
}

/** Compute the full insights report from a built graph. `inputs` carries the
 *  optional history/config-derived data that enables the extended categories;
 *  omit it and only the pure graph-derived categories run. */
export function computeInsights(graph: GraphData, inputs: InsightInputs = {}): InsightsReport {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const { nodes, edges } = graph;
  const churn = inputs.git?.churn;
  const coChange = inputs.git?.coChange;

  const categories: InsightCategory[] = [
    {
      key: 'layer-violation',
      label: 'Layer violations',
      description:
        'Clean-architecture dependency breaks — a core layer importing an outer one (domain→data/presentation, data→presentation).',
      items: computeLayerViolations(nodes, edges, byId),
    },
    {
      key: 'cross-feature-import',
      label: 'Cross-feature deep imports',
      description:
        "A feature importing another feature's src/ internals instead of its public barrel — breaks module encapsulation.",
      items: computeCrossFeatureImports(edges, byId),
    },
    {
      key: 'policy-violation',
      label: 'Policy violations',
      description:
        'Forbidden dependencies declared in .pagemapper.json — custom per-project architecture rules.',
      items: inputs.policy ? evaluatePolicy(graph, inputs.policy) : [],
    },
    {
      key: 'circular-dep',
      label: 'Circular dependencies',
      description: 'Groups of files that import each other in a cycle.',
      items: computeCircularDeps(nodes, edges, byId),
    },
    {
      key: 'god-file',
      label: 'God files (hubs)',
      description:
        'Files with outlier import fan-in/fan-out — central hubs where changes ripple widely.',
      items: computeGodFiles(nodes, edges),
    },
    {
      key: 'hotspot',
      label: 'Hotspots (churn × coupling)',
      description:
        'Files changed often in git AND depended on by many — the highest-leverage refactor/test targets.',
      items: computeHotspots(nodes, edges, churn),
    },
    {
      key: 'dead-page',
      label: 'Unreachable pages',
      description: 'Page classes with no incoming navigation or widget usage.',
      items: computeDeadPages(nodes, edges),
    },
    {
      key: 'untested-page',
      label: 'Untested pages',
      description: 'Page classes that no test file imports — likely missing test coverage.',
      items: computeUntestedPages(nodes, inputs.coveredRel),
    },
    {
      key: 'nav-depth',
      label: 'Deep pages',
      description:
        'Pages many navigation taps from the app entry (BFS over navigate edges) — a discoverability signal.',
      items: computeNavDepth(nodes, edges, byId),
    },
    {
      key: 'orphan-file',
      label: 'Orphan files',
      description: 'Files with no imports in or out — possible dead code.',
      items: computeOrphanFiles(nodes, edges),
    },
    {
      key: 'temporal-coupling',
      label: 'Temporal coupling',
      description:
        'File pairs that change together in git history but have no import edge — a hidden dependency.',
      items: computeTemporalCoupling(nodes, edges, byId, coChange),
    },
  ];

  const summary: Record<string, number> = { total: 0 };
  for (const c of categories) {
    summary[c.key] = c.items.length;
    summary.total += c.items.length;
  }

  return { categories, summary };
}
