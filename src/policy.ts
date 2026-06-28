// policy.ts — Custom architecture policy from `.pagemapper.json`.
//
// Turns the fixed built-in rules into an extensible, per-project policy engine
// (dependency-cruiser style). A project drops a `.pagemapper.json` in its root:
//
//   {
//     "forbidden": [
//       { "name": "auth must not touch billing",
//         "from": "feature:auth", "to": "feature:billing" },
//       { "from": "path:**/legacy/**", "to": "*", "severity": "medium" }
//     ]
//   }
//
// Each forbidden rule flags every import edge whose SOURCE node matches `from`
// and TARGET node matches `to`. Selectors: package:NAME | pkg:NAME |
// feature:NAME | feat:NAME | layer:NAME | path:GLOB | <bare glob on relPath> |
// "*" (any).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  GraphData,
  GraphNode,
  Insight,
  PolicyConfig,
  Severity,
} from './types.js';

/** Load `.pagemapper.json` from the project root. null when absent or invalid. */
export async function loadPolicy(projectRoot: string): Promise<PolicyConfig | null> {
  const file = path.join(projectRoot, '.pagemapper.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null; // no config — feature is a no-op
  }
  try {
    const cfg = JSON.parse(raw) as PolicyConfig;
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch (err) {
    console.error(`  ⚠ .pagemapper.json is not valid JSON — ignoring (${(err as Error).message})`);
    return null;
  }
}

/** Compile a selector string into a node predicate. */
function compileSelector(sel: string): (n: GraphNode) => boolean {
  const s = (sel ?? '').trim();
  if (s === '*' || s === '') return () => true;
  const colon = s.indexOf(':');
  const kind = colon === -1 ? '' : s.slice(0, colon).toLowerCase();
  const val = colon === -1 ? s : s.slice(colon + 1);
  switch (kind) {
    case 'package':
    case 'pkg':
      return (n) => n.package === val;
    case 'feature':
    case 'feat':
      return (n) => n.feature === val;
    case 'layer':
      return (n) => n.layer === val;
    case 'path': {
      const re = globToRe(val);
      return (n) => re.test(n.path);
    }
    default: {
      // No recognized prefix → treat the whole string as a glob on relPath.
      const re = globToRe(s);
      return (n) => re.test(n.path);
    }
  }
}

/** Minimal glob → RegExp. `**` = any chars incl `/`; `*` = any except `/`. */
function globToRe(glob: string): RegExp {
  const SPECIAL = '.+^${}()|[]\\';
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++; // consume the second '*'
        if (glob[i + 1] === '/') {
          // `**/` = zero or more WHOLE path segments (each ending in '/'), so it
          // matches at segment boundaries — `**/legacy/**` must not match
          // `…/xlegacy/…`.
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*'; // bare `**` = anything, including '/'
        }
      } else {
        re += '[^/]*'; // single `*` stays within one segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (SPECIAL.indexOf(c) !== -1) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function short(p: string): string {
  const parts = p.split('/');
  return parts.length <= 4 ? p : '…/' + parts.slice(-3).join('/');
}

/** Evaluate forbidden-dependency rules against the graph's import edges. */
export function evaluatePolicy(graph: GraphData, cfg: PolicyConfig): Insight[] {
  const rules = cfg.forbidden ?? [];
  if (!rules.length) return [];

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const compiled = rules.map((r) => ({
    rule: r,
    matchFrom: compileSelector(r.from),
    matchTo: compileSelector(r.to),
  }));

  const items: Insight[] = [];
  for (const e of graph.edges) {
    if (e.type !== 'import') continue;
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) continue;
    for (const c of compiled) {
      if (!c.matchFrom(src) || !c.matchTo(dst)) continue;
      const ruleKey = c.rule.name || `${c.rule.from}>${c.rule.to}`;
      const title = c.rule.name || `${c.rule.from} ✗→ ${c.rule.to}`;
      items.push({
        id: `policy:${ruleKey}:${e.id}`,
        severity: (c.rule.severity as Severity) || 'high',
        title,
        detail:
          `${short(src.path)} (matches "${c.rule.from}") imports ${short(dst.path)} ` +
          `(matches "${c.rule.to}") — forbidden by policy${c.rule.name ? ` rule "${c.rule.name}"` : ''}.`,
        nodes: [src.id, dst.id],
        edges: [e.id],
      });
    }
  }
  items.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return items;
}
