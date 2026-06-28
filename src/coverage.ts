// coverage.ts — Map test files to the source files they reference.
//
// The scanner keeps test files OUT of the graph (so they never pollute it) but
// records them in scan.testFiles. Here we read each test, reuse the real import
// resolver (parser/imports.ts + parser/context.ts), and collect every project
// file a test imports. The union is the "covered" set — used by the
// untested-page insight (a page no test imports is likely untested).
//
// This is an import-based heuristic, not line coverage: it answers "does any
// test reference this file?", which is a cheap, deterministic signal that needs
// no test run. Limitation: a test importing a barrel that re-exports the page
// counts the barrel, not the page.

import { promises as fs } from 'node:fs';
import type { Layer, ScanResult } from './types.js';
import { buildContext } from './parser/context.js';
import { parseImports } from './parser/imports.js';

/** Resolve every test file's imports to the project files they reference. */
export async function computeCoverage(scan: ScanResult): Promise<{ coveredRel: string[] }> {
  const tests = scan.testFiles ?? [];
  if (!tests.length) return { coveredRel: [] };

  const ctx = buildContext(scan);
  const covered = new Set<string>();

  const BATCH = 64;
  for (let i = 0; i < tests.length; i += BATCH) {
    const batch = tests.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (tf) => {
        let content: string;
        try {
          content = await fs.readFile(tf.absPath, 'utf8');
        } catch {
          return;
        }
        // parseImports wants a ScannedFile; a test file has the same shape (its
        // layer is irrelevant to import resolution).
        const pseudo = { absPath: tf.absPath, relPath: tf.relPath, layer: 'other' as Layer };
        for (const e of parseImports(pseudo, content, ctx)) {
          if (!e.external && e.toRel) covered.add(e.toRel);
        }
      }),
    );
  }

  return { coveredRel: Array.from(covered).sort() };
}
