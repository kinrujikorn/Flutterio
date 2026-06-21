// lsp/analyze.ts — Dart LSP-backed accurate analyzer.
//
// Drives `dart language-server` to compute pages, widgets, and "uses" edges
// from real semantic data instead of regex heuristics, then merges that with
// the heuristic baseline for the parts LSP doesn't improve (imports, nav,
// api). The accuracy wins are:
//
//   - Class list per file comes from `textDocument/documentSymbol` (no
//     comment/string false positives).
//   - Widget/page classification comes from `textDocument/hover`, parsing the
//     `extends`/`with`/`implements` clause from the declaration markdown.
//   - "uses" edges come from `textDocument/references` on each widget class —
//     real resolved references, eliminating the token-matching false positives
//     of the heuristic.
//
// Robustness: this NEVER throws for an operational failure. On any problem
// (Dart missing, init failure, timeout, mass request failure) it returns null
// so the CLI falls back to `parseProject`. The child process is always killed.
//
// Graceful degradation: when project dependencies aren't fetched
// (`dart pub get` not run), hover can't resolve external supertypes like
// `StatelessWidget`, so its declaration shows no `extends` clause. In that
// case we fall back to the heuristic baseline's classification for that class.
// References, however, resolve fine without deps, so the main accuracy win
// survives.

import { promises as fs } from 'node:fs';
import type {
  ApiEdge,
  ParseResult,
  PageInfo,
  ScanResult,
  UsesEdge,
  WidgetInfo,
} from '../types.js';
import { parseProject } from '../parser/index.js';
import { LspClient, pathToFileUri, fileUriToPath } from './client.js';

/** Overall time budget for the whole LSP pass before we bail to fallback. */
const TOTAL_BUDGET_MS = 120_000;

/** Class-name suffixes that denote a service/datasource for `api` edges. */
const SERVICE_RE = /(Repository|DataSource|Service)$/;
/** Per-request timeout for symbol/hover/references calls. */
const REQUEST_TIMEOUT_MS = 5_000;
/** Grace period after `initialized` to let the server settle if no signal. */
const SETTLE_GRACE_MS = 8_000;

/** LSP SymbolKind for a class. */
const SYMBOL_KIND_CLASS = 5;

/** Widget base classes / suffixes we treat as widgets. */
const WIDGET_BASES = new Set([
  'StatelessWidget',
  'StatefulWidget',
  'ConsumerWidget',
  'ConsumerStatefulWidget',
  'HookWidget',
  'HookConsumerWidget',
]);

/** A flat LSP SymbolInformation (the shape dart returns for documentSymbol). */
interface SymbolInformation {
  name: string;
  kind: number;
  containerName?: string;
  location: { uri: string; range: LspRange };
}

/** A hierarchical LSP DocumentSymbol (handled if the server returns this). */
interface DocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: DocumentSymbol[];
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

/** A class declaration discovered via documentSymbol, with its name position. */
interface ClassDecl {
  className: string;
  fileRel: string;
  /** Position of the class name token (for hover/references). */
  position: { line: number; character: number };
}

/**
 * Classify a class from the `extends`/`with`/`implements` tokens parsed out of
 * a hover declaration. Returns 'page', 'widget', or null (not a widget).
 */
function classifyFromSupertypes(className: string, supertypes: string[]): 'page' | 'widget' | null {
  const isWidget = supertypes.some((t) => {
    const head = t.replace(/<.*$/, ''); // drop generic args, e.g. State<Foo>
    return (
      WIDGET_BASES.has(head) ||
      head === 'State' ||
      head.endsWith('Widget') ||
      head.endsWith('State')
    );
  });
  if (!isWidget) return null;
  return className.endsWith('Page') ? 'page' : 'widget';
}

/**
 * Parse the supertype identifiers out of a hover declaration string such as
 * "class LoginPage extends StatelessWidget with Mixin implements Foo".
 */
function parseSupertypes(decl: string): string[] {
  const out: string[] = [];
  const grab = (re: RegExp): void => {
    const m = decl.match(re);
    if (!m) return;
    for (const part of m[1].split(',')) {
      const id = part.trim().split(/\s/)[0];
      if (id) out.push(id);
    }
  };
  // `extends X` (single), `with A, B`, `implements C, D`.
  const ext = decl.match(/\bextends\s+([A-Za-z_]\w*(?:<[^>]*>)?)/);
  if (ext) out.push(ext[1]);
  grab(/\bwith\s+([^]*?)(?:\bimplements\b|$)/);
  grab(/\bimplements\s+([^]*?)$/);
  return out;
}

/** Extract the fenced `dart` declaration line from hover markdown contents. */
function hoverDeclaration(hover: unknown): string | null {
  if (!hover || typeof hover !== 'object') return null;
  const contents = (hover as { contents?: unknown }).contents;
  let text: string | null = null;
  if (typeof contents === 'string') text = contents;
  else if (contents && typeof contents === 'object' && 'value' in contents) {
    text = String((contents as { value: unknown }).value);
  }
  if (!text) return null;
  // Pull the first ```dart fenced block.
  const m = text.match(/```dart\s*([^]*?)```/);
  const block = (m ? m[1] : text).trim();
  // The declaration is the first line beginning with `class`.
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('class ') || t.startsWith('abstract class ') || t.includes('class ')) {
      return t;
    }
  }
  return block.split(/\r?\n/)[0]?.trim() ?? null;
}

/** Pull the static-const route literal out of file text, mirroring the heuristic. */
function extractRoutePath(text: string, className: string): string | undefined {
  // Find the class body and search for a routePath const / routePathFor return.
  const classIdx = text.search(new RegExp(`class\\s+${className}\\b`));
  const body = classIdx === -1 ? text : text.slice(classIdx);
  const constMatch = body.match(
    /static\s+const\s+(?:String\s+)?routePath\s*=\s*(['"])([^'"]+)\1/,
  );
  if (constMatch) return constMatch[2];
  const forMatch = body.match(
    /static\s+\w+\s+routePathFor\s*\([^)]*\)\s*=>\s*(['"])([^'"]+)\1/,
  );
  if (forMatch) return forMatch[2];
  return undefined;
}

/** Top-level class declarations from a documentSymbol response. */
function extractClasses(result: unknown, fileRel: string): ClassDecl[] {
  if (!Array.isArray(result)) return [];
  const out: ClassDecl[] = [];

  // Flat SymbolInformation[] (what dart returns): a class is kind 5 with no
  // containerName (top-level). Its location.range.start is the name token.
  const looksFlat = result.length > 0 && 'location' in (result[0] as object);
  if (looksFlat) {
    for (const s of result as SymbolInformation[]) {
      if (s.kind === SYMBOL_KIND_CLASS && !s.containerName) {
        out.push({
          className: s.name,
          fileRel,
          position: s.location.range.start,
        });
      }
    }
    return out;
  }

  // Hierarchical DocumentSymbol[]: top-level classes are the roots of kind 5.
  for (const s of result as DocumentSymbol[]) {
    if (s.kind === SYMBOL_KIND_CLASS) {
      out.push({
        className: s.name,
        fileRel,
        position: s.selectionRange?.start ?? s.range.start,
      });
    }
  }
  return out;
}

export async function analyzeWithLsp(scan: ScanResult): Promise<ParseResult | null> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const timeLeft = (): number => deadline - Date.now();

  // 1. Heuristic baseline — accurate enough for imports/nav/api and a safety
  //    net for classification when hover can't resolve external supertypes.
  let base: ParseResult;
  try {
    base = await parseProject(scan);
  } catch {
    return null;
  }

  const client = new LspClient();
  client.onStderr = () => {}; // server diagnostics are noisy; ignore.

  // Detect an "analysis complete" signal so we can proceed sooner than the
  // grace period when the server tells us it finished its initial pass.
  let analysisDone = false;
  const progressEnded = new Set<unknown>();
  client.onNotification = (n) => {
    if (n.method === '$/progress') {
      const p = n.params as { token?: unknown; value?: { kind?: string } } | undefined;
      if (p?.value?.kind === 'end') {
        progressEnded.add(p.token);
        analysisDone = true;
      }
    }
  };

  try {
    if (!client.start()) return null;

    // 2. initialize / initialized.
    const initParams = {
      processId: process.pid,
      clientInfo: { name: 'pagemapper' },
      rootUri: pathToFileUri(scan.projectRoot),
      capabilities: {},
    };
    await client.request('initialize', initParams, Math.min(20_000, timeLeft()));
    client.notify('initialized', {});

    // 3. Wait for the initial analysis to settle (a $/progress end or grace).
    const settleStart = Date.now();
    while (!analysisDone && Date.now() - settleStart < SETTLE_GRACE_MS) {
      if (timeLeft() < 5_000) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Build a relPath lookup (POSIX) keyed by normalized absolute path.
    const relByAbs = new Map<string, string>();
    const scannedRel = new Set<string>();
    for (const f of scan.files) {
      relByAbs.set(f.absPath.replace(/\\/g, '/').toLowerCase(), f.relPath);
      scannedRel.add(f.relPath);
    }
    const uriToRel = (uri: string): string | null => {
      const abs = fileUriToPath(uri).replace(/\\/g, '/').toLowerCase();
      return relByAbs.get(abs) ?? null;
    };

    // Heuristic indexes for fallback classification + route lookup.
    const baseWidgetByClass = new Map<string, WidgetInfo>();
    for (const w of base.widgets) baseWidgetByClass.set(w.className, w);
    const basePageByClass = new Map<string, PageInfo>();
    for (const p of base.pages) basePageByClass.set(p.className, p);

    // 4. documentSymbol per file -> class declarations.
    const fileByRel = new Map(scan.files.map((f) => [f.relPath, f]));
    const classDecls: ClassDecl[] = [];
    let symbolFailures = 0;

    for (const file of scan.files) {
      if (timeLeft() < 10_000) break; // reserve time for hover/references
      const uri = pathToFileUri(file.absPath);
      let result: unknown = null;
      try {
        result = await client.request(
          'textDocument/documentSymbol',
          { textDocument: { uri } },
          REQUEST_TIMEOUT_MS,
        );
      } catch {
        symbolFailures++;
      }
      let decls = extractClasses(result, file.relPath);
      // Fall back to didOpen + retry once if no symbols came back.
      if (decls.length === 0) {
        try {
          const text = await fs.readFile(file.absPath, 'utf8');
          client.notify('textDocument/didOpen', {
            textDocument: { uri, languageId: 'dart', version: 1, text },
          });
          result = await client.request(
            'textDocument/documentSymbol',
            { textDocument: { uri } },
            REQUEST_TIMEOUT_MS,
          );
          decls = extractClasses(result, file.relPath);
        } catch {
          // leave decls empty
        }
      }
      for (const d of decls) classDecls.push(d);
    }

    // If basically nothing resolved, bail to the heuristic fallback.
    if (classDecls.length === 0) return null;

    // 5. hover per class -> classify widget/page. Cache file text for routePath.
    const textCache = new Map<string, string>();
    const readText = async (file: { absPath: string; relPath: string }): Promise<string> => {
      const cached = textCache.get(file.relPath);
      if (cached !== undefined) return cached;
      let t = '';
      try {
        t = await fs.readFile(file.absPath, 'utf8');
      } catch {
        t = '';
      }
      textCache.set(file.relPath, t);
      return t;
    };

    const widgets: WidgetInfo[] = [];
    const pages: PageInfo[] = [];
    const widgetClassNames = new Set<string>(); // classes confirmed as widgets
    // Track which classes are widget declarations so we know whom to ask for
    // references (the uses-edge sources point at these).
    const widgetDecls: ClassDecl[] = [];

    let hoverResolved = 0;
    let hoverUnresolved = 0;

    for (const decl of classDecls) {
      if (timeLeft() < 8_000) break;
      const uri = pathToFileUri(fileByRel.get(decl.fileRel)!.absPath);
      let kind: 'page' | 'widget' | null = null;
      let base_: string | undefined;

      let hover: unknown = null;
      try {
        hover = await client.request(
          'textDocument/hover',
          { textDocument: { uri }, position: decl.position },
          REQUEST_TIMEOUT_MS,
        );
      } catch {
        // treated as unresolved below
      }
      const declLine = hoverDeclaration(hover);
      const supertypes = declLine ? parseSupertypes(declLine) : [];

      if (supertypes.length > 0) {
        hoverResolved++;
        kind = classifyFromSupertypes(decl.className, supertypes);
        if (kind) base_ = supertypes[0].startsWith('State<') ? 'State' : supertypes[0];
      } else {
        // Hover gave no supertype (unresolved external base, e.g. flutter not
        // fetched). Fall back to the heuristic baseline's verdict.
        hoverUnresolved++;
        const hw = baseWidgetByClass.get(decl.className);
        const hp = basePageByClass.get(decl.className);
        if (hp) {
          kind = 'page';
          base_ = hw?.base;
        } else if (hw) {
          kind = decl.className.endsWith('Page') ? 'page' : 'widget';
          base_ = hw.base;
        }
      }

      if (kind === null) continue;
      widgetClassNames.add(decl.className);
      widgetDecls.push(decl);

      if (kind === 'page') {
        const page: PageInfo = { className: decl.className, fileRel: decl.fileRel };
        const fromBase = basePageByClass.get(decl.className)?.routePath;
        const route = fromBase ?? extractRoutePath(await readText(fileByRel.get(decl.fileRel)!), decl.className);
        if (route) page.routePath = route;
        pages.push(page);
        if (base_) widgets.push({ className: decl.className, fileRel: decl.fileRel, base: base_ });
        else widgets.push({ className: decl.className, fileRel: decl.fileRel });
      } else {
        widgets.push(
          base_
            ? { className: decl.className, fileRel: decl.fileRel, base: base_ }
            : { className: decl.className, fileRel: decl.fileRel },
        );
      }
    }

    // 6. references per widget/page class -> uses edges. Skip private classes
    //    (leading underscore can't be referenced cross-file in Dart).
    const usesEdges: UsesEdge[] = [];
    const seenUse = new Set<string>();
    for (const decl of widgetDecls) {
      if (timeLeft() < 5_000) break; // keep budget for shutdown
      if (decl.className.startsWith('_')) continue;
      const uri = pathToFileUri(fileByRel.get(decl.fileRel)!.absPath);
      let refs: unknown = null;
      try {
        refs = await client.request(
          'textDocument/references',
          {
            textDocument: { uri },
            position: decl.position,
            context: { includeDeclaration: false },
          },
          REQUEST_TIMEOUT_MS,
        );
      } catch {
        continue;
      }
      if (!Array.isArray(refs)) continue;
      for (const loc of refs as LspLocation[]) {
        const fromRel = uriToRel(loc.uri);
        if (!fromRel) continue; // outside project (sdk/pub-cache)
        if (!scannedRel.has(fromRel)) continue;
        if (fromRel === decl.fileRel) continue; // same file as declaration
        const key = `${fromRel} ${decl.className}`;
        if (seenUse.has(key)) continue;
        seenUse.add(key);
        usesEdges.push({ fromFileRel: fromRel, widgetClass: decl.className });
      }
    }

    // 6b. references per service/datasource/repository class -> api edges.
    //     These point at the REAL declaring file node (graph-builder links to it
    //     directly), unlike the heuristic's synthetic endpoint nodes. We keep
    //     the heuristic's external `http`/dio calls (no in-project target).
    const lspApiEdges: ApiEdge[] = [];
    const seenApi = new Set<string>();
    let serviceProcessed = 0;
    for (const decl of classDecls) {
      if (timeLeft() < 5_000) break; // keep budget for shutdown
      if (decl.className.startsWith('_')) continue;
      const m = decl.className.match(SERVICE_RE);
      if (!m) continue;
      const kind = m[1] === 'DataSource' ? 'datasource' : 'service';
      const uri = pathToFileUri(fileByRel.get(decl.fileRel)!.absPath);
      let refs: unknown = null;
      try {
        refs = await client.request(
          'textDocument/references',
          { textDocument: { uri }, position: decl.position, context: { includeDeclaration: false } },
          REQUEST_TIMEOUT_MS,
        );
      } catch {
        continue;
      }
      serviceProcessed++;
      if (!Array.isArray(refs)) continue;
      for (const loc of refs as LspLocation[]) {
        const fromRel = uriToRel(loc.uri);
        if (!fromRel || !scannedRel.has(fromRel)) continue;
        if (fromRel === decl.fileRel) continue;
        const key = `${fromRel} -> ${decl.fileRel}`;
        if (seenApi.has(key)) continue;
        seenApi.add(key);
        // target = the declaring file (a real node); graph-builder links to it.
        lspApiEdges.push({ fromFileRel: fromRel, target: decl.fileRel, kind });
      }
    }
    // Merge: accurate in-project service edges + heuristic external http edges.
    // If the budget ran out before we processed any service, keep heuristic api.
    const apiEdges: ApiEdge[] = serviceProcessed > 0
      ? lspApiEdges.concat(base.apiEdges.filter((e) => e.kind === 'http'))
      : base.apiEdges;

    // 7. Pages-set safety: UNION with every targetClass referenced by nav edges
    //    so graph-builder never drops a navigate edge. Prefer LSP metadata.
    const pageByClass = new Map<string, PageInfo>();
    for (const p of pages) pageByClass.set(p.className, p);
    for (const nav of base.navEdges) {
      if (!nav.targetClass || pageByClass.has(nav.targetClass)) continue;
      const carry = basePageByClass.get(nav.targetClass);
      if (carry) {
        pageByClass.set(carry.className, carry);
        pages.push(carry);
      }
    }

    // 8. Widgets-set safety: every widgetClass in usesEdges must have a widget
    //    entry (graph-builder maps widgetClass -> declaring file via widgets).
    const widgetByClass = new Map<string, WidgetInfo>();
    for (const w of widgets) if (!widgetByClass.has(w.className)) widgetByClass.set(w.className, w);
    for (const use of usesEdges) {
      if (widgetByClass.has(use.widgetClass)) continue;
      const carry = baseWidgetByClass.get(use.widgetClass);
      if (carry) {
        widgetByClass.set(carry.className, carry);
        widgets.push(carry);
      }
    }

    // Concise diagnostic so it's visible that LSP actually ran (and didn't
    // silently fall back). Goes to stderr to keep --json output clean.
    const depsHint = hoverResolved === 0 && hoverUnresolved > 0
      ? ' (deps not fetched — used heuristic classification; run `flutter pub get` for hover-accurate types)'
      : '';
    console.error(
      `[lsp] done: ${classDecls.length} classes, ${pages.length} pages, ${widgets.length} widgets, ${usesEdges.length} uses, ${apiEdges.length} api${depsHint}`,
    );

    return {
      imports: base.imports,
      pages,
      navEdges: base.navEdges,
      widgets,
      usesEdges,
      apiEdges,
    };
  } catch (err) {
    console.error(`[lsp] failed, falling back to heuristic: ${(err as Error).message}`);
    return null;
  } finally {
    await client.stop();
  }
}
