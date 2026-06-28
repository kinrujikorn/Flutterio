// diff.ts — Structural + insight delta between a baseline graph and the current.
//
// Powers `--baseline` (gate CI on NEW findings only, so legacy debt doesn't
// block adoption) and `--diff` (write a portable GraphDiff). Findings are keyed
// by `category::id`; insight ids are deterministic (path/edge based), so the
// same finding has the same key across runs as long as the underlying paths are
// unchanged. Caveat: circular-dep ids are index-based, so cycle membership
// changes surface as add+remove churn — acceptable for a coarse signal.

import type { DiffInsightRef, GraphData, GraphDiff, Severity } from './types.js';

/** Flatten a graph's insight findings to a key → ref map. */
function flattenInsights(graph: GraphData): Map<string, DiffInsightRef> {
  const out = new Map<string, DiffInsightRef>();
  for (const c of graph.insights?.categories ?? []) {
    for (const it of c.items) {
      out.set(c.key + '::' + it.id, {
        category: c.key,
        id: it.id,
        title: it.title,
        severity: it.severity,
      });
    }
  }
  return out;
}

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const bySeverity = (a: DiffInsightRef, b: DiffInsightRef): number =>
  SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.title.localeCompare(b.title);

export function diffGraphs(baseline: GraphData, current: GraphData): GraphDiff {
  const bNodes = new Set(baseline.nodes.map((n) => n.id));
  const cNodes = new Set(current.nodes.map((n) => n.id));
  const bEdges = new Set(baseline.edges.map((e) => e.id));
  const cEdges = new Set(current.edges.map((e) => e.id));

  const nodesAdded = [...cNodes].filter((id) => !bNodes.has(id)).sort();
  const nodesRemoved = [...bNodes].filter((id) => !cNodes.has(id)).sort();
  const edgesAdded = [...cEdges].filter((id) => !bEdges.has(id)).sort();
  const edgesRemoved = [...bEdges].filter((id) => !cEdges.has(id)).sort();

  const bIns = flattenInsights(baseline);
  const cIns = flattenInsights(current);
  const added: DiffInsightRef[] = [];
  const removed: DiffInsightRef[] = [];
  const summary: Record<string, { added: number; removed: number }> = {};
  const bump = (cat: string, field: 'added' | 'removed'): void => {
    (summary[cat] ??= { added: 0, removed: 0 })[field]++;
    (summary.total ??= { added: 0, removed: 0 })[field]++;
  };

  for (const [key, ref] of cIns) {
    if (!bIns.has(key)) {
      added.push(ref);
      bump(ref.category, 'added');
    }
  }
  for (const [key, ref] of bIns) {
    if (!cIns.has(key)) {
      removed.push(ref);
      bump(ref.category, 'removed');
    }
  }
  added.sort(bySeverity);
  removed.sort(bySeverity);

  const diff: GraphDiff = {
    currentAt: current.generatedAt,
    nodes: { added: nodesAdded, removed: nodesRemoved },
    edges: { added: edgesAdded, removed: edgesRemoved },
    insights: { added, removed, summary },
  };
  if (baseline.generatedAt) diff.baselineAt = baseline.generatedAt;
  return diff;
}

/** Count NEW high-severity findings — the CI gate denominator for --baseline. */
export function countAddedBySeverity(diff: GraphDiff): { high: number; total: number } {
  let high = 0;
  for (const f of diff.insights.added) if (f.severity === 'high') high++;
  return { high, total: diff.insights.added.length };
}
