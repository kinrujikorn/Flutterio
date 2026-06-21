// imports.ts — Parse `import`/`export` directives and resolve them to files.
//
// Resolution rules:
//   - `package:<pkg>/<subpath>`: if <pkg> is a project package, the target is
//     `<pkgRoot>/lib/<subpath>`. If that resolves to a scanned file -> internal
//     edge. If <pkg> is not a project package (flutter, dio, ...) -> external.
//   - relative imports (`../foo.dart`, `foo.dart`): resolved against the
//     importing file's directory.

import * as path from 'node:path';
import type { ImportEdge, ScannedFile } from '../types.js';
import { type ParseContext, relPosix } from './context.js';

// Matches `import '...';` and `export '...';` (single or double quotes).
// Captures the directive keyword and the quoted target.
const IMPORT_RE = /^\s*(import|export)\s+(['"])([^'"]+)\2/gm;

const PACKAGE_PREFIX = 'package:';
const DART_PREFIX = 'dart:';

/**
 * Resolve a `package:<pkg>/<subpath>` import to a scanned file's relPath.
 * Returns the relPath if it maps to a scanned file, else null.
 */
function resolvePackageImport(
  raw: string,
  ctx: ParseContext,
): { toRel: string | null; external: boolean } {
  const spec = raw.slice(PACKAGE_PREFIX.length); // e.g. "core/core.dart"
  const slash = spec.indexOf('/');
  const pkgName = slash === -1 ? spec : spec.slice(0, slash);
  const subpath = slash === -1 ? '' : spec.slice(slash + 1);

  const pkg = ctx.packagesByName.get(pkgName);
  if (!pkg) {
    // Not a project package (flutter, dio, freezed_annotation, ...).
    return { toRel: null, external: true };
  }

  // Project package: file lives at <pkgRoot>/lib/<subpath>.
  const absTarget = path.join(pkg.root, 'lib', subpath);
  const targetRel = relPosix(ctx.projectRoot, absTarget);
  const file = ctx.byRel.get(targetRel);
  if (file) return { toRel: file.relPath, external: false };

  // Belongs to a project package but the file wasn't scanned (e.g. generated
  // barrel, or a part not collected). Treat as internal-but-unresolved.
  return { toRel: null, external: false };
}

/** Resolve a relative import against the importing file's directory. */
function resolveRelativeImport(
  raw: string,
  fromAbsDir: string,
  ctx: ParseContext,
): string | null {
  const absTarget = path.resolve(fromAbsDir, raw);
  const targetRel = relPosix(ctx.projectRoot, absTarget);
  const file = ctx.byRel.get(targetRel);
  return file ? file.relPath : null;
}

/** Parse import/export edges out of one file's content. */
export function parseImports(
  file: ScannedFile,
  content: string,
  ctx: ParseContext,
): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const fromAbsDir = path.dirname(file.absPath);

  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const raw = m[3];

    if (raw.startsWith(DART_PREFIX)) {
      // dart:async, dart:io — always external.
      edges.push({ fromRel: file.relPath, toRel: null, raw, external: true });
      continue;
    }

    if (raw.startsWith(PACKAGE_PREFIX)) {
      const { toRel, external } = resolvePackageImport(raw, ctx);
      edges.push({ fromRel: file.relPath, toRel, raw, external });
      continue;
    }

    // Relative import.
    const toRel = resolveRelativeImport(raw, fromAbsDir, ctx);
    edges.push({ fromRel: file.relPath, toRel, raw, external: false });
  }

  return edges;
}
