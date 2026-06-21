// navigation.ts — Extract pages (route targets) and navigation edges.
//
// Patterns handled (verified against the venio repo):
//   - Page classes:   class XxxPage extends StatelessWidget | StatefulWidget
//   - Static routes:  static const routePath = '/login';
//                     static String routePathFor(int i) => '/walkthrough/$i';
//   - GoRoute defs:    GoRoute(path: '/login' | SplashPage.routePath, builder: ...)
//   - Nav call sites:  context.go('/dashboard')
//                      context.go(SetPinPage.routePath)
//                      context.go(WalkthroughPage.routePathFor(0))
//                      context.goNamed(...), .push(...), .pushNamed(...), .replace(...)
//
// Per-file extraction returns "raw" pages and nav references. Cross-file
// resolution (mapping a routePath string or `Page.routePath` ref to the page
// class that declares it) happens in `resolveNavigation`, after all files
// have been scanned.

import type { NavEdge, PageInfo, ScannedFile } from '../types.js';

// A page class declaration. Page = class whose name ends in "Page" and that
// extends a widget base (or declares a routePath).
const PAGE_CLASS_RE =
  /class\s+([A-Z]\w*Page)\b[^{]*?\bextends\s+(StatelessWidget|StatefulWidget|State<[^>]*>|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget)/g;

// `static const routePath = '/login';`  (also handles `routeName`)
const ROUTE_PATH_CONST_RE =
  /static\s+const\s+(?:String\s+)?routePath\s*=\s*(['"])([^'"]+)\1/;

// `static String routePathFor(int i) => '/walkthrough/$i';`
const ROUTE_PATH_FOR_RE =
  /static\s+\w+\s+routePathFor\s*\([^)]*\)\s*=>\s*(['"])([^'"]+)\1/;

// Navigation call sites: match the method + opening paren; the argument list is
// then read with a balanced scan (so we can also pull out the `extra:` payload).
// e.g. context.go('/x'), context.pushNamed('foo'), context.go(SetPinPage.routePath)
const NAV_METHOD_RE =
  /\.\s*(go|push|replace|goNamed|pushNamed|pushReplacement|pushReplacementNamed|replaceNamed)\s*\(/g;

/** A raw navigation reference found in a file, before cross-file resolution. */
export interface RawNavRef {
  fromFileRel: string;
  method: string;
  /** The trimmed argument expression as written. */
  rawTarget: string;
  /** The `extra:` payload expression, if present. */
  extra?: string;
}

/**
 * Read a call's argument list starting at the index of its `(`. Returns the
 * top-level (comma-separated) arguments as trimmed strings, respecting nested
 * brackets and string literals, plus the index of the matching `)`.
 */
function readCallArgs(content: string, openIdx: number): { args: string[]; end: number } {
  const args: string[] = [];
  let cur = '';
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      cur += ch;
      if (ch === inStr && content[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      if (depth > 1) cur += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        if (cur.trim()) args.push(cur.trim());
        return { args, end: i };
      }
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return { args, end: content.length };
}

/** Page extraction + raw nav refs for a single file. */
export interface NavFileResult {
  pages: PageInfo[];
  navRefs: RawNavRef[];
}

/**
 * Slice the body of a class starting at `openBrace`, returning the substring up
 * to the matching close brace. Used to scope routePath consts to their class.
 */
function classBody(content: string, openBrace: number): string {
  let depth = 0;
  for (let i = openBrace; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return content.slice(openBrace, i + 1);
    }
  }
  return content.slice(openBrace);
}

/** Extract page classes and their route info, plus raw nav refs, from a file. */
export function parseNavigation(file: ScannedFile, content: string): NavFileResult {
  const pages: PageInfo[] = [];

  PAGE_CLASS_RE.lastIndex = 0;
  let pm: RegExpExecArray | null;
  while ((pm = PAGE_CLASS_RE.exec(content)) !== null) {
    const className = pm[1];
    // Find this class's body to scope the routePath search.
    const braceIdx = content.indexOf('{', pm.index);
    const body = braceIdx === -1 ? '' : classBody(content, braceIdx);

    const page: PageInfo = { className, fileRel: file.relPath };
    const constMatch = body.match(ROUTE_PATH_CONST_RE);
    if (constMatch) {
      page.routePath = constMatch[2];
    } else {
      const forMatch = body.match(ROUTE_PATH_FOR_RE);
      // Store the template (e.g. "/walkthrough/$i") so resolution can match it
      // by its literal prefix.
      if (forMatch) page.routePath = forMatch[2];
    }
    pages.push(page);
  }

  // Raw navigation call sites. Read the full (balanced) argument list so we can
  // capture both the target (first arg) and any `extra:` payload.
  const navRefs: RawNavRef[] = [];
  NAV_METHOD_RE.lastIndex = 0;
  let nm: RegExpExecArray | null;
  while ((nm = NAV_METHOD_RE.exec(content)) !== null) {
    const method = nm[1];
    const openIdx = nm.index + nm[0].length - 1; // points at '('
    const { args, end } = readCallArgs(content, openIdx);
    NAV_METHOD_RE.lastIndex = end; // continue past this call
    if (args.length === 0) continue;
    const rawTarget = args[0];
    if (!rawTarget) continue;
    const ref: RawNavRef = { fromFileRel: file.relPath, method, rawTarget };
    const extraArg = args.find((a) => /^extra\s*:/.test(a));
    if (extraArg) {
      const val = extraArg.replace(/^extra\s*:/, '').trim();
      if (val) ref.extra = val;
    }
    navRefs.push(ref);
  }

  return { pages, navRefs };
}

/** Strip surrounding quotes from a string literal expression, else null. */
function asStringLiteral(expr: string): string | null {
  const m = expr.match(/^(['"])(.*)\1$/s);
  return m ? m[2] : null;
}

/** Normalize a route template like "/walkthrough/$step" to its static prefix. */
function routePrefix(route: string): string {
  const dollar = route.indexOf('$');
  return dollar === -1 ? route : route.slice(0, dollar).replace(/\/$/, '');
}

/**
 * Resolve raw nav refs into NavEdges using global page knowledge.
 *
 * Resolution strategies, in order:
 *   1. `SomePage.routePath` / `SomePage.routePathFor(...)` -> that page's class.
 *   2. String literal route -> the page whose routePath matches (exact, then
 *      by static prefix for templated routes).
 */
export function resolveNavigation(
  navRefs: RawNavRef[],
  pages: PageInfo[],
): NavEdge[] {
  // Index pages for resolution.
  const byClass = new Map<string, PageInfo>();
  const byRoute = new Map<string, PageInfo>();
  const prefixes: { prefix: string; page: PageInfo }[] = [];
  for (const p of pages) {
    byClass.set(p.className, p);
    if (p.routePath) {
      const prefix = routePrefix(p.routePath);
      if (!byRoute.has(prefix)) byRoute.set(prefix, p);
      prefixes.push({ prefix, page: p });
    }
  }
  // Longest-prefix-first so "/walkthrough/x" beats "/".
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);

  const edges: NavEdge[] = [];
  for (const ref of navRefs) {
    const edge: NavEdge = {
      fromFileRel: ref.fromFileRel,
      rawTarget: ref.rawTarget,
      method: ref.method,
    };
    if (ref.extra) edge.extra = ref.extra;

    // Strategy 1: `SomePage.routePath` or `SomePage.routePathFor(...)`.
    const classRef = ref.rawTarget.match(/^([A-Z]\w*Page)\s*\.\s*routePath/);
    if (classRef) {
      const page = byClass.get(classRef[1]);
      if (page) {
        edge.targetClass = page.className;
        if (page.routePath) edge.routePath = page.routePath;
        edges.push(edge);
        continue;
      }
    }

    // Strategy 2: string literal route.
    const lit = asStringLiteral(ref.rawTarget);
    if (lit) {
      const route = lit.split('?')[0]; // drop query string
      edge.routePath = route;
      const exact = byRoute.get(routePrefix(route));
      if (exact) {
        edge.targetClass = exact.className;
      } else {
        // Match by longest static prefix (handles "/forgot-password/otp" etc.).
        const hit = prefixes.find(
          (pp) => pp.prefix && route.startsWith(pp.prefix),
        );
        if (hit) edge.targetClass = hit.page.className;
      }
    }

    edges.push(edge);
  }

  return edges;
}
