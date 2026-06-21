// api.ts — Detect API/service usage: repositories, data sources, services, and
// direct HTTP calls (dio / http).
//
// Two outputs feed ApiEdge[]:
//   1. References to a project-declared class named *Repository / *DataSource /
//      *Service from a *different* file (kind: 'service' or 'datasource').
//   2. Direct HTTP call sites: dio.get/post/..., http.get/post/... (kind:'http').

import type { ApiEdge, ScannedFile } from '../types.js';

// Class declarations for the API-ish types.
const API_CLASS_RE =
  /\bclass\s+([A-Z]\w*(?:Repository|RepositoryImpl|DataSource|DataSourceImpl|Service|ServiceImpl))\b/g;

// Abstract interface declarations (Dart 3 `abstract interface class`).
const API_ABSTRACT_RE =
  /\babstract\s+(?:interface\s+)?class\s+([A-Z]\w*(?:Repository|DataSource|Service))\b/g;

// Direct HTTP call sites. Capture the receiver + verb.
const HTTP_CALL_RE =
  /\b(_?\w*(?:dio|Dio|http|client|Client))\s*\.\s*(get|post|put|delete|patch|getUri|postUri|request)\b/g;

/** Classify a class name into a service/datasource kind. */
function kindForClass(name: string): 'service' | 'datasource' {
  return /DataSource/.test(name) ? 'datasource' : 'service';
}

/** A class name an api parser discovered (declaration). */
export interface ApiClassDecl {
  className: string;
  fileRel: string;
  kind: 'service' | 'datasource';
}

/** Extract API class declarations from a file. */
export function parseApiClasses(file: ScannedFile, content: string): ApiClassDecl[] {
  const decls: ApiClassDecl[] = [];
  const seen = new Set<string>();

  for (const re of [API_CLASS_RE, API_ABSTRACT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      decls.push({ className: name, fileRel: file.relPath, kind: kindForClass(name) });
    }
  }
  return decls;
}

/**
 * Build ApiEdges.
 *
 * - For each file, find references to API class names declared elsewhere
 *   (token followed by an identifier-ish boundary; we reuse the constructor /
 *   type-usage heuristic). Skip self-references.
 * - Also scan every file for direct HTTP call sites and emit kind:'http' edges
 *   labelled with the receiver.verb.
 */
export function resolveApi(
  contents: Map<string, string>,
  apiClasses: ApiClassDecl[],
): ApiEdge[] {
  // class name -> declaring info (collapse impl/interface by name).
  const declByName = new Map<string, ApiClassDecl>();
  for (const d of apiClasses) {
    if (!declByName.has(d.className)) declByName.set(d.className, d);
  }

  const edges: ApiEdge[] = [];
  const seen = new Set<string>();

  for (const [fromFileRel, content] of contents) {
    // 1. References to API classes declared in other files.
    const tokenRe = /\b([A-Z]\w*(?:Repository|DataSource|Service)(?:Impl)?)\b/g;
    const used = new Set<string>();
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(content)) !== null) used.add(tm[1]);

    for (const cls of used) {
      const decl = declByName.get(cls);
      if (!decl) continue;
      if (decl.fileRel === fromFileRel) continue; // self
      const key = `${fromFileRel} ${cls}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromFileRel, target: cls, kind: decl.kind });
    }

    // 2. Direct HTTP call sites.
    HTTP_CALL_RE.lastIndex = 0;
    let hm: RegExpExecArray | null;
    const httpSeen = new Set<string>();
    while ((hm = HTTP_CALL_RE.exec(content)) !== null) {
      const label = `${hm[1]}.${hm[2]}`;
      if (httpSeen.has(label)) continue;
      httpSeen.add(label);
      edges.push({ fromFileRel, target: label, kind: 'http' });
    }
  }

  return edges;
}
