// mock-gen.ts — Deterministic mock JSON from Dart model classes.
//
// Same spirit as preview.ts (a deterministic Flutter widget-tree → HTML
// renderer): no network, no real data, no LLM. Given a registry of model
// classes + enums (parsed from the project's Dart source) we synthesize a
// representative JSON value for any Dart type, so the API Catalog can show a
// request/response shape a human can read instead of tracing fromJson/toJson.
//
// This file is the GENERIC type → value generator. The registry is populated by
// src/parser/models.ts (whose regexes track the project's model style).

/** One field of a model class. */
export interface ModelField {
  /** Dart field name. */
  name: string;
  /** Key as it appears in JSON (after @JsonKey rename); defaults to `name`. */
  jsonKey: string;
  /** Dart type as written, e.g. "String", "List<UserModel>", "int?". */
  type: string;
}

/** Parsed project models + enums for mock generation. */
export interface Registry {
  /** className → fields. */
  models: Map<string, ModelField[]>;
  /** enum name → the wire int value of its first variant (enums serialize as ints). */
  enums: Map<string, number>;
}

const MAX_DEPTH = 6; // guard against deep / recursive model graphs

/** Strip a trailing `?` (nullability) + whitespace. */
function bareType(type: string): string {
  return type.trim().replace(/\?+$/, '').trim();
}

/** Inner type of a generic: List<Foo> → "Foo", Map<a,b> → "a,b". */
function generic(type: string): string | null {
  const lt = type.indexOf('<');
  if (lt === -1 || !type.endsWith('>')) return null;
  return type.slice(lt + 1, -1);
}

/** Split a top-level comma list, respecting nested generics (a, Map<b,c>). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** A readable string sample, biased by the field name. */
function stringSample(hint: string): string {
  const h = hint.toLowerCase();
  if (/email/.test(h)) return 'user@example.com';
  if (/url|uri|link|image|photo|avatar/.test(h)) return 'https://example.com/image.png';
  if (/(date|time|_at$|createdat|updatedat)/.test(h)) return '2026-01-01T00:00:00.000Z';
  if (/phone|mobile|tel/.test(h)) return '+66800000000';
  if (/uuid|guid/.test(h)) return 'a1b2c3d4-0000-4000-8000-000000000000';
  if (/(^id$|_id$|code)/.test(h)) return 'ID_1';
  if (/name|title|label|subject/.test(h)) return hint ? 'Sample ' + hint : 'Sample';
  if (/status|state|type/.test(h)) return 'active';
  if (/color/.test(h)) return '#116dfc';
  return hint ? 'sample_' + hint : 'string';
}

/**
 * Synthesize a JSON-able mock value for a Dart `type`. `hint` is the field name
 * (improves string samples). `seen` guards model cycles. Returns
 * `{ value, partial }` — partial=true when a custom type wasn't in the registry.
 */
export function mockValue(
  type: string,
  reg: Registry,
  hint = '',
  seen: Set<string> = new Set(),
  depth = 0,
): { value: unknown; partial: boolean } {
  const t = bareType(type);
  const lower = t.toLowerCase();

  if (t === 'String') return { value: stringSample(hint), partial: false };
  if (t === 'int')
    return { value: /(^id$|_id$|count|qty|quantity|number|index|age|skip|take|page)/.test(hint.toLowerCase()) ? 1 : 0, partial: false };
  if (t === 'double') return { value: 1.5, partial: false };
  if (t === 'num') return { value: 1, partial: false };
  if (t === 'bool')
    return { value: /(^is|^has|^can|enabled|active|visible|favorite)/.test(hint.toLowerCase()), partial: false };
  if (t === 'DateTime') return { value: '2026-01-01T00:00:00.000Z', partial: false };
  if (t === 'dynamic' || t === 'Object' || t === 'var' || t === '') return { value: null, partial: false };

  if (lower.startsWith('list<') || lower.startsWith('iterable<') || lower.startsWith('set<')) {
    const inner = generic(t);
    if (!inner) return { value: [], partial: false };
    const el = mockValue(inner.trim(), reg, hint, seen, depth + 1);
    return { value: [el.value], partial: el.partial };
  }
  if (lower.startsWith('map<')) {
    const inner = generic(t);
    if (!inner) return { value: {}, partial: false };
    const parts = splitTop(inner);
    const v = mockValue((parts[1] ?? 'dynamic').trim(), reg, hint, seen, depth + 1);
    return { value: { key: v.value }, partial: v.partial };
  }

  // Custom model → recurse.
  const fields = reg.models.get(t);
  if (fields) {
    if (depth >= MAX_DEPTH || seen.has(t)) return { value: {}, partial: false };
    const nextSeen = new Set(seen);
    nextSeen.add(t);
    let partial = false;
    const obj: Record<string, unknown> = {};
    for (const f of fields) {
      const r = mockValue(f.type, reg, f.name, nextSeen, depth + 1);
      obj[f.jsonKey] = r.value;
      if (r.partial) partial = true;
    }
    return { value: obj, partial };
  }

  // Enum → its first variant's int wire value.
  if (reg.enums.has(t)) return { value: reg.enums.get(t), partial: false };

  // Unknown capitalized type (model we couldn't parse / external) → placeholder.
  if (/^[A-Z]\w*$/.test(t)) return { value: hint ? stringSample(hint) : t.toLowerCase(), partial: true };
  return { value: null, partial: true };
}

/** Build a mock object for a top-level model class name. */
export function mockForClass(className: string, reg: Registry): { value: unknown; partial: boolean } {
  return mockValue(className, reg, '', new Set(), 0);
}
