// context.ts — Shared lookup context passed to every parser.
//
// Built once from a ScanResult so parsers can resolve `package:` and relative
// imports, and map relative paths back to scanned files quickly.

import * as path from 'node:path';
import type { PackageInfo, ScanResult, ScannedFile } from '../types.js';

export interface ParseContext {
  projectRoot: string;
  /** All scanned files. */
  files: ScannedFile[];
  /** relPath -> ScannedFile. */
  byRel: Map<string, ScannedFile>;
  /** package name -> PackageInfo. */
  packagesByName: Map<string, PackageInfo>;
  /** Set of project package names (for external detection). */
  projectPackageNames: Set<string>;
}

/** Convert an absolute path to a POSIX-style path relative to the project root. */
export function relPosix(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join('/');
}

/** Build a ParseContext from a ScanResult. */
export function buildContext(scan: ScanResult): ParseContext {
  const byRel = new Map<string, ScannedFile>();
  for (const f of scan.files) byRel.set(f.relPath, f);

  const packagesByName = new Map<string, PackageInfo>();
  for (const p of scan.packages) packagesByName.set(p.name, p);

  return {
    projectRoot: scan.projectRoot,
    files: scan.files,
    byRel,
    packagesByName,
    projectPackageNames: new Set(packagesByName.keys()),
  };
}
