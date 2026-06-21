// preview.ts — Deterministic Flutter-widget-tree → HTML mockup.
//
// Flutter widgets can't be rendered faithfully from static source (that needs
// the running app + its state/deps). Instead we read the widget tree in the
// page's build() method and map known widgets to HTML, producing an honest
// structural wireframe ("โครงหน้า") of the screen. No LLM, no network, no key.
//
// The renderer is synchronous and pure: same source in → same HTML out. It
// never throws — on a parse failure it returns a valid HTML document carrying
// a friendly message instead.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Optional project knowledge that lets the renderer resolve the app's *own*
 * custom widgets, theme colors and localization keys — turning generic boxes
 * into faithful component shapes. All three lookups are pure (no fs/network
 * here) and may return null when nothing is known. When no context is supplied
 * the renderer behaves exactly as it does without it.
 */
export interface PreviewContext {
  /** Returns the Dart source of `class <name>` found somewhere in the project, or null. */
  resolveClass(name: string): string | null;
  /** Returns a CSS hex color for a token member name (e.g. "primary" -> "#116DFC"), or null. */
  colorToken(name: string): string | null;
  /** Resolve a localization key (e.g. "auth.login.sign_in") to display text, or null. */
  localize(key: string): string | null;
}

/** How deep we follow custom-widget `build()` trees before falling back. */
const MAX_RESOLVE_DEPTH = 6;

/** Per-render state threaded through the node walk (ctx + recursion guards). */
type RenderState = {
  ctx?: PreviewContext;
  /** Custom-widget class names on the current resolution path (cycle guard). */
  resolving: Set<string>;
  /** Current custom-widget resolution depth (separate from layout nesting). */
  depth: number;
};

/** Render a self-contained HTML mockup document from a Flutter page's Dart source. */
export function renderPreview(relPath: string, dartCode: string, ctx?: PreviewContext): string {
  try {
    const bodies = locateBuildBodies(dartCode);
    if (bodies.length === 0) {
      return errorDoc(relPath, "couldn't find a build() method to render");
    }
    const state: RenderState = { ctx, resolving: new Set(), depth: 0 };
    // Parse + render each candidate; keep the first (preference order) unless
    // it carries no recognizable content (e.g. a *Page that only wraps a
    // private `_View` widget) — then fall back to the richest sibling build.
    let chosen: { html: string; score: number } | null = null;
    for (const body of bodies) {
      const tree = parseWidget(body);
      if (!tree) continue;
      const html = renderNode(tree, state);
      const score = contentScore(tree);
      if (chosen === null) {
        chosen = { html, score };
        if (score > 0) break; // preferred build has real content — use it
      } else if (score > chosen.score) {
        chosen = { html, score };
      }
    }
    if (!chosen) return errorDoc(relPath, "couldn't parse the widget tree");
    return doc(relPath, `<div class="screen">${chosen.html}</div>`);
  } catch {
    // Defensive: the renderer must never crash the caller.
    return errorDoc(relPath, "couldn't parse the widget tree");
  }
}

// ---------------------------------------------------------------------------
// AST node model
// ---------------------------------------------------------------------------

type Arg = { name?: string; value: Node };

type WidgetNode = {
  kind: 'widget';
  name: string;
  args: Arg[];
};
type StringNode = { kind: 'string'; value: string };
type ListNode = { kind: 'list'; items: Node[] };
/** Anything we don't model: identifiers, method calls, ternaries, etc. */
type OpaqueNode = { kind: 'opaque'; text: string };

type Node = WidgetNode | StringNode | ListNode | OpaqueNode;

// ---------------------------------------------------------------------------
// Step 1: locate the build() body
// ---------------------------------------------------------------------------

/**
 * Find the widget expressions returned by build() methods, in preference order:
 * the *Page class's build first (if any), then every build() in the file. The
 * caller renders the first that yields real content, so a *Page that merely
 * wraps a private view falls back to the richer sibling build automatically.
 */
function locateBuildBodies(code: string): string[] {
  const stripped = stripComments(code);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (expr: string | null) => {
    if (expr && !seen.has(expr)) {
      seen.add(expr);
      out.push(expr);
    }
  };

  const pageClass = findPageClassRange(stripped);
  if (pageClass) add(buildExprIn(pageClass));
  for (const expr of allBuildExprs(stripped)) add(expr);
  return out;
}

/** Return the source of the first class whose name ends in `Page`, or null. */
function findPageClassRange(code: string): string | null {
  const re = /class\s+(\w*Page)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    // Find the class body opening brace after the match.
    const braceStart = code.indexOf('{', m.index);
    if (braceStart < 0) continue;
    const end = matchBrace(code, braceStart);
    if (end < 0) continue;
    return code.slice(braceStart + 1, end);
  }
  return null;
}

/** Find the first build() method in `code` and return its widget expression. */
function buildExprIn(code: string): string | null {
  return allBuildExprs(code)[0] ?? null;
}

/** Return the widget expression of every build() method found in `code`. */
function allBuildExprs(code: string): string[] {
  // Match `Widget build(BuildContext ...)` then either `=> expr;` or `{ ... }`.
  const re = /Widget\s+build\s*\(/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    // Skip the parameter list.
    const parenStart = code.indexOf('(', m.index);
    const parenEnd = matchParen(code, parenStart);
    if (parenEnd < 0) continue;

    let i = parenEnd + 1;
    while (i < code.length && /\s/.test(code[i])) i++;

    if (code[i] === '=' && code[i + 1] === '>') {
      // Arrow body: => <expr> ;
      const exprStart = i + 2;
      const exprEnd = findStatementEnd(code, exprStart);
      const expr = code.slice(exprStart, exprEnd).trim();
      if (expr) out.push(expr);
    } else if (code[i] === '{') {
      // Block body: take the final top-level `return <expr>;`.
      const bodyEnd = matchBrace(code, i);
      if (bodyEnd < 0) continue;
      const body = code.slice(i + 1, bodyEnd);
      const ret = lastTopLevelReturn(body);
      if (ret) out.push(ret);
    }
  }
  return out;
}

/** Extract the expression of the last top-level `return ...;` in a block body. */
function lastTopLevelReturn(body: string): string | null {
  let found: string | null = null;
  const re = /\breturn\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (depthAt(body, m.index) !== 0) continue; // only top-level returns
    const exprStart = m.index + 'return'.length;
    const exprEnd = findStatementEnd(body, exprStart);
    const expr = body.slice(exprStart, exprEnd).trim();
    if (expr) found = expr;
  }
  return found;
}

/** Bracket/brace/paren nesting depth at a given index (string-aware). */
function depthAt(code: string, index: number): number {
  let depth = 0;
  let i = 0;
  while (i < index && i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      i = skipString(code, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    i++;
  }
  return depth;
}

/** Find the index just past the `;` that ends a top-level expression statement. */
function findStatementEnd(code: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      i = skipString(code, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) return i;
    i++;
  }
  return code.length;
}

// ---------------------------------------------------------------------------
// Step 2: tokenize + parse a widget expression into a Node tree
// ---------------------------------------------------------------------------

/**
 * Parse a single Dart expression into a Node. Recognizes widget-constructor
 * calls, string literals and list literals; everything else becomes opaque.
 */
function parseWidget(src: string): Node | null {
  const text = src.trim();
  if (!text) return null;
  return parseExpr(text);
}

function parseExpr(raw: string): Node {
  let text = raw.trim();
  // Drop leading `const`/`new` keywords that prefix a constructor call.
  text = text.replace(/^(?:const|new)\s+/, '');

  // Builder closure: `(params) => <widget>` or `(params) { ... return W; }`.
  // Common with BlocBuilder/Consumer/Builder — unwrap to the produced widget.
  const closure = unwrapClosure(text);
  if (closure !== null) return parseExpr(closure);

  // String literal?
  if (text[0] === '"' || text[0] === "'") {
    const end = skipString(text, 0);
    if (end >= text.length) {
      return { kind: 'string', value: unquote(text) };
    }
    // String followed by more (e.g. interpolation/concat) → opaque.
    return { kind: 'opaque', text };
  }

  // List literal?
  if (text[0] === '[') {
    const end = matchBracket(text, 0);
    if (end === text.length - 1) {
      return { kind: 'list', items: splitArgs(text.slice(1, end)).map((a) => parseExpr(a.raw)) };
    }
    return { kind: 'opaque', text };
  }

  // Widget-constructor call?  Identifier (optionally Foo.bar), optional generic
  // type args `<...>` (e.g. BlocBuilder<A, B>), then `( ... )`.
  const idMatch = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*/.exec(text);
  if (idMatch) {
    const name = idMatch[1];
    let parenStart = idMatch[0].length;
    if (text[parenStart] === '<') {
      const generic = matchAngle(text, parenStart);
      if (generic > 0) {
        parenStart = generic + 1;
        while (parenStart < text.length && /\s/.test(text[parenStart])) parenStart++;
      }
    }
    if (text[parenStart] === '(') {
      const parenEnd = matchParen(text, parenStart);
      if (parenEnd === text.length - 1 && isWidgetName(name)) {
        // Capitalized (incl. private `_Foo`) → treat as a widget/class constructor.
        const args = splitArgs(text.slice(parenStart + 1, parenEnd)).map(toArg);
        return { kind: 'widget', name, args };
      }
    }
  }

  return { kind: 'opaque', text };
}

/**
 * If `text` is an anonymous function `(params) => body` or `(params) { ... }`,
 * return the produced widget expression (arrow body, or the last top-level
 * `return`). Returns null when it isn't a closure. Used to see through builder
 * callbacks like `builder: (context, state) => SomeWidget(...)`.
 */
function unwrapClosure(text: string): string | null {
  if (text[0] !== '(') return null;
  const parenEnd = matchParen(text, 0);
  if (parenEnd < 0) return null;
  let i = parenEnd + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === '=' && text[i + 1] === '>') {
    const body = text.slice(i + 2).trim();
    return body || null;
  }
  if (text[i] === '{') {
    const braceEnd = matchBrace(text, i);
    if (braceEnd < 0) return null;
    return lastTopLevelReturn(text.slice(i + 1, braceEnd));
  }
  return null;
}

/**
 * Is this identifier a widget/class constructor? Widgets are UpperCamelCase,
 * including private ones (`_LoginView`) and named constructors (`Image.asset`).
 * Excludes lowercase calls like `context.read<T>()` or `setState`.
 */
function isWidgetName(name: string): boolean {
  const head = name.split('.')[0];
  return /^_?[A-Z]/.test(head);
}

/** Turn a raw argument slice into an Arg (handling `name: value`). */
function toArg(a: { raw: string }): Arg {
  const raw = a.raw.trim();
  const colon = topLevelColon(raw);
  if (colon >= 0) {
    const name = raw.slice(0, colon).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) {
      return { name, value: parseExpr(raw.slice(colon + 1)) };
    }
  }
  return { value: parseExpr(raw) };
}

/** Index of the first top-level `:` (named-arg separator), or -1. */
function topLevelColon(code: string): number {
  let depth = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      i = skipString(code, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0) return i;
    i++;
  }
  return -1;
}

/** Split a comma-separated arg list (string/bracket-aware), trimming empties. */
function splitArgs(code: string): { raw: string }[] {
  const out: { raw: string }[] = [];
  let depth = 0; // (), [], {}
  let angle = 0; // <> generic type args
  let start = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      i = skipString(code, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    // Track generic angle brackets so `Foo<A, B>(...)` doesn't split mid-type.
    // `<` opens only after an identifier char (avoids `a < b`); `=>` is skipped.
    else if (ch === '<' && /[\w$>]/.test(code[i - 1] ?? '')) angle++;
    else if (ch === '>' && angle > 0 && code[i - 1] !== '=') angle--;
    else if (ch === ',' && depth === 0 && angle === 0) {
      const raw = code.slice(start, i).trim();
      if (raw) out.push({ raw });
      start = i + 1;
    }
    i++;
  }
  const tail = code.slice(start).trim();
  if (tail) out.push({ raw: tail });
  return out;
}

// ---------------------------------------------------------------------------
// Low-level scanners (string-aware bracket matching)
// ---------------------------------------------------------------------------

/** Given an index at a quote char, return the index just past the string. */
function skipString(code: string, i: number): number {
  const quote = code[i];
  // Triple-quoted string?
  if (code[i + 1] === quote && code[i + 2] === quote) {
    const close = code.indexOf(quote + quote + quote, i + 3);
    return close < 0 ? code.length : close + 3;
  }
  let j = i + 1;
  while (j < code.length) {
    if (code[j] === '\\') {
      j += 2;
      continue;
    }
    if (code[j] === quote) return j + 1;
    j++;
  }
  return code.length;
}

function matchPair(code: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      i = skipString(code, i);
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Match a balanced `<...>` generic-type block; returns the closing index or -1. */
function matchAngle(code: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '<') depth++;
    else if (ch === '>') {
      depth--;
      if (depth === 0) return i;
    } else if (ch === '(' || ch === ')' || ch === ';' || ch === '{' || ch === '}') {
      // Not a generic block (likely a comparison) — bail.
      return -1;
    }
    i++;
  }
  return -1;
}

const matchParen = (code: string, open: number) => matchPair(code, open, '(', ')');
const matchBracket = (code: string, open: number) => matchPair(code, open, '[', ']');
const matchBrace = (code: string, open: number) => matchPair(code, open, '{', '}');

/** Remove `//` line comments and block comments, preserving string contents. */
function stripComments(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const end = skipString(code, i);
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      i = close < 0 ? code.length : close + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Strip surrounding quotes from a string literal (best-effort). */
function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith("'''") || t.startsWith('"""')) return t.slice(3, -3);
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'")) return t.slice(1, -1);
  return t;
}

// ---------------------------------------------------------------------------
// Step 3: widget → HTML mapping
// ---------------------------------------------------------------------------

/** Single-child slot names, searched in order for a child widget. */
const CHILD_SLOTS = ['child', 'body', 'builder'];
/** Multi-child slot names that hold widget lists. */
const CHILDREN_SLOTS = ['children', 'slivers', 'actions'];

function arg(node: WidgetNode, name: string): Node | undefined {
  return node.args.find((a) => a.name === name)?.value;
}
function positional(node: WidgetNode): Node[] {
  return node.args.filter((a) => !a.name).map((a) => a.value);
}

/** Render a node's resolved children: named slots + positional widget args. */
function childrenOf(node: WidgetNode): Node[] {
  const out: Node[] = [];
  for (const slot of CHILDREN_SLOTS) {
    const v = arg(node, slot);
    if (v?.kind === 'list') out.push(...v.items);
    else if (v?.kind === 'widget') out.push(v);
  }
  for (const slot of CHILD_SLOTS) {
    const v = arg(node, slot);
    if (v) out.push(v);
  }
  // Positional widget children (e.g. Center(child), Padding(..., child)).
  for (const p of positional(node)) {
    if (p.kind === 'widget' || p.kind === 'list') out.push(p);
  }
  return out;
}

/**
 * Count recognizable content in a tree: string literals, and known leaf
 * widgets (text, buttons, inputs, media, controls). Pure wrappers and bare
 * custom boxes score 0, so a *Page that only wraps a private view loses to the
 * sibling build that actually lays out the screen.
 */
const CONTENT_WIDGETS = new Set([
  'Text', 'SelectableText', 'ElevatedButton', 'FilledButton', 'VenPrimaryButton',
  'TextButton', 'OutlinedButton', 'IconButton', 'FloatingActionButton',
  'TextField', 'TextFormField', 'VenTextField', 'CupertinoTextField',
  'Icon', 'ImageIcon', 'Image', 'CircleAvatar', 'ListTile', 'Card', 'Chip',
  'Divider', 'Checkbox', 'Switch', 'Radio', 'AppBar',
]);

function contentScore(node: Node, depth = 0): number {
  if (depth > 40) return 0;
  switch (node.kind) {
    case 'string':
      return 1;
    case 'opaque':
      return 0;
    case 'list':
      return node.items.reduce((s, n) => s + contentScore(n, depth + 1), 0);
    case 'widget': {
      const base = node.name.split('.')[0];
      const self = CONTENT_WIDGETS.has(base) ? 1 : 0;
      const kids = node.args.reduce((s, a) => s + contentScore(a.value, depth + 1), 0);
      return self + kids;
    }
  }
}

function renderNode(node: Node, state: RenderState): string {
  switch (node.kind) {
    case 'string':
      return `<span class="t">${esc(node.value)}</span>`;
    case 'opaque': {
      // A bare expression in a layout slot is usually invisible, but it may be
      // a localized-text call (context.t('key'), tr('key'), 'key'.tr()). When a
      // ctx is present, surface those as readable text.
      const loc = state.ctx ? localizedText(node.text, state.ctx) : null;
      return loc ? `<span class="t">${esc(loc)}</span>` : '';
    }
    case 'list':
      return node.items.map((n) => renderNode(n, state)).join('');
    case 'widget':
      return renderWidget(node, state);
  }
}

function renderKids(node: WidgetNode, state: RenderState): string {
  return childrenOf(node).map((n) => renderNode(n, state)).join('');
}

/** Find the first descendant Text literal (for button/labels). Bounded depth. */
function findLabel(node: Node, depth = 0): string | null {
  if (depth > 6) return null;
  if (node.kind === 'string') return node.value;
  if (node.kind === 'widget') {
    if (node.name === 'Text') {
      const a = positional(node)[0] ?? arg(node, 'data');
      if (a?.kind === 'string') return a.value;
    }
    for (const a of node.args) {
      const found = findLabel(a.value, depth + 1);
      if (found) return found;
    }
  }
  if (node.kind === 'list') {
    for (const it of node.items) {
      const found = findLabel(it, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Pull a string literal from a named arg, else null. */
function strArg(node: WidgetNode, name: string): string | null {
  const v = arg(node, name);
  return v?.kind === 'string' ? v.value : null;
}

function renderWidget(node: WidgetNode, state: RenderState): string {
  const base = node.name.split('.')[0]; // Image.asset → Image

  // Design-system component aliases (VenPrimaryButton, VenTextField, ...) have a
  // built-in stock rendering for the no-ctx path, but when a ctx can supply
  // their real source we prefer their actual build tree (real white/blue button,
  // bordered field, etc.). Falls through to the stock case on resolution failure.
  if (state.ctx && CTX_PREFERRED_ALIASES.has(base)) {
    const resolved = resolveCustom(node, state);
    if (resolved !== null) return resolved;
  }

  switch (base) {
    // --- Scaffolding -------------------------------------------------------
    case 'Scaffold':
    case 'VenGradientScaffold': // pass-through gradient scaffold variants
    case 'CupertinoPageScaffold': {
      const appBar = arg(node, 'appBar');
      const body = arg(node, 'body');
      const bottomNav = arg(node, 'bottomNavigationBar');
      const fab = arg(node, 'floatingActionButton');
      let html = '<div class="scaffold">';
      if (appBar) html += renderNode(appBar, state);
      html += `<div class="body">${body ? renderNode(body, state) : ''}</div>`;
      if (bottomNav) html += `<div class="bottomnav">${renderNode(bottomNav, state)}</div>`;
      html += '</div>';
      if (fab) html += `<div class="fab">${labelOrIcon(fab) || '+'}</div>`;
      return html;
    }
    case 'AppBar':
    case 'SliverAppBar':
    case 'CupertinoNavigationBar': {
      const title = arg(node, 'title');
      const actions = arg(node, 'actions');
      const titleHtml = title ? renderNode(title, state) : '';
      let actionsHtml = '';
      if (actions?.kind === 'list') {
        actionsHtml = actions.items
          .map(() => '<span class="appbar-action"></span>')
          .join('');
      }
      return `<div class="appbar"><span class="appbar-title">${titleHtml}</span><span class="appbar-actions">${actionsHtml}</span></div>`;
    }

    // --- Pass-through wrappers --------------------------------------------
    case 'SafeArea':
    case 'Material':
    case 'Center':
    case 'Align':
    case 'Expanded':
    case 'Flexible':
    case 'SingleChildScrollView':
    case 'SizedBox':
    case 'DecoratedBox':
    case 'BlocProvider':
    case 'BlocBuilder':
    case 'BlocListener':
    case 'BlocConsumer':
    case 'MultiBlocListener':
    case 'MultiBlocProvider':
    case 'GestureDetector':
    case 'InkWell':
    case 'AnimatedContainer':
    case 'ConstrainedBox': {
      const cls =
        base === 'Center' || base === 'Align'
          ? 'center'
          : base === 'Expanded' || base === 'Flexible'
            ? 'expanded'
            : base === 'SingleChildScrollView'
              ? 'scroll'
              : 'wrap';
      // DecoratedBox/Container-likes can carry a real background color.
      const style = bgStyle(node, state);
      return `<div class="${cls}"${style}>${renderKids(node, state)}</div>`;
    }

    // --- Layout ------------------------------------------------------------
    case 'Column':
      return `<div class="column">${renderKids(node, state)}</div>`;
    case 'Row':
      return `<div class="row">${renderKids(node, state)}</div>`;
    case 'Wrap':
      return `<div class="wrap-flow">${renderKids(node, state)}</div>`;
    case 'Stack':
      return `<div class="stack">${renderKids(node, state)}</div>`;
    case 'Padding':
      return `<div class="pad">${renderKids(node, state)}</div>`;
    case 'Container':
      return `<div class="container"${bgStyle(node, state)}>${renderKids(node, state)}</div>`;
    case 'ListView':
    case 'CustomScrollView':
    case 'GridView':
    case 'PageView': {
      if (node.name.endsWith('.builder') || node.name.endsWith('.separated')) {
        // Repeated placeholder rows for builder lists.
        const rows = Array.from({ length: 4 })
          .map(() => '<div class="list-row"></div>')
          .join('');
        return `<div class="scroll list">${rows}</div>`;
      }
      return `<div class="scroll list">${renderKids(node, state)}</div>`;
    }

    // --- Text --------------------------------------------------------------
    case 'Text':
    case 'SelectableText': {
      const a = positional(node)[0] ?? arg(node, 'data');
      if (a?.kind === 'string') return `<span class="t"${textColorStyle(node, state)}>${esc(a.value)}</span>`;
      // Localized text call (context.t('key'), tr('key'), 'key'.tr())?
      const loc = a && state.ctx ? localizedNode(a, state.ctx) : null;
      if (loc) return `<span class="t"${textColorStyle(node, state)}>${esc(loc)}</span>`;
      // Dynamic text → muted placeholder bar.
      return `<span class="t-dyn" title="dynamic text"></span>`;
    }
    case 'RichText':
      return `<span class="t-dyn" title="rich text"></span>`;

    // --- Buttons -----------------------------------------------------------
    case 'ElevatedButton':
    case 'FilledButton':
    case 'VenPrimaryButton':
    case 'CupertinoButton': {
      const label = buttonLabel(node, state);
      return `<button class="btn btn-filled"${bgStyle(node, state, 'backgroundColor')}>${esc(label)}</button>`;
    }
    case 'TextButton':
    case 'CupertinoButton.filled': {
      const label = buttonLabel(node, state);
      return `<button class="btn btn-text">${esc(label)}</button>`;
    }
    case 'OutlinedButton': {
      const label = buttonLabel(node, state);
      return `<button class="btn btn-outlined">${esc(label)}</button>`;
    }
    case 'IconButton':
      return `<button class="icon-btn">${iconGlyph(node)}</button>`;
    case 'FloatingActionButton':
      return `<div class="fab">${labelOrIcon(node) || '+'}</div>`;

    // --- Inputs ------------------------------------------------------------
    case 'TextField':
    case 'TextFormField':
    case 'VenTextField':
    case 'CupertinoTextField': {
      const hint =
        strArg(node, 'hintText') ??
        localizedArg(node, 'hintText', state) ??
        decorationHint(node, state) ??
        'Input';
      return `<div class="input"><span class="input-hint">${esc(hint)}</span></div>`;
    }

    // --- Media -------------------------------------------------------------
    case 'Icon':
    case 'ImageIcon':
      return iconGlyph(node);
    case 'Image':
      return `<div class="image-ph" title="image"></div>`;
    case 'CircleAvatar':
      return `<div class="avatar"></div>`;

    // --- Material bits -----------------------------------------------------
    case 'Card':
      return `<div class="card">${renderKids(node, state)}</div>`;
    case 'ListTile': {
      const leading = arg(node, 'leading');
      const title = arg(node, 'title');
      const subtitle = arg(node, 'subtitle');
      const trailing = arg(node, 'trailing');
      let html = '<div class="tile">';
      if (leading) html += `<div class="tile-leading">${renderNode(leading, state)}</div>`;
      html += '<div class="tile-main">';
      if (title) html += `<div class="tile-title">${renderNode(title, state)}</div>`;
      if (subtitle) html += `<div class="tile-sub">${renderNode(subtitle, state)}</div>`;
      html += '</div>';
      if (trailing) html += `<div class="tile-trailing">${renderNode(trailing, state)}</div>`;
      html += '</div>';
      return html;
    }
    case 'Divider':
    case 'VerticalDivider':
      return '<hr class="divider" />';
    case 'Checkbox':
      return '<span class="checkbox"></span>';
    case 'Switch':
    case 'CupertinoSwitch':
      return '<span class="switch"></span>';
    case 'Radio':
      return '<span class="radio"></span>';
    case 'Chip':
    case 'ActionChip':
    case 'InputChip':
    case 'FilterChip': {
      const label = findLabel(node) ?? 'Chip';
      return `<span class="chip">${esc(label)}</span>`;
    }
    case 'Spacer':
      return '<div class="spacer"></div>';
    case 'CircularProgressIndicator':
    case 'LinearProgressIndicator':
      return '<div class="progress"></div>';

    // --- Unknown / custom widget ------------------------------------------
    default: {
      // With a ctx, try to render the custom widget's OWN build() tree in place
      // of a generic box — recursively resolving the app's design system.
      const resolved = resolveCustom(node, state);
      if (resolved !== null) return resolved;

      const kids = renderKids(node, state);
      const label = findLabel(node);
      return (
        `<div class="generic"><span class="generic-label">${esc(node.name)}</span>` +
        (kids || (label ? `<span class="t">${esc(label)}</span>` : '')) +
        `</div>`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Custom-widget resolution (ctx.resolveClass) — recursive, cycle-guarded
// ---------------------------------------------------------------------------

/**
 * When `node` is a genuinely custom widget (not a built-in) and the ctx can
 * supply its source, parse that class's `build()` and render its widget subtree
 * in place. Returns null to fall back to the generic labeled box on: no ctx,
 * built-in name, depth cap, cycle, resolution failure, or empty/opaque build.
 *
 * We render the widget's *default* build tree — its own fields (e.g. `label`)
 * are unknown identifiers and render as placeholders, but the real shape and
 * colors come through. A subtle corner label keeps the component name visible.
 */
function resolveCustom(node: WidgetNode, state: RenderState): string | null {
  const { ctx } = state;
  if (!ctx) return null;

  const name = node.name.split('.')[0]; // drop named-constructor suffix
  // Never resolve true built-ins via ctx — except design-system aliases we
  // explicitly prefer to render from their real source when available.
  if (isBuiltinWidget(name) && !CTX_PREFERRED_ALIASES.has(name)) return null;
  if (state.depth >= MAX_RESOLVE_DEPTH) return null; // depth cap
  if (state.resolving.has(name)) return null; // cycle on current path

  let source: string | null;
  try {
    source = ctx.resolveClass(name);
  } catch {
    return null; // ctx hooks must never crash the renderer
  }
  if (!source) return null;

  const bodies = locateBuildBodies(source);
  if (bodies.length === 0) return null;
  const tree = parseWidget(bodies[0]);
  if (!tree || tree.kind === 'opaque') return null;

  // Param-forwarding wrappers (TestId, Opacity, Semantics shims, …) build from
  // a `child`/`children`/`body` field we can't substitute. Resolving them would
  // drop the real content passed at THIS call site, so prefer the generic box
  // (which recurses into the constructor's own children) when the resolved
  // build either forwards such a slot or carries no recognizable content.
  if (forwardsChildSlot(tree) || contentScore(tree) === 0) return null;

  // Recurse with this class added to the path and depth bumped.
  const next: RenderState = {
    ctx,
    resolving: new Set(state.resolving).add(name),
    depth: state.depth + 1,
  };
  const inner = renderNode(tree, next);
  if (!inner) return null; // resolved build produced nothing visible → fall back

  // Keep a faint marker that this came from a component, without dominating it.
  return `<div class="component" title="${esc(node.name)}">${inner}</div>`;
}

/**
 * Built-in Flutter/Material/Cupertino widgets we model directly — these must
 * never be looked up via ctx.resolveClass. Mirrors the cases in renderWidget
 * (matched on the base name, before any named-constructor suffix).
 */
const BUILTIN_WIDGETS = new Set([
  'Scaffold', 'VenGradientScaffold', 'CupertinoPageScaffold',
  'AppBar', 'SliverAppBar', 'CupertinoNavigationBar',
  'SafeArea', 'Material', 'Center', 'Align', 'Expanded', 'Flexible',
  'SingleChildScrollView', 'SizedBox', 'DecoratedBox', 'BlocProvider',
  'BlocBuilder', 'BlocListener', 'BlocConsumer', 'MultiBlocListener',
  'MultiBlocProvider', 'GestureDetector', 'InkWell', 'AnimatedContainer',
  'ConstrainedBox', 'Column', 'Row', 'Wrap', 'Stack', 'Padding', 'Container',
  'ListView', 'CustomScrollView', 'GridView', 'PageView',
  'Text', 'SelectableText', 'RichText',
  'ElevatedButton', 'FilledButton', 'VenPrimaryButton', 'CupertinoButton',
  'TextButton', 'OutlinedButton', 'IconButton', 'FloatingActionButton',
  'TextField', 'TextFormField', 'VenTextField', 'CupertinoTextField',
  'Icon', 'ImageIcon', 'Image', 'CircleAvatar', 'Card', 'ListTile',
  'Divider', 'VerticalDivider', 'Checkbox', 'Switch', 'CupertinoSwitch',
  'Radio', 'Chip', 'ActionChip', 'InputChip', 'FilterChip', 'Spacer',
  'CircularProgressIndicator', 'LinearProgressIndicator',
]);

function isBuiltinWidget(name: string): boolean {
  return BUILTIN_WIDGETS.has(name);
}

/** Bare forwarded slot identifiers a wrapper's build hands its `child` through. */
const FORWARDED_SLOTS = new Set(['child', 'children', 'body']);

/**
 * True when the tree forwards a constructor `child`/`children`/`body` field as a
 * bare identifier (e.g. `Semantics(child: child)`, `Opacity(child: button)`).
 * For such wrappers the real content lives in the call-site args, not the
 * default build, so we'd rather render the generic box that recurses into them.
 */
function forwardsChildSlot(node: Node, depth = 0): boolean {
  if (depth > MAX_RESOLVE_DEPTH) return false;
  if (node.kind === 'opaque') {
    return FORWARDED_SLOTS.has(node.text.trim());
  }
  if (node.kind === 'widget') {
    for (const a of node.args) {
      if ((a.name === 'child' || a.name === 'children' || a.name === 'body') &&
          a.value.kind === 'opaque' && FORWARDED_SLOTS.has(a.value.text.trim())) {
        return true;
      }
      if (forwardsChildSlot(a.value, depth + 1)) return true;
    }
    return false;
  }
  if (node.kind === 'list') {
    return node.items.some((n) => forwardsChildSlot(n, depth + 1));
  }
  return false;
}

/**
 * Design-system component aliases that have a built-in stock rendering (so the
 * no-ctx path still looks good) but whose *real* build tree is richer — when a
 * ctx can resolve their source we prefer it. These names also appear in
 * BUILTIN_WIDGETS; the ctx path takes precedence only when resolution succeeds.
 */
const CTX_PREFERRED_ALIASES = new Set([
  'VenPrimaryButton', 'VenTextField',
]);

/** Best-effort hint text from a `decoration: InputDecoration(hintText/labelText:)`. */
function decorationHint(node: WidgetNode, state: RenderState): string | null {
  const dec = arg(node, 'decoration');
  if (dec?.kind === 'widget') {
    return (
      strArg(dec, 'hintText') ??
      strArg(dec, 'labelText') ??
      localizedArg(dec, 'hintText', state) ??
      localizedArg(dec, 'labelText', state) ??
      null
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Color resolution (ctx.colorToken / Color(0x..) literals)
// ---------------------------------------------------------------------------

/** Common Flutter `Colors.*` fallbacks when ctx.colorToken has no answer. */
const FLUTTER_COLORS: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  red: '#f44336',
  pink: '#e91e63',
  purple: '#9c27b0',
  indigo: '#3f51b5',
  blue: '#2196f3',
  lightBlue: '#03a9f4',
  cyan: '#00bcd4',
  teal: '#009688',
  green: '#4caf50',
  lightGreen: '#8bc34a',
  lime: '#cddc39',
  yellow: '#ffeb3b',
  amber: '#ffc107',
  orange: '#ff9800',
  deepOrange: '#ff5722',
  brown: '#795548',
  grey: '#9e9e9e',
  gray: '#9e9e9e',
  blueGrey: '#607d8b',
  transparent: 'transparent',
};

/**
 * Resolve a color-valued Node to a CSS color string, or null. Handles:
 *   Color(0xAARRGGBB)         → #rrggbb (or rgba() when AA < 0xFF)
 *   <Anything>.<member>       → ctx.colorToken(member), else Colors.* fallback
 *   <color>.withOpacity/...   → the underlying color (alpha ignored)
 */
function resolveColor(node: Node | undefined, ctx?: PreviewContext): string | null {
  if (!node) return null;

  if (node.kind === 'widget') {
    // Color(0x........) literal.
    if (node.name === 'Color') {
      const p = positional(node)[0];
      if (p?.kind === 'opaque') return hexFromColorLiteral(p.text);
    }
    return null;
  }

  if (node.kind !== 'opaque') return null;
  const text = node.text.trim();

  // Color(0x........) that parsed as opaque (e.g. inside other expressions).
  const litMatch = /^Color\(\s*(0x[0-9a-fA-F]+)\s*\)$/.exec(text);
  if (litMatch) return hexFromColorLiteral(litMatch[1]);

  // `<Owner>.<member>` token reference, possibly with a trailing `.withXxx(...)`
  // modifier (e.g. VenColors.white.withValues(alpha: 0.7)). Take the member.
  const tokenMatch = /^[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)/.exec(text);
  if (tokenMatch) {
    const member = tokenMatch[1];
    if (ctx) {
      try {
        const hex = ctx.colorToken(member);
        if (hex) return hex;
      } catch {
        // fall through to built-in fallback
      }
    }
    if (member in FLUTTER_COLORS) return FLUTTER_COLORS[member];
  }
  return null;
}

/** Convert a `0xAARRGGBB` (or `0xRRGGBB`) literal to a CSS color, or null. */
function hexFromColorLiteral(lit: string): string | null {
  const hex = lit.replace(/^0x/i, '');
  if (hex.length === 8) {
    const a = parseInt(hex.slice(0, 2), 16);
    const r = parseInt(hex.slice(2, 4), 16);
    const g = parseInt(hex.slice(4, 6), 16);
    const b = parseInt(hex.slice(6, 8), 16);
    if ([a, r, g, b].some(Number.isNaN)) return null;
    if (a >= 255) return `#${hex.slice(2).toLowerCase()}`;
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
  }
  if (hex.length === 6) {
    if (Number.isNaN(parseInt(hex, 16))) return null;
    return `#${hex.toLowerCase()}`;
  }
  return null;
}

/**
 * Inline background-color style for a node, sourced from a color arg or a
 * nested `decoration: BoxDecoration(color: X)`. Returns ` style="..."` (with a
 * leading space) or '' when nothing resolves or there's no ctx.
 */
function bgStyle(node: WidgetNode, state: RenderState, argName = 'color'): string {
  if (!state.ctx) return '';
  let color = resolveColor(arg(node, argName), state.ctx);
  if (!color) {
    const dec = arg(node, 'decoration');
    if (dec?.kind === 'widget' && dec.name.split('.')[0] === 'BoxDecoration') {
      color = resolveColor(arg(dec, 'color'), state.ctx);
    }
  }
  return color ? ` style="background:${color}"` : '';
}

/**
 * Inline text-color style from a `style:` arg, honoring `.copyWith(color: X)`
 * and `TextStyle(color: X)`. Returns ` style="..."` or '' (no ctx / no color).
 */
function textColorStyle(node: WidgetNode, state: RenderState): string {
  if (!state.ctx) return '';
  const style = arg(node, 'style');
  const color = colorInStyleExpr(style, state.ctx);
  return color ? ` style="color:${color}"` : '';
}

/** Pull a `color:` out of a TextStyle / .copyWith(...) expression, or null. */
function colorInStyleExpr(node: Node | undefined, ctx: PreviewContext): string | null {
  if (!node) return null;
  if (node.kind === 'widget') {
    // TextStyle(color: X) (or any constructor exposing a color: arg).
    const direct = resolveColor(arg(node, 'color'), ctx);
    if (direct) return direct;
  }
  // `...copyWith(color: X)` and similar appear as opaque text — scan for the
  // color: argument and resolve whatever expression follows.
  const text = node.kind === 'opaque' ? node.text : null;
  if (text) {
    const m = /\bcolor\s*:\s*([^,)]+(?:\([^)]*\))?)/.exec(text);
    if (m) return resolveColor({ kind: 'opaque', text: m[1].trim() }, ctx);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Localized text (ctx.localize / humanized fallback)
// ---------------------------------------------------------------------------

/**
 * If `expr` is a localization call — context.t('key'), context.tr('key'),
 * tr('key') or 'key'.tr() — return display text via ctx.localize(key), falling
 * back to a humanized last dot-segment. Returns null when it isn't one.
 */
function localizedText(expr: string, ctx: PreviewContext): string | null {
  const key = localizationKey(expr);
  if (key === null) return null;
  let resolved: string | null = null;
  try {
    resolved = ctx.localize(key);
  } catch {
    resolved = null;
  }
  return resolved ?? humanizeKey(key);
}

/** Like localizedText, but for an already-parsed (opaque) Node. */
function localizedNode(node: Node, ctx: PreviewContext): string | null {
  return node.kind === 'opaque' ? localizedText(node.text, ctx) : null;
}

/** Localized value of a named arg (e.g. hintText: context.t('...')), or null. */
function localizedArg(node: WidgetNode, name: string, state: RenderState): string | null {
  if (!state.ctx) return null;
  const v = arg(node, name);
  if (v?.kind === 'opaque') return localizedText(v.text, state.ctx);
  return null;
}

/** Extract the key from a localization call expression, or null. */
function localizationKey(expr: string): string | null {
  const text = expr.trim();
  // context.t('key' ...), context.tr('key'), tr('key'), t('key')
  let m = /^(?:[\w$]+\s*\.\s*)?(?:t|tr|translate)\s*\(\s*(['"])((?:[^'"\\]|\\.)*)\1/.exec(text);
  if (m) return m[2];
  // 'key'.tr()
  m = /^(['"])((?:[^'"\\]|\\.)*)\1\s*\.\s*tr\s*\(/.exec(text);
  if (m) return m[2];
  return null;
}

/** Humanize a dot-keyed string: `auth.login.sign_in` → "Sign In". */
function humanizeKey(key: string): string {
  const last = key.split('.').pop() ?? key;
  return last
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Resolve a button's label: `label:` arg (string/localized), then any Text. */
function buttonLabel(node: WidgetNode, state: RenderState): string {
  return (
    strArg(node, 'label') ??
    localizedArg(node, 'label', state) ??
    findLabel(node) ??
    (state.ctx ? findLocalizedLabel(node, state.ctx) : null) ??
    'Button'
  );
}

/** Find the first localizable text in a subtree (bounded), or null. */
function findLocalizedLabel(node: Node, ctx: PreviewContext, depth = 0): string | null {
  if (depth > 6) return null;
  if (node.kind === 'opaque') return localizedText(node.text, ctx);
  if (node.kind === 'widget') {
    for (const a of node.args) {
      const found = findLocalizedLabel(a.value, ctx, depth + 1);
      if (found) return found;
    }
  }
  if (node.kind === 'list') {
    for (const it of node.items) {
      const found = findLocalizedLabel(it, ctx, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** A small glyph placeholder for icons. */
function iconGlyph(node: WidgetNode): string {
  void node;
  return '<span class="icon"></span>';
}

/** Label text or icon glyph for FAB-like widgets. */
function labelOrIcon(node: Node): string {
  if (node.kind === 'widget') {
    const label = findLabel(node);
    if (label) return esc(label);
  }
  return '';
}

// ---------------------------------------------------------------------------
// HTML document scaffolding + styles
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#e9eaee;font-family:Roboto,-apple-system,"Segoe UI",system-ui,sans-serif;color:#1f1f1f;padding:16px;display:flex;justify-content:center}
.screen{width:390px;min-height:680px;background:#fff;border-radius:24px;box-shadow:0 8px 30px rgba(0,0,0,.18);overflow:hidden;position:relative;display:flex;flex-direction:column}
.scaffold{display:flex;flex-direction:column;flex:1;min-height:0}
.appbar{background:#2962ff;color:#fff;min-height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;box-shadow:0 2px 6px rgba(0,0,0,.2);position:relative;z-index:2}
.appbar-title{font-size:18px;font-weight:500}
.appbar-title .t{color:#fff}
.appbar-actions{display:flex;gap:8px}
.appbar-action{width:22px;height:22px;border-radius:5px;background:rgba(255,255,255,.35);display:inline-block}
.body{flex:1;min-height:0;overflow-y:auto;padding:12px}
.bottomnav{border-top:1px solid #e0e0e0;min-height:54px;display:flex;align-items:center;justify-content:space-around;background:#fafafa}
.fab{position:absolute;right:18px;bottom:74px;width:54px;height:54px;border-radius:50%;background:#2962ff;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;box-shadow:0 4px 10px rgba(0,0,0,.3);z-index:3}
.column{display:flex;flex-direction:column;gap:8px}
.row{display:flex;flex-direction:row;align-items:center;gap:8px;flex-wrap:wrap}
.wrap-flow{display:flex;flex-wrap:wrap;gap:6px}
.stack{position:relative;display:flex;flex-direction:column;gap:6px}
.center{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px}
.expanded{flex:1;display:flex;flex-direction:column;gap:8px}
.scroll{overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.list{gap:6px}
.list-row{height:48px;border-radius:8px;background:#f0f1f4}
.pad{padding:10px;display:flex;flex-direction:column;gap:8px}
.container{padding:8px;border-radius:8px;display:flex;flex-direction:column;gap:8px}
.wrap{display:flex;flex-direction:column;gap:8px}
.t{font-size:15px;line-height:1.4;color:#222}
.t-dyn{display:inline-block;height:14px;width:120px;border-radius:4px;background:#e3e5ea;vertical-align:middle}
.btn{border:none;border-radius:8px;padding:11px 18px;font-size:15px;font-weight:500;cursor:default;font-family:inherit}
.btn-filled{background:#2962ff;color:#fff}
.btn-text{background:transparent;color:#2962ff}
.btn-outlined{background:#fff;color:#2962ff;border:1px solid #2962ff}
.icon-btn{width:40px;height:40px;border-radius:50%;border:none;background:transparent;display:inline-flex;align-items:center;justify-content:center}
.input{border:1px solid #c4c8d0;border-radius:8px;padding:13px 12px;background:#fff}
.input-hint{color:#9aa0ad;font-size:15px}
.icon{display:inline-block;width:22px;height:22px;border-radius:6px;background:#c9cdd6}
.image-ph{width:100%;min-height:120px;border-radius:8px;background:linear-gradient(135deg,#d7dae1,#eceef2);display:flex}
.avatar{width:44px;height:44px;border-radius:50%;background:#c9cdd6}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.18);padding:12px;display:flex;flex-direction:column;gap:8px}
.tile{display:flex;align-items:center;gap:12px;padding:10px 8px;border-bottom:1px solid #f0f0f0}
.tile-main{flex:1;display:flex;flex-direction:column;gap:2px}
.tile-title{font-size:15px}
.tile-sub{font-size:13px;color:#777}
.divider{border:none;border-top:1px solid #e0e0e0;width:100%;margin:6px 0}
.checkbox{display:inline-block;width:20px;height:20px;border:2px solid #2962ff;border-radius:4px}
.switch{display:inline-block;width:36px;height:20px;border-radius:10px;background:#2962ff}
.radio{display:inline-block;width:20px;height:20px;border:2px solid #2962ff;border-radius:50%}
.chip{display:inline-block;padding:5px 12px;border-radius:16px;background:#eceef2;font-size:13px}
.spacer{flex:1}
.progress{width:32px;height:32px;border-radius:50%;border:3px solid #c9cdd6;border-top-color:#2962ff;margin:8px auto}
.generic{border:1.5px dashed #b3b8c2;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;background:#fbfbfc}
.component{display:flex;flex-direction:column;gap:6px}
.generic-label{font-size:11px;font-weight:600;color:#7a8190;text-transform:none;letter-spacing:.02em}
.notice{max-width:360px;background:#fff;border-radius:12px;padding:24px;box-shadow:0 4px 16px rgba(0,0,0,.12);text-align:center}
.notice h1{font-size:17px;margin-bottom:8px;color:#444}
.notice p{font-size:13px;color:#888}
.notice code{font-size:12px;color:#2962ff;word-break:break-all}
`.trim();

function doc(relPath: string, bodyHtml: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Preview — ${esc(relPath)}</title><style>${STYLE}</style></head>` +
    `<body>${bodyHtml}</body></html>`
  );
}

function errorDoc(relPath: string, message: string): string {
  const body =
    `<div class="notice"><h1>Preview unavailable</h1>` +
    `<p>${esc(message)}.</p>` +
    `<p><code>${esc(relPath)}</code></p></div>`;
  return doc(relPath, body);
}
