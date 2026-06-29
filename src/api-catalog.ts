// api-catalog.ts — Discover every HTTP API call in the project and synthesize a
// readable mock request/response for each, so the API can be understood without
// reading the (often complex) datasource code.
//
// Grounded in venio's real patterns (surveyed): Dio verb calls in
// *remote_datasource*.dart, paths as string literals / `$id` interpolation /
// `XEndpoints.method()` constants / local path vars; request via `data:` map or
// `model.toJson()`; response via the enclosing method's `Future<T>` return type.
// Everything is deterministic regex + the model registry — no network, no LLM.

import { promises as fs } from 'node:fs';
import type { ApiCatalog, ApiEndpoint, ScanResult } from './types.js';
import { buildModelRegistry } from './parser/models.js';
import { mockForClass, type Registry } from './mock-gen.js';

/** Dio-ish receiver `.verb<...>(` — the start of an HTTP call. */
const CALL_RE =
  /(?:^|[^.\w])((?:_\w+)|(?:\w*[Cc]lient)|(?:\w*[Dd]io))\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^<>{};]*(?:<[^<>{};]*>)?[^<>{};]*>)?\s*\(/g;

/** Enclosing-method return type: `Future<List<X>> name(` / `Future<X> name(`.
 *  `>+` absorbs the closing `>>` of a nested generic like `Future<List<X>>`. */
const METHOD_RE = /Future\s*<\s*(List\s*<\s*)?([A-Za-z_]\w*)[^>{};]*>+\s+(\w+)\s*\(/g;
/** Enclosing class. */
const CLASS_RE = /\bclass\s+([A-Z]\w*)/g;

/** Read all scanned files into a rel → content map (bounded concurrency). */
async function readAll(scan: ScanResult): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  const BATCH = 64;
  for (let i = 0; i < scan.files.length; i += BATCH) {
    const batch = scan.files.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (f) => {
        try {
          contents.set(f.relPath, await fs.readFile(f.absPath, 'utf8'));
        } catch { /* skip unreadable */ }
      }),
    );
  }
  return contents;
}

/** Parse `*Endpoints` classes → Map<"Class.member", pathTemplate>. */
function parseEndpointConsts(contents: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const classRe = /\bclass\s+(\w*Endpoints?)\b[\s\S]*?\{/g;
  for (const content of contents.values()) {
    classRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = classRe.exec(content)) !== null) {
      const cls = cm[1];
      const body = content.slice(cm.index, cm.index + 40000); // bounded window (large Endpoints classes)
      // static String method(...) => 'path';  |  { ... return 'path'; }
      const fnRe = /static\s+(?:String|const\s+String|final\s+String)\s+(\w+)\s*(?:\([^)]*\))?\s*(?:=>|\{[^}]*?return)\s*['"]([^'"]+)['"]/g;
      let fm: RegExpExecArray | null;
      while ((fm = fnRe.exec(body)) !== null) out.set(`${cls}.${fm[1]}`, fm[2]);
      // static const member = 'path';
      const constRe = /static\s+const\s+(\w+)\s*=\s*['"]([^'"]+)['"]/g;
      let km: RegExpExecArray | null;
      while ((km = constRe.exec(body)) !== null) {
        if (!out.has(`${cls}.${km[1]}`)) out.set(`${cls}.${km[1]}`, km[2]);
      }
    }
  }
  return out;
}

/** Read a balanced `(...)` starting at `openIdx` (the '(' index). */
function readArgs(s: string, openIdx: number): { args: string; end: number } {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') inStr = c;
    else if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') {
      depth--;
      if (depth === 0) return { args: s.slice(openIdx + 1, i), end: i };
    }
  }
  return { args: s.slice(openIdx + 1), end: s.length };
}

/** Split a top-level comma list (respects strings + nesting). */
function splitTopArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { cur += c + (s[++i] ?? ''); continue; }
      if (c === inStr) inStr = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Normalize a Dart string path: `$id`/`${expr}` → `{id}`/`{expr}`. */
function normalizePath(lit: string): string {
  return lit
    .replace(/\$\{([^}]+)\}/g, (_, e) => '{' + lastIdent(e) + '}')
    .replace(/\$([A-Za-z_]\w*)/g, (_, e) => '{' + e + '}');
}
function lastIdent(expr: string): string {
  const m = expr.trim().match(/([A-Za-z_]\w*)\s*$/);
  return m ? m[1] : 'param';
}

/** Find the value of a named argument (`data:` / `queryParameters:`) in args. */
function namedArg(parts: string[], name: string): string | null {
  for (const p of parts) {
    const m = new RegExp('^\\s*' + name + '\\s*:').exec(p);
    if (m) return p.slice(m[0].length).trim();
  }
  return null;
}

/** Parse a `{ 'k': v, ... }` Dart map literal into a mock object (best-effort). */
function mockFromMapLiteral(expr: string): Record<string, unknown> | null {
  const open = expr.indexOf('{');
  if (open === -1) return null;
  const inner = readArgsBrace(expr, open);
  if (inner == null) return null;
  const obj: Record<string, unknown> = {};
  // entries: 'key': value   (skip spread/if by still capturing the key)
  const entryRe = /'([^']+)'\s*:\s*([^,]+?)(?:,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(inner)) !== null) {
    obj[m[1]] = inferLiteral(m[2].trim(), m[1]);
  }
  return Object.keys(obj).length ? obj : {};
}

/** Read a balanced `{...}` returning its inner text. */
function readArgsBrace(s: string, openIdx: number): string | null {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
    if (c === "'" || c === '"' || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
  }
  return null;
}

/** Infer a JSON value from a Dart value expression (literal or by key name). */
function inferLiteral(expr: string, key: string): unknown {
  const e = expr.trim();
  if (/^-?\d+$/.test(e)) return Number(e);
  if (/^-?\d+\.\d+$/.test(e)) return Number(e);
  if (e === 'true' || e === 'false') return e === 'true';
  if (/^'[^']*'$/.test(e) || /^"[^"]*"$/.test(e)) return e.slice(1, -1);
  if (e.startsWith('[')) return [];
  // identifier / call → sample by key name
  const k = key.toLowerCase();
  if (/(id|count|skip|take|page|length|number|qty)/.test(k)) return 1;
  if (/(is|has|active|enable)/.test(k)) return true;
  return 'string';
}

export async function buildApiCatalog(scan: ScanResult): Promise<ApiCatalog> {
  const contents = await readAll(scan);
  const featureByRel = new Map(scan.files.map((f) => [f.relPath, f.feature]));
  return extractCatalog(contents, featureByRel);
}

/** Pure extraction over already-read file contents (testable without fs). */
export function extractCatalog(
  contents: Map<string, string>,
  featureByRel: Map<string, string | undefined> = new Map(),
): ApiCatalog {
  const registry: Registry = buildModelRegistry(contents);
  const endpointConsts = parseEndpointConsts(contents);

  const endpoints: ApiEndpoint[] = [];
  const seen = new Set<string>();

  /** Resolve a path expression (first Dio arg) to a route + whether it's exact. */
  function resolvePath(expr: string, content: string): { path: string; exact: boolean } {
    const e = expr.trim();
    const str = /^(['"`])([\s\S]*?)\1/.exec(e);
    if (str) return { path: normalizePath(str[2]), exact: true };
    // XEndpoints.method(...)
    const call = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/.exec(e);
    if (call) {
      const tmpl = endpointConsts.get(`${call[1]}.${call[2]}`);
      if (tmpl) return { path: normalizePath(tmpl), exact: true };
      return { path: `${call[1]}.${call[2]}()`, exact: false };
    }
    // local identifier → static const / final assignment in the same file
    const id = /^_?[A-Za-z_]\w*$/.exec(e);
    if (id) {
      const local = new RegExp(
        '(?:static\\s+const|const|final)\\s+' + e.replace(/[$]/g, '\\$') + "\\s*=\\s*'([^']+)'",
      ).exec(content);
      if (local) return { path: normalizePath(local[1]), exact: true };
      return { path: e, exact: false };
    }
    return { path: e.slice(0, 60), exact: false };
  }

  for (const [rel, content] of contents) {
    if (!/\.(get|post|put|patch|delete)\s*</.test(content) && !/\.(get|post|put|patch|delete)\s*\(/.test(content)) continue;

    // Precompute method-signature + class positions for nearest-preceding lookup.
    const methods: { idx: number; type: string; isList: boolean }[] = [];
    METHOD_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = METHOD_RE.exec(content)) !== null) {
      methods.push({ idx: mm.index, type: mm[2], isList: !!mm[1] });
    }
    const classes: { idx: number; name: string }[] = [];
    CLASS_RE.lastIndex = 0;
    let clm: RegExpExecArray | null;
    while ((clm = CLASS_RE.exec(content)) !== null) classes.push({ idx: clm.index, name: clm[1] });

    const nearest = <T extends { idx: number }>(arr: T[], pos: number): T | null => {
      let best: T | null = null;
      for (const a of arr) { if (a.idx < pos) best = a; else break; }
      return best;
    };

    CALL_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CALL_RE.exec(content)) !== null) {
      const verb = cm[2];
      const openParen = CALL_RE.lastIndex - 1; // CALL_RE ends just after '('
      const { args } = readArgs(content, openParen);
      const parts = splitTopArgs(args);
      if (!parts.length) continue;
      const pathExpr = parts[0].trim();
      // Skip obvious non-HTTP first args (must be a string, Endpoints call, or id).
      if (!/^(['"`]|[A-Za-z_]\w*\.[A-Za-z_]\w*\s*\(|_?[A-Za-z_]\w*$)/.test(pathExpr)) continue;

      const callStart = cm.index;
      const { path, exact } = resolvePath(pathExpr, content);
      if (!path || path.length > 120) continue;

      const method = verb.toUpperCase();
      const id = `${method} ${path}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const ep: ApiEndpoint = { id, method, path, fromFileRel: rel };
      const feat = featureByRel.get(rel);
      if (feat) ep.feature = feat;
      const svc = nearest(classes, callStart);
      if (svc) ep.service = svc.name;
      if (!exact) ep.partial = true;

      // --- Response: enclosing Future<T> ---
      const meth = nearest(methods, callStart);
      if (meth && meth.type !== 'void' && meth.type !== 'Response') {
        ep.responseType = meth.type;
        ep.responseIsList = meth.isList;
        const mock = mockForClass(meth.type, registry);
        ep.mockResponse = meth.isList ? [mock.value] : mock.value;
        if (mock.partial) ep.partial = true;
      } else {
        ep.mockResponse = {}; // void / fire-and-forget → empty 200
      }

      // --- Request body (data:) + query (queryParameters:) ---
      const dataExpr = namedArg(parts, 'data');
      if (dataExpr) {
        const toJson = /^([A-Za-z_]\w*)(?:\([^)]*\))?\.toJson\s*\(/.exec(dataExpr);
        if (/^Stream\s*</.test(dataExpr)) {
          ep.mockRequest = '<binary upload>';
        } else if (/^const\s*<[^>]*>\s*\{\s*\}|^\{\s*\}/.test(dataExpr)) {
          ep.mockRequest = {};
        } else if (dataExpr.startsWith('[')) {
          ep.mockRequest = [{ op: 'replace', path: '/Field', value: 1 }]; // JSON Patch
        } else if (toJson) {
          // Resolve the receiver to a model class: inline X(...).toJson(), or a
          // local `final body = XModel(...)`, else the var name capitalized.
          let cls: string | null = /^[A-Z]/.test(toJson[1]) ? toJson[1] : null;
          if (!cls) {
            const methStart = meth ? meth.idx : 0;
            const region = content.slice(methStart, callStart);
            const asn = new RegExp(
              '(?:final|var|const)\\s+' + toJson[1] + '\\s*=\\s*([A-Z]\\w*)\\s*\\(',
            ).exec(region);
            if (asn) cls = asn[1];
          }
          if (cls && registry.models.has(cls)) {
            const r = mockForClass(cls, registry);
            ep.requestType = cls;
            ep.mockRequest = r.value;
            if (r.partial) ep.partial = true;
          } else {
            if (cls) ep.requestType = cls;
            ep.mockRequest = {};
            ep.partial = true;
          }
        } else if (dataExpr.startsWith('{')) {
          ep.mockRequest = mockFromMapLiteral(dataExpr) ?? {};
        } else {
          ep.mockRequest = {};
          ep.partial = true;
        }
      }

      const queryExpr = namedArg(parts, 'queryParameters');
      if (queryExpr && queryExpr.includes('{')) {
        const q = mockFromMapLiteral(queryExpr);
        if (q && Object.keys(q).length) ep.mockQuery = q;
      }

      endpoints.push(ep);
      if (endpoints.length >= 3000) break;
    }
    if (endpoints.length >= 3000) break;
  }

  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const stats: Record<string, number> = { total: endpoints.length };
  for (const e of endpoints) stats[e.method] = (stats[e.method] ?? 0) + 1;

  return { generatedAt: new Date().toISOString(), endpoints, stats };
}
