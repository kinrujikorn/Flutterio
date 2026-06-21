#!/usr/bin/env node
// cli.ts — PageMapper entry point.
//
// Usage:
//   pagemapper <project-path> [--port N] [--no-open] [--watch] [--json <outfile>]
//
// Runs scanProject -> parseProject -> buildGraph. With --json it writes the
// graph and exits; otherwise it starts the server (serving the repo's web/
// dir), prints the URL, and opens a browser unless --no-open. With --watch it
// re-analyzes on .dart file changes and live-pushes the new graph to the UI.

import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanProject } from './scanner.js';
import { parseProject } from './parser/index.js';
import { analyzeWithLsp } from './lsp/analyze.js';
import { buildGraph } from './graph-builder.js';
import { startServer, type RunningServer } from './server.js';
import { buildStandaloneHtml } from './export.js';
import type { GraphData } from './types.js';

interface CliArgs {
  projectPath?: string;
  port: number;
  open: boolean;
  watch: boolean;
  lsp: boolean;
  json?: string;
  export?: string;
  check: boolean;
  checkMaxHigh: number;
  /** Max allowed total findings in --check mode; Infinity = unlimited. */
  checkMaxTotal: number;
  catalog?: string;
  catalogBuild?: string;
  appUrl?: string;
}

/** Directories never worth scanning or watching. */
const SKIP_DIRS = new Set([
  '.git', '.dart_tool', 'build', '.fvm', 'node_modules',
  'ios', 'android', 'macos', 'windows', 'linux', '.idea', '.vscode',
]);

/** Parse argv (skipping node + script). */
function parseArgs(argv: string[]): CliArgs {
  // Watch and LSP are on by default; use --no-watch / --no-lsp to opt out.
  const args: CliArgs = {
    port: 4567, open: true, watch: true, lsp: true,
    check: false, checkMaxHigh: 0, checkMaxTotal: Infinity,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') args.open = false;
    else if (a === '--watch') args.watch = true;
    else if (a === '--no-watch') args.watch = false;
    else if (a === '--lsp') args.lsp = true;
    else if (a === '--no-lsp') args.lsp = false;
    else if (a === '--port') args.port = Number(argv[++i]) || args.port;
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--export') args.export = argv[++i];
    else if (a === '--check') args.check = true;
    // --max-high / --max-total are the CI thresholds (--check-max-high kept as an alias).
    else if (a === '--max-high' || a === '--check-max-high') args.checkMaxHigh = Math.max(0, Math.trunc(Number(argv[++i])) || 0);
    else if (a === '--max-total') {
      const n = Math.trunc(Number(argv[++i]));
      args.checkMaxTotal = Number.isFinite(n) && n >= 0 ? n : Infinity;
    }
    else if (a === '--catalog') args.catalog = argv[++i];
    else if (a === '--catalog-build') args.catalogBuild = argv[++i];
    else if (a === '--app-url') args.appUrl = argv[++i];
    else if (!a.startsWith('--') && !args.projectPath) args.projectPath = a;
  }
  return args;
}

/**
 * Locate the repo's web/ dir. This file runs either from dist/ (compiled) or
 * src/ (via tsx); the web/ folder is a sibling of both, one level up from the
 * compiled/source dir.
 */
function resolveWebDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/ or src/
  return path.resolve(here, '..', 'web');
}

/**
 * Run the full scan -> parse -> build pipeline. When `useLsp` is set we try the
 * Dart analysis server for accurate symbol/reference data, falling back to the
 * heuristic parser if Dart isn't available or the server fails.
 */
async function analyze(projectRoot: string, useLsp: boolean): Promise<GraphData> {
  const scan = await scanProject(projectRoot);
  let parse = null;
  if (useLsp) {
    try {
      parse = await analyzeWithLsp(scan);
    } catch {
      parse = null;
    }
  }
  if (!parse) parse = await parseProject(scan);
  return buildGraph(scan, parse);
}

function printSummary(graph: GraphData): void {
  const s = graph.stats;
  console.log('');
  console.log('PageMapper summary');
  console.log('  project   :', graph.projectRoot);
  console.log('  packages  :', s.packages);
  console.log('  files     :', s.files);
  console.log('  nodes     :', s.nodes, `(file=${s.node_file ?? 0}, page=${s.node_page ?? 0})`);
  console.log(
    '  edges     :',
    s.edges,
    `(import=${s.edge_import ?? 0}, navigate=${s.edge_navigate ?? 0}, uses=${s.edge_uses ?? 0}, api=${s.edge_api ?? 0})`,
  );
}

/**
 * --check (CI) mode: print a readable, CI-friendly insights summary and decide
 * pass/fail against the thresholds. Iterates `graph.insights.categories`,
 * printing one "label: count (n high)" line per category, counts high-severity
 * findings across all categories, and returns `true` when every threshold is
 * satisfied (so the caller can map it to an exit code).
 */
function printCheckResults(graph: GraphData, maxHigh: number, maxTotal: number): boolean {
  const report = graph.insights;
  const categories = report?.categories ?? [];

  let total = 0;
  let high = 0;
  console.log('');
  console.log('PageMapper check');
  if (!categories.length) {
    console.log('  (no insights reported)');
  }
  for (const c of categories) {
    const catHigh = c.items.filter((item) => item.severity === 'high').length;
    total += c.items.length;
    high += catHigh;
    console.log(`  ${c.label} (${c.key}): ${c.items.length} (${catHigh} high)`);
  }
  console.log(`  ----`);
  console.log(`  total: ${total} (${high} high)`);

  const maxTotalLabel = Number.isFinite(maxTotal) ? String(maxTotal) : 'unlimited';
  const reasons: string[] = [];
  if (high > maxHigh) {
    reasons.push(`high-severity findings ${high} exceed --max-high ${maxHigh}`);
  }
  if (Number.isFinite(maxTotal) && total > maxTotal) {
    reasons.push(`total findings ${total} exceed --max-total ${maxTotal}`);
  }

  console.log('');
  console.log(`  thresholds: --max-high ${maxHigh}, --max-total ${maxTotalLabel}`);
  if (reasons.length) {
    for (const r of reasons) console.log(`  ✗ ${r}`);
    console.log('');
    console.log('FAIL');
    return false;
  }
  console.log('');
  console.log('PASS');
  return true;
}

/** Walk up from `dir` looking for an `.fvmrc` (fvm-pinned Flutter project). */
function hasFvmrc(dir: string): boolean {
  let cur = path.resolve(dir);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(cur, '.fvmrc')) || existsSync(path.join(cur, '.fvm'))) return true;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return false;
}

/**
 * Run `flutter build web` in a catalog app dir; resolves on success. When the
 * project pins a Flutter version with fvm (`.fvmrc`), build through `fvm
 * flutter` so it uses that exact SDK — and add fvm's pub-global bin to PATH so
 * the executable resolves even when it isn't on the system PATH.
 */
function runFlutterBuild(dir: string): Promise<void> {
  const buildArgs = ['build', 'web', '--pwa-strategy=none', '--no-wasm-dry-run', '--no-tree-shake-icons'];
  const useFvm = hasFvmrc(dir);
  const cmd = useFvm ? 'fvm' : 'flutter';
  const args = useFvm ? ['flutter', ...buildArgs] : buildArgs;

  const env = { ...process.env };
  if (useFvm) {
    const binDirs = [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Pub', 'Cache', 'bin') : '',
      path.join(os.homedir(), '.pub-cache', 'bin'),
    ].filter(Boolean);
    env.PATH = [...binDirs, env.PATH ?? ''].join(path.delimiter);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: dir, shell: true, stdio: 'ignore', env });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} build web exited ${code}`))));
  });
}

interface WatchHooks {
  /** Fast heuristic graph, pushed immediately on every change. */
  onGraph: (g: GraphData) => void;
  /** Accurate LSP refine, debounced longer and coalesced (optional). */
  refine?: () => Promise<unknown>;
  /** Rebuild the Flutter component catalog, debounced longer (optional). */
  rebuildCatalog?: () => Promise<unknown>;
}

/**
 * Watch the project for .dart changes. On each change we (1) push a fast
 * heuristic graph immediately, then — debounced longer so rapid saves coalesce
 * — (2) re-run the accurate LSP analysis and (3) rebuild the live catalog.
 * chokidar is loaded lazily so non-watch runs don't pay for it.
 */
async function startWatching(projectRoot: string, hooks: WatchHooks): Promise<void> {
  let chokidar: typeof import('chokidar');
  try {
    chokidar = await import('chokidar');
  } catch {
    console.error('  (watch unavailable: `chokidar` is not installed — run `npm install`)');
    return;
  }

  const watcher = chokidar.watch(projectRoot, {
    ignoreInitial: true,
    ignored: (p: string) => p.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg)),
  });

  // (1) Fast heuristic rebuild — 300ms debounce.
  let fastTimer: NodeJS.Timeout | undefined;
  let running = false;
  let dirtyWhileRunning = false;
  const rebuild = async (): Promise<void> => {
    if (running) { dirtyWhileRunning = true; return; }
    running = true;
    try {
      const graph = await analyze(projectRoot, false);
      hooks.onGraph(graph);
      const s = graph.stats;
      console.error(`  ↻ updated · ${s.nodes} nodes, ${s.edges} edges (${new Date().toLocaleTimeString()})`);
    } catch (err) {
      console.error('  ↻ re-analyze failed:', (err as Error).message);
    } finally {
      running = false;
      if (dirtyWhileRunning) { dirtyWhileRunning = false; scheduleFast(); }
    }
  };
  const scheduleFast = (): void => {
    if (fastTimer) clearTimeout(fastTimer);
    fastTimer = setTimeout(rebuild, 300);
  };

  // Generic coalescing debounced runner for the slow hooks (LSP, catalog).
  function makeDebounced(fn: () => Promise<unknown>, ms: number): () => void {
    let timer: NodeJS.Timeout | undefined;
    return () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void fn(); }, ms);
    };
  }
  // LSP refine settles ~4s after the last change; catalog build ~6s (heavier).
  const scheduleRefine = hooks.refine ? makeDebounced(hooks.refine, 4000) : undefined;
  const scheduleCatalog = hooks.rebuildCatalog ? makeDebounced(hooks.rebuildCatalog, 6000) : undefined;

  watcher.on('all', (_event: string, changed: string) => {
    if (!changed.endsWith('.dart')) return;
    scheduleFast();
    scheduleRefine?.();
    scheduleCatalog?.();
  });

  const extras = [hooks.refine && 'LSP refine', hooks.rebuildCatalog && 'catalog rebuild'].filter(Boolean);
  console.error(
    `Watching for .dart changes — graph updates automatically${extras.length ? ' (+ ' + extras.join(' + ') + ')' : ''}.`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectPath) {
    console.error(
      'Usage: pagemapper <project-path> [--port N] [--no-open] [--no-watch] [--no-lsp] [--json <out>] [--export <out.html>] [--check] [--max-high N] [--max-total N]',
    );
    process.exit(1);
  }

  const projectRoot = path.resolve(args.projectPath);
  try {
    const st = await fs.stat(projectRoot);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`Error: project path does not exist or is not a directory: ${projectRoot}`);
    process.exit(1);
  }

  console.error(`Scanning ${projectRoot} ...`);

  // --check is a one-shot CI gate: run the same analysis path as --json/--export
  // (respecting --no-lsp), print an insights summary, and exit non-zero when the
  // findings exceed --max-high / --max-total. No server, watch, or browser.
  if (args.check) {
    if (args.lsp) console.error('Analyzing with Dart LSP (use --no-lsp to skip) ...');
    const graph = await analyze(projectRoot, args.lsp);
    const passed = printCheckResults(graph, args.checkMaxHigh, args.checkMaxTotal);
    process.exit(passed ? 0 : 1);
  }

  // --json / --export are one-shot: do the accurate (LSP) analysis up front.
  if (args.json || args.export) {
    if (args.lsp) console.error('Analyzing with Dart LSP (use --no-lsp to skip) ...');
    const graph = await analyze(projectRoot, args.lsp);
    printSummary(graph);
    if (args.json) {
      const out = path.resolve(args.json);
      await fs.writeFile(out, JSON.stringify(graph, null, 2), 'utf8');
      console.log(`\nWrote graph JSON -> ${out}`);
    }
    if (args.export) {
      const out = path.resolve(args.export);
      const html = await buildStandaloneHtml(graph, resolveWebDir());
      await fs.writeFile(out, html, 'utf8');
      console.log(`\nWrote standalone HTML -> ${out}`);
    }
    return;
  }

  // Server mode: render the fast heuristic graph immediately so the browser
  // opens right away, then (if --lsp) refine it with the Dart analysis server
  // in the background and live-push the accurate graph over SSE.
  const fast = await analyze(projectRoot, false);
  printSummary(fast);

  const webDir = resolveWebDir();

  // Shared LSP-refine routine used by both the background initial refine and
  // the "Re-run LSP" button (POST /refine). A flag prevents overlapping runs.
  let server: RunningServer;
  let refining = false;
  const refine = async (): Promise<{ ok: boolean; uses?: number; reason?: string }> => {
    if (refining) return { ok: false, reason: 'busy' };
    refining = true;
    try {
      const scan = await scanProject(projectRoot);
      const parse = await analyzeWithLsp(scan);
      if (!parse) return { ok: false, reason: 'unavailable' };
      const accurate = buildGraph(scan, parse);
      server.update(accurate);
      const uses = accurate.stats.edge_uses ?? 0;
      console.error(`  ✓ LSP refine applied · ${uses} uses, ${accurate.stats.edge_api ?? 0} api edges`);
      return { ok: true, uses };
    } catch {
      return { ok: false, reason: 'error' };
    } finally {
      refining = false;
    }
  };

  server = await startServer(fast, webDir, args.port, {
    onRefine: refine,
    sourceRoot: projectRoot,
    catalogUrl: args.catalog,
    appUrl: args.appUrl,
  });
  console.log(`\nPageMapper serving at ${server.url}`);
  console.log('Press Ctrl+C to stop.');

  if (args.lsp) {
    console.error('Refining with Dart LSP in the background (use --no-lsp to skip) ...');
    refine().catch(() => { /* keep the heuristic graph on failure */ });
  }

  if (args.watch) {
    // On each change: push the fast heuristic graph immediately, then (debounced
    // longer, coalesced) re-run LSP for accuracy and rebuild the live catalog.
    let catalogBuilding = false;
    let catalogDirty = false;
    const rebuildCatalog = args.catalogBuild
      ? async (): Promise<void> => {
          if (catalogBuilding) { catalogDirty = true; return; }
          catalogBuilding = true;
          console.error('  ⟳ rebuilding component catalog (flutter build web) ...');
          try {
            await runFlutterBuild(args.catalogBuild!);
            server.notifyCatalog();
            console.error('  ✓ catalog rebuilt — Live previews refreshed');
          } catch (err) {
            console.error('  catalog rebuild failed:', (err as Error).message);
          } finally {
            catalogBuilding = false;
            if (catalogDirty) { catalogDirty = false; void rebuildCatalog!(); }
          }
        }
      : undefined;

    await startWatching(projectRoot, {
      onGraph: (g) => server.update(g),
      refine: args.lsp ? refine : undefined,
      rebuildCatalog,
    });
  }

  if (args.open) {
    try {
      const { default: open } = await import('open');
      await open(server.url);
    } catch {
      // `open` is optional at runtime; ignore failures (headless, CI, etc.).
    }
  }
}

main().catch((err) => {
  console.error('PageMapper failed:', err);
  process.exit(1);
});
