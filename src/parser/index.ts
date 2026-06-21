// index.ts — Orchestrate all per-file parsers into a single ParseResult.
//
// Reads each scanned file's content exactly once, feeds it to every parser,
// then runs the cross-file resolution passes (navigation, uses, api).

import { promises as fs } from 'node:fs';
import type { ParseResult, ScanResult } from '../types.js';
import { buildContext } from './context.js';
import { parseImports } from './imports.js';
import {
  parseNavigation,
  resolveNavigation,
  type RawNavRef,
} from './navigation.js';
import { parseWidgets, resolveUses } from './widgets.js';
import { parseApiClasses, resolveApi, type ApiClassDecl } from './api.js';
import type { ImportEdge, PageInfo, WidgetInfo } from '../types.js';

/** Read every scanned file, run all parsers, resolve cross-file edges. */
export async function parseProject(scan: ScanResult): Promise<ParseResult> {
  const ctx = buildContext(scan);

  const imports: ImportEdge[] = [];
  const pages: PageInfo[] = [];
  const widgets: WidgetInfo[] = [];
  const apiClasses: ApiClassDecl[] = [];
  const navRefs: RawNavRef[] = [];
  const contents = new Map<string, string>();

  // Read + per-file parse. Files are independent, so read them concurrently
  // in bounded batches to avoid exhausting file handles on large monorepos.
  const BATCH = 64;
  for (let i = 0; i < scan.files.length; i += BATCH) {
    const batch = scan.files.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (file) => {
        let content: string;
        try {
          content = await fs.readFile(file.absPath, 'utf8');
        } catch {
          return;
        }
        contents.set(file.relPath, content);

        for (const e of parseImports(file, content, ctx)) imports.push(e);

        const nav = parseNavigation(file, content);
        for (const p of nav.pages) pages.push(p);
        for (const r of nav.navRefs) navRefs.push(r);

        for (const w of parseWidgets(file, content)) widgets.push(w);
        for (const d of parseApiClasses(file, content)) apiClasses.push(d);
      }),
    );
  }

  // Cross-file resolution passes.
  const navEdges = resolveNavigation(navRefs, pages);
  const usesEdges = resolveUses(contents, widgets);
  const apiEdges = resolveApi(contents, apiClasses);

  return { imports, pages, navEdges, widgets, usesEdges, apiEdges };
}
