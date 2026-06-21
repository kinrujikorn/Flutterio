// smoke.test.ts — Full-pipeline smoke test against the real venio repo.
// Skips gracefully if the repo isn't present on this machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { scanProject } from '../src/scanner.ts';
import { parseProject } from '../src/parser/index.ts';
import { buildGraph } from '../src/graph-builder.ts';

const VENIO = 'C:\\Users\\kin\\Documents\\GitHub\\venio-mobile-app';

test('smoke: full pipeline against venio repo', { skip: !existsSync(VENIO) ? 'venio repo not present' : false }, async () => {
  const scan = await scanProject(VENIO);
  const parse = await parseProject(scan);
  const graph = buildGraph(scan, parse);

  // Packages include the known ones.
  const names = new Set(scan.packages.map((p) => p.name));
  for (const expected of ['core', 'auth', 'design_system']) {
    assert.ok(names.has(expected), `expected package "${expected}" (got ${[...names].join(', ')})`);
  }

  // More than 400 file nodes.
  const fileNodes = graph.nodes.filter((n) => n.kind === 'file' && !n.id.startsWith('svc:'));
  assert.ok(fileNodes.length > 400, `expected >400 file nodes, got ${fileNodes.length}`);

  // Non-empty import edges.
  const importEdges = graph.edges.filter((e) => e.type === 'import');
  assert.ok(importEdges.length > 0, 'expected non-empty import edges');

  // At least one navigate edge whose resolved target route is /dashboard.
  const dashNav = graph.edges.filter(
    (e) => e.type === 'navigate' && (e.label === '/dashboard' || e.target === 'page:DashboardPage'),
  );
  assert.ok(dashNav.length > 0, 'expected a navigate edge targeting /dashboard');
});
