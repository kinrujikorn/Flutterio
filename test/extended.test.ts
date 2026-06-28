// extended.test.ts — Unit tests for the Tier-1/2 features: graph diff, policy
// engine, and the git/coverage-driven insight categories (hotspot, temporal
// coupling, untested pages). Pure functions over synthetic graphs — no git/fs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInsights } from '../src/insights.ts';
import { evaluatePolicy } from '../src/policy.ts';
import { diffGraphs } from '../src/diff.ts';
import type { GraphData, GraphEdge, GraphNode, InsightInputs } from '../src/types.ts';

function fileNode(rel: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id: rel, label: rel.split('/').pop()!, kind: 'file', path: rel, layer: 'other', ...extra };
}
function pageNode(cls: string, path: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id: `page:${cls}`, label: cls, kind: 'page', path, layer: 'presentation', ...extra };
}
function importEdge(from: string, to: string): GraphEdge {
  return { id: `import:${from}->${to}`, source: from, target: to, type: 'import' };
}
function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphData {
  return {
    projectRoot: '/x',
    generatedAt: '2026-06-27T00:00:00.000Z',
    packages: [],
    nodes,
    edges,
    stats: {},
  };
}

function category(g: GraphData, inputs: InsightInputs, key: string) {
  const report = computeInsights(g, inputs);
  return report.categories.find((c) => c.key === key)!;
}

test('hotspot: flags high-churn × high-fan-in files only', () => {
  // hub.dart is imported by 6 files and changed in 20 commits → hotspot.
  // leaf.dart is imported by 6 files but barely changes → not a hotspot.
  const deps = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => fileNode(`${n}.dart`));
  const hub = fileNode('hub.dart');
  const leaf = fileNode('leaf.dart');
  const nodes = [...deps, hub, leaf];
  const edges = deps.flatMap((d) => [importEdge(d.id, 'hub.dart'), importEdge(d.id, 'leaf.dart')]);
  const inputs: InsightInputs = {
    git: {
      churn: [
        { relPath: 'hub.dart', commits: 20, authors: 4 },
        { relPath: 'leaf.dart', commits: 1, authors: 1 },
        ...deps.map((d) => ({ relPath: d.id, commits: 1, authors: 1 })),
      ],
      coChange: [],
      commitsScanned: 50,
    },
  };
  const cat = category(makeGraph(nodes, edges), inputs, 'hotspot');
  const titles = cat.items.map((i) => i.title);
  assert.ok(titles.some((t) => t.startsWith('hub.dart')), `hub should be a hotspot: ${titles}`);
  assert.ok(!titles.some((t) => t.startsWith('leaf.dart')), 'leaf should NOT be a hotspot');
});

test('hotspot: no git history → no findings', () => {
  const nodes = [fileNode('a.dart'), fileNode('b.dart')];
  const edges = [importEdge('a.dart', 'b.dart')];
  const cat = category(makeGraph(nodes, edges), {}, 'hotspot');
  assert.equal(cat.items.length, 0);
});

test('temporal-coupling: co-change pair with no import edge is flagged', () => {
  const nodes = [fileNode('x.dart'), fileNode('y.dart'), fileNode('z.dart')];
  // x imports z (so x↔z must NOT be flagged even if they co-change).
  const edges = [importEdge('x.dart', 'z.dart')];
  const inputs: InsightInputs = {
    git: {
      churn: [],
      coChange: [
        { a: 'x.dart', b: 'y.dart', together: 5, support: 0.8 }, // no import → flag
        { a: 'x.dart', b: 'z.dart', together: 5, support: 0.9 }, // import exists → skip
      ],
      commitsScanned: 20,
    },
  };
  const cat = category(makeGraph(nodes, edges), inputs, 'temporal-coupling');
  assert.equal(cat.items.length, 1, 'only the import-free pair is flagged');
  assert.deepEqual(cat.items[0].nodes.sort(), ['x.dart', 'y.dart']);
});

test('temporal-coupling: low-support pairs are ignored', () => {
  const nodes = [fileNode('x.dart'), fileNode('y.dart')];
  const inputs: InsightInputs = {
    git: { churn: [], coChange: [{ a: 'x.dart', b: 'y.dart', together: 5, support: 0.3 }], commitsScanned: 20 },
  };
  const cat = category(makeGraph(nodes, []), inputs, 'temporal-coupling');
  assert.equal(cat.items.length, 0);
});

test('untested-page: page not referenced by tests is flagged; covered one is not', () => {
  const nodes = [pageNode('LoginPage', 'login.dart'), pageNode('HomePage', 'home.dart')];
  const inputs: InsightInputs = { coveredRel: ['login.dart'] };
  const cat = category(makeGraph(nodes, []), inputs, 'untested-page');
  const titles = cat.items.map((i) => i.title);
  assert.deepEqual(titles, ['HomePage']);
});

test('untested-page: no coverage data → no findings (avoids flagging everything)', () => {
  const nodes = [pageNode('LoginPage', 'login.dart')];
  const cat = category(makeGraph(nodes, []), {}, 'untested-page');
  assert.equal(cat.items.length, 0);
});

test('policy: forbidden feature→feature import is flagged', () => {
  const a = fileNode('packages/features/auth/lib/src/a.dart', { feature: 'auth' });
  const b = fileNode('packages/features/billing/lib/src/b.dart', { feature: 'billing' });
  const c = fileNode('packages/features/auth/lib/src/c.dart', { feature: 'auth' });
  const g = makeGraph([a, b, c], [importEdge(a.id, b.id), importEdge(a.id, c.id)]);
  const items = evaluatePolicy(g, {
    forbidden: [{ name: 'auth↛billing', from: 'feature:auth', to: 'feature:billing' }],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'auth↛billing');
  assert.equal(items[0].severity, 'high');
  assert.deepEqual(items[0].edges, [`import:${a.id}->${b.id}`]);
});

test('policy: path glob selector + custom severity', () => {
  const legacy = fileNode('lib/legacy/old.dart');
  const fresh = fileNode('lib/feature/new.dart');
  const g = makeGraph([legacy, fresh], [importEdge('lib/legacy/old.dart', 'lib/feature/new.dart')]);
  const items = evaluatePolicy(g, {
    forbidden: [{ from: 'path:**/legacy/**', to: '*', severity: 'medium' }],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, 'medium');
});

test('policy: ** matches at segment boundaries, not substrings', () => {
  // `**/legacy/**` must match a `legacy/` segment — including at the root — but
  // NOT a path where "legacy" is only a substring of a segment (e.g. xlegacy).
  const real = fileNode('apps/legacy/a.dart');
  const rootLegacy = fileNode('legacy/b.dart');
  const fake = fileNode('apps/xlegacy/c.dart');
  const sink = fileNode('lib/sink.dart');
  const g = makeGraph(
    [real, rootLegacy, fake, sink],
    [importEdge(real.id, sink.id), importEdge(rootLegacy.id, sink.id), importEdge(fake.id, sink.id)],
  );
  const items = evaluatePolicy(g, { forbidden: [{ from: 'path:**/legacy/**', to: '*' }] });
  const froms = items.map((i) => i.nodes[0]).sort();
  assert.deepEqual(froms, ['apps/legacy/a.dart', 'legacy/b.dart'], 'matches real legacy segments, not xlegacy');
});

test('policy: layer + package selectors, and no false positives', () => {
  const dom = fileNode('core/lib/domain/d.dart', { package: 'core', layer: 'domain' });
  const data = fileNode('core/lib/data/r.dart', { package: 'core', layer: 'data' });
  const g = makeGraph([dom, data], [importEdge(dom.id, data.id)]);
  // domain→data forbidden
  assert.equal(evaluatePolicy(g, { forbidden: [{ from: 'layer:domain', to: 'layer:data' }] }).length, 1);
  // data→domain is allowed (edge goes domain→data), so this rule shouldn't fire
  assert.equal(evaluatePolicy(g, { forbidden: [{ from: 'layer:data', to: 'layer:domain' }] }).length, 0);
  // package match
  assert.equal(evaluatePolicy(g, { forbidden: [{ from: 'pkg:core', to: 'pkg:core' }] }).length, 1);
});

test('policy: empty/absent config is a no-op', () => {
  const g = makeGraph([fileNode('a.dart'), fileNode('b.dart')], [importEdge('a.dart', 'b.dart')]);
  assert.equal(evaluatePolicy(g, {}).length, 0);
  assert.equal(evaluatePolicy(g, { forbidden: [] }).length, 0);
});

test('diff: detects added/removed nodes, edges, and findings', () => {
  // baseline: a, b with a→b (no findings). current: adds c with a forbidden-ish
  // layer violation domain→data so the insight diff is non-empty.
  const aBase = fileNode('a.dart');
  const bBase = fileNode('b.dart');
  const baseline = makeGraph([aBase, bBase], [importEdge('a.dart', 'b.dart')]);
  baseline.insights = computeInsights(baseline);

  const dom = fileNode('a.dart', { layer: 'domain' });
  const data = fileNode('b.dart', { layer: 'data' });
  const c = fileNode('c.dart', { layer: 'data' });
  const current = makeGraph([dom, data, c], [importEdge('a.dart', 'b.dart'), importEdge('c.dart', 'b.dart')]);
  current.insights = computeInsights(current);

  const diff = diffGraphs(baseline, current);
  assert.deepEqual(diff.nodes.added, ['c.dart']);
  assert.deepEqual(diff.nodes.removed, []);
  assert.deepEqual(diff.edges.added, ['import:c.dart->b.dart']);
  // a.dart (domain) → b.dart (data) is a new layer violation.
  assert.ok(diff.insights.added.some((f) => f.category === 'layer-violation'), 'new layer violation surfaces in diff');
  assert.ok(diff.insights.summary.total.added >= 1);
});

test('diff: identical graphs → empty diff', () => {
  const g = makeGraph([fileNode('a.dart'), fileNode('b.dart')], [importEdge('a.dart', 'b.dart')]);
  g.insights = computeInsights(g);
  // Clone via JSON to simulate a saved baseline.
  const clone = JSON.parse(JSON.stringify(g)) as GraphData;
  const diff = diffGraphs(clone, g);
  assert.equal(diff.nodes.added.length, 0);
  assert.equal(diff.nodes.removed.length, 0);
  assert.equal(diff.edges.added.length, 0);
  assert.equal(diff.insights.added.length, 0);
  assert.equal(diff.insights.removed.length, 0);
});
