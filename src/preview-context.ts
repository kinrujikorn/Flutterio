// preview-context.ts — Project knowledge for the deterministic UI preview.
//
// Builds a `PreviewContext` for `renderPreview`: it lets the renderer resolve
// the app's own custom widgets (by class name → source) and its real theme
// colors (token member → hex), so design-system components render as their
// actual shapes/colors instead of generic boxes. Reads the project from disk
// synchronously (the renderer is sync); results are indexed once and cached.

import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { PreviewContext } from './preview.js';

/** Directories never worth indexing. */
const SKIP_DIRS = new Set([
  '.git', '.dart_tool', 'build', '.fvm', 'node_modules',
  'ios', 'android', 'macos', 'windows', 'linux', '.idea', '.vscode',
]);

/** `class Name` declarations (also abstract/mixin classes). */
const CLASS_RE = /\bclass\s+(\w+)/g;
/** Color token constants: `static const primary = Color(0xFF116DFC)`. */
const COLOR_TOKEN_RE = /(?:static\s+const|const)\s+(\w+)\s*=\s*Color\(0x([0-9A-Fa-f]{6,8})\)/g;

/**
 * Create a PreviewContext rooted at a project directory. Indexing is lazy
 * (built on first lookup) and cached for the life of the context.
 */
export function createPreviewContext(sourceRoot: string): PreviewContext {
  let classIndex: Map<string, string> | null = null; // class name -> abs file path
  let colorMap: Map<string, string> | null = null; // token member -> #rrggbb
  const fileCache = new Map<string, string>();

  function read(abs: string): string {
    let c = fileCache.get(abs);
    if (c === undefined) {
      try { c = readFileSync(abs, 'utf8'); } catch { c = ''; }
      fileCache.set(abs, c);
    }
    return c;
  }

  function walk(dir: string, out: string[]): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), out);
      } else if (
        e.name.endsWith('.dart') &&
        !e.name.endsWith('.g.dart') &&
        !e.name.endsWith('.freezed.dart')
      ) {
        out.push(path.join(dir, e.name));
      }
    }
  }

  function ensureIndexed(): void {
    if (classIndex) return;
    const idx = new Map<string, string>();
    const colors = new Map<string, string>();
    const files: string[] = [];
    walk(path.resolve(sourceRoot), files);
    for (const f of files) {
      const src = read(f);
      CLASS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CLASS_RE.exec(src)) !== null) {
        if (!idx.has(m[1])) idx.set(m[1], f); // first declaration wins
      }
      COLOR_TOKEN_RE.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = COLOR_TOKEN_RE.exec(src)) !== null) {
        // 0xAARRGGBB -> drop alpha; 0xRRGGBB -> as-is.
        const hex = cm[2].length === 8 ? cm[2].slice(2) : cm[2];
        if (!colors.has(cm[1])) colors.set(cm[1], '#' + hex.toLowerCase());
      }
    }
    classIndex = idx;
    colorMap = colors;
  }

  return {
    resolveClass(name: string): string | null {
      ensureIndexed();
      const file = classIndex!.get(name);
      // Return the whole file; the renderer locates the build() within it.
      return file ? read(file) : null;
    },
    colorToken(name: string): string | null {
      ensureIndexed();
      return colorMap!.get(name) ?? null;
    },
    localize(): string | null {
      // Localized strings (e.g. Tolgee) aren't resolvable from source here;
      // the renderer humanizes the key instead.
      return null;
    },
  };
}
