// models.ts — Parse Dart model classes + enums into a mock-gen Registry.
//
// Tracks venio's dominant styles (surveyed):
//   - @freezed abstract class X with _$X { const factory X({ @JsonKey(name:'K')
//     Type field, required Type f2, @Default(v) Type f3 }) = _X; }   ← dominant
//   - plain class X { ...; final Type name; ... factory X.fromJson(...) }
//   - enum E { variant(1), other(2); }                               ← int wire value
//
// Generated files (.g.dart / .freezed.dart) are never scanned (the scanner
// already excludes them). Regex, not a Dart AST — best-effort but covers the
// shapes that matter for a readable mock.

import type { ModelField, Registry } from '../mock-gen.js';

/** A freezed factory param, e.g. `@JsonKey(name: 'Id') int? id`. Captures an
 *  optional @JsonKey name, an optional @Default(...), an optional `required`,
 *  then `Type name`. */
const FREEZED_PARAM_RE =
  /(?:@JsonKey\([^)]*?name:\s*'([^']+)'[^)]*\)\s*)?(?:@Default\((?:[^()]|\([^)]*\))*\)\s*)?(?:required\s+)?([A-Za-z_][\w.]*(?:<[^>;]+>)?\??)\s+([a-z_]\w*)\s*$/;

/** Split a brace/paren/bracket-balanced comma list (top level only). */
function splitParams(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Parse one freezed factory param line → field, or null if it isn't one. */
function parseParam(raw: string): ModelField | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const m = FREEZED_PARAM_RE.exec(cleaned);
  if (!m) return null;
  const name = m[3];
  const type = m[2];
  if (!name || !type) return null;
  return { name, jsonKey: m[1] || name, type };
}

/** Extract fields from a freezed `const factory X({ ... }) = _X;` block. */
function freezedFields(content: string, fromIndex: number): ModelField[] | null {
  // factory <Name>( { <params> } ) = _<Name>;
  const re = /(?:const\s+)?factory\s+\w+\s*\(\s*\{([\s\S]*?)\}\s*\)\s*=\s*_/g;
  re.lastIndex = fromIndex;
  const m = re.exec(content);
  if (!m) return null;
  const fields: ModelField[] = [];
  for (const p of splitParams(m[1])) {
    const f = parseParam(p);
    if (f) fields.push(f);
  }
  return fields.length ? fields : null;
}

/** Field declarations inside a plain class body: `final Type name;`. */
const FINAL_FIELD_RE = /\bfinal\s+([A-Za-z_][\w.]*(?:<[^>;]+>)?\??)\s+([a-z_]\w*)\s*;/g;

/** Extract the `{ ... }` body of a class starting near `classIndex`. */
function classBody(content: string, openBraceIndex: number): string {
  let depth = 0;
  let i = openBraceIndex;
  const start = i + 1;
  for (; i < content.length; i++) {
    const c = content[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return content.slice(start, i);
    }
  }
  return content.slice(start);
}

/** Build a mock-gen Registry from the project's file contents. */
export function buildModelRegistry(contents: Map<string, string>): Registry {
  const models = new Map<string, ModelField[]>();
  const enums = new Map<string, number>();

  for (const content of contents.values()) {
    // --- Enums: first variant's int wire value (E { a(1), b(2); }) ---
    const enumRe = /\benum\s+([A-Z]\w*)\s*\{([\s\S]*?)\}/g;
    let em: RegExpExecArray | null;
    while ((em = enumRe.exec(content)) !== null) {
      if (enums.has(em[1])) continue;
      const vm = /\b\w+\s*\(\s*(?:value:\s*)?(\d+)/.exec(em[2]);
      enums.set(em[1], vm ? Number(vm[1]) : 0);
    }

    // --- Classes (freezed factory first, then plain `final` fields) ---
    const classRe = /\b(?:abstract\s+(?:interface\s+)?)?class\s+([A-Z]\w*)\b/g;
    let cm: RegExpExecArray | null;
    while ((cm = classRe.exec(content)) !== null) {
      const name = cm[1];
      if (models.has(name) || name.startsWith('_')) continue;

      // Prefer a freezed factory near this class declaration.
      const fz = freezedFields(content, cm.index);
      if (fz) {
        models.set(name, fz);
        continue;
      }

      // Otherwise, if it's a model (has fromJson), parse plain `final` fields.
      const brace = content.indexOf('{', cm.index);
      if (brace === -1) continue;
      const body = classBody(content, brace);
      if (!/\.fromJson\s*\(|fromJson\s*\(/.test(body) && !/\bfinal\s/.test(body)) continue;
      const fields: ModelField[] = [];
      const seen = new Set<string>();
      FINAL_FIELD_RE.lastIndex = 0;
      let fm: RegExpExecArray | null;
      while ((fm = FINAL_FIELD_RE.exec(body)) !== null) {
        if (seen.has(fm[2])) continue;
        seen.add(fm[2]);
        fields.push({ name: fm[2], jsonKey: fm[2], type: fm[1] });
      }
      if (fields.length) models.set(name, fields);
    }
  }

  return { models, enums };
}
