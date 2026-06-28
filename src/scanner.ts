// scanner.ts — Discovers Dart source files and packages in a Flutter project.
//
// Responsibilities:
//   - Recursively walk the project tree, skipping build/platform/generated dirs.
//   - Honor a best-effort top-level .gitignore.
//   - Find every pubspec.yaml and read its `name:` -> PackageInfo.
//   - Classify each .dart file: owning package, feature, clean-arch layer.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Layer, PackageInfo, ScanResult, ScannedFile, ScannedTestFile } from './types.js';

/** Directory names that are never worth scanning for app source. */
const SKIP_DIRS = new Set([
  '.git',
  '.claude', // tooling config + git worktrees (duplicate source trees — never app code)
  '.dart_tool',
  'build',
  '.fvm',
  'node_modules',
  'ios',
  'android',
  'macos',
  'windows',
  'linux',
  'web', // platform web folders (not the pagemapper web UI)
  '.idea',
  '.vscode',
]);

/** Test directories: their .dart files are collected separately (for the
 *  test-coverage overlay) and kept OUT of the graph's `files`. */
const TEST_DIRS = new Set(['test', 'integration_test']);

/** Convert an absolute path to a POSIX-style path relative to root. */
function toRelPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Is this a generated Dart file we should ignore? */
function isGeneratedDart(name: string): boolean {
  return name.endsWith('.g.dart') || name.endsWith('.freezed.dart');
}

/**
 * Minimal .gitignore matcher: supports plain dir/file names, leading-slash
 * anchors, and trailing-slash directory markers. Glob `*` is treated loosely.
 * This is intentionally best-effort, not a full gitignore implementation.
 */
class GitignoreMatcher {
  private readonly patterns: string[] = [];

  constructor(lines: string[]) {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      // Normalize: strip leading/trailing slashes for simple name matching.
      this.patterns.push(line.replace(/^\/+/, '').replace(/\/+$/, ''));
    }
  }

  /** Does the given relative POSIX path (or any segment) match an ignore rule? */
  matches(relPosix: string): boolean {
    const segments = relPosix.split('/');
    for (const pat of this.patterns) {
      if (pat.includes('*')) {
        // Translate a simple glob to a regex and test the basename + full path.
        const re = new RegExp(
          '^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
        );
        const base = segments[segments.length - 1];
        if (re.test(base) || re.test(relPosix)) return true;
      } else {
        // Match any path segment exactly, or a path prefix.
        if (segments.includes(pat)) return true;
        if (relPosix === pat || relPosix.startsWith(pat + '/')) return true;
      }
    }
    return false;
  }
}

/** Load the top-level .gitignore if present. */
async function loadGitignore(root: string): Promise<GitignoreMatcher> {
  try {
    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    return new GitignoreMatcher(content.split(/\r?\n/));
  } catch {
    return new GitignoreMatcher([]);
  }
}

/** Read a pubspec.yaml's `name:` field (top-level only). */
async function readPackageName(pubspecPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(pubspecPath, 'utf8');
    // The first top-level `name:` key (not indented).
    const m = content.match(/^name:\s*(['"]?)([A-Za-z0-9_]+)\1\s*$/m);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

/** Infer the clean-architecture layer from a file's path segments. */
function inferLayer(relPosix: string): Layer {
  const p = `/${relPosix}/`;
  if (p.includes('/domain/')) return 'domain';
  if (p.includes('/data/')) return 'data';
  if (p.includes('/presentation/')) return 'presentation';
  return 'other';
}

/** Extract the feature name from `packages/features/<feature>/...`, if any. */
function inferFeature(relPosix: string): string | undefined {
  const m = relPosix.match(/packages\/features\/([^/]+)\//);
  return m ? m[1] : undefined;
}

/**
 * Walk the tree collecting absolute paths of .dart files and pubspec.yaml files.
 * Honors SKIP_DIRS, generated-file rules, and the .gitignore matcher.
 */
interface WalkOut {
  dartFiles: string[];
  pubspecs: string[];
  testDartFiles: string[];
}

async function walk(
  root: string,
  dir: string,
  ignore: GitignoreMatcher,
  out: WalkOut,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = toRelPosix(root, abs);

    if (entry.isDirectory()) {
      if (TEST_DIRS.has(entry.name)) {
        if (ignore.matches(rel)) continue;
        await walkTests(root, abs, ignore, out);
        continue;
      }
      if (SKIP_DIRS.has(entry.name)) continue;
      if (ignore.matches(rel)) continue;
      await walk(root, abs, ignore, out);
    } else if (entry.isFile()) {
      if (entry.name === 'pubspec.yaml') {
        out.pubspecs.push(abs);
        continue;
      }
      if (!entry.name.endsWith('.dart')) continue;
      if (isGeneratedDart(entry.name)) continue;
      if (ignore.matches(rel)) continue;
      out.dartFiles.push(abs);
    }
  }
}

/** Collect .dart files under a test/ or integration_test/ subtree into
 *  `out.testDartFiles` (never into the graph). */
async function walkTests(
  root: string,
  dir: string,
  ignore: GitignoreMatcher,
  out: WalkOut,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = toRelPosix(root, abs);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (ignore.matches(rel)) continue;
      await walkTests(root, abs, ignore, out);
    } else if (entry.isFile()) {
      if (!entry.name.endsWith('.dart')) continue;
      if (isGeneratedDart(entry.name)) continue;
      if (ignore.matches(rel)) continue;
      out.testDartFiles.push(abs);
    }
  }
}

/**
 * Given a file path and the list of packages, find the owning package: the one
 * whose root is the longest prefix of the file path.
 */
function ownerPackage(absPath: string, packages: PackageInfo[]): string | undefined {
  let best: PackageInfo | undefined;
  for (const pkg of packages) {
    const rootWithSep = pkg.root.endsWith(path.sep) ? pkg.root : pkg.root + path.sep;
    if (absPath.startsWith(rootWithSep)) {
      if (!best || pkg.root.length > best.root.length) best = pkg;
    }
  }
  return best?.name;
}

/** Scan a Flutter/Dart project: produce its file list and package map. */
export async function scanProject(projectRoot: string): Promise<ScanResult> {
  const root = path.resolve(projectRoot);
  const ignore = await loadGitignore(root);

  const collected: WalkOut = { dartFiles: [], pubspecs: [], testDartFiles: [] };
  await walk(root, root, ignore, collected);

  // Resolve packages from pubspecs.
  const packages: PackageInfo[] = [];
  for (const pubspec of collected.pubspecs) {
    const name = await readPackageName(pubspec);
    if (name) packages.push({ name, root: path.dirname(pubspec) });
  }

  // Classify files.
  const files: ScannedFile[] = collected.dartFiles
    .map((absPath) => {
      const relPath = toRelPosix(root, absPath);
      const file: ScannedFile = {
        absPath,
        relPath,
        layer: inferLayer(relPath),
      };
      const pkg = ownerPackage(absPath, packages);
      if (pkg) file.package = pkg;
      const feature = inferFeature(relPath);
      if (feature) file.feature = feature;
      return file;
    })
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Test files: kept separate from the graph, used by the coverage overlay.
  const testFiles: ScannedTestFile[] = collected.testDartFiles
    .map((absPath) => ({ absPath, relPath: toRelPosix(root, absPath) }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  return { projectRoot: root, packages, files, testFiles };
}
