// export.ts — Build a single self-contained HTML file of the graph.
//
// Inlines the stylesheet (with fonts as base64 data URIs), the vendored
// Cytoscape libraries, the app script, and the graph data itself, so the
// result is one portable file that opens offline with no server. The web UI
// reads `window.__PM_GRAPH__` when present and skips its server-only features
// (live updates, refine).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { GraphData } from './types.js';

/** Vendored scripts, in load order (cytoscape → layout deps → fcose). */
const VENDOR_SCRIPTS = [
  'vendor/cytoscape.min.js',
  'vendor/layout-base.js',
  'vendor/cose-base.js',
  'vendor/cytoscape-fcose.js',
];

export async function buildStandaloneHtml(graph: GraphData, webDir: string): Promise<string> {
  const read = (rel: string): Promise<string> => fs.readFile(path.join(webDir, rel), 'utf8');

  let html = await read('index.html');
  let css = await read('style.css');

  // Inline fonts as base64 data URIs so the file is fully portable.
  const fontDir = path.join(webDir, 'vendor', 'fonts');
  const fontFiles = await fs.readdir(fontDir).catch(() => [] as string[]);
  for (const ff of fontFiles) {
    if (!ff.endsWith('.woff2')) continue;
    const b64 = (await fs.readFile(path.join(fontDir, ff))).toString('base64');
    css = css.split(`vendor/fonts/${ff}`).join(`data:font/woff2;base64,${b64}`);
  }

  // Embed scripts as base64 `data:` URI <script src> tags rather than raw
  // inline <script> bodies. Minified UMD bundles can contain `<!--`/`<script`
  // substrings that confuse the HTML "script data" parser and truncate the
  // tag; a data URI is decoded and executed as a normal external script, so
  // none of that applies. Parser-inserted classic scripts still run in order.
  const dataUri = (js: string): string =>
    `data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`;

  // Embed the graph. Escape `<` so a stray `</script>` in data can't break out.
  const dataJson = JSON.stringify(graph).replace(/</g, '\\u003c');

  // Swap external references for inline content.
  html = html.replace(
    /<link rel="stylesheet" href="style.css"\s*\/?>/,
    `<style>\n${css}\n</style>`,
  );
  html = html.replace(/\s*<script src="vendor\/[^"]+"><\/script>/g, '');
  html = html.replace(/\s*<script src="app.js"><\/script>/, '');

  let inline = '';
  for (const v of VENDOR_SCRIPTS) inline += `<script src="${dataUri(await read(v))}"></script>\n`;
  inline += `<script>window.__PM_GRAPH__ = ${dataJson};</script>\n`;
  inline += `<script src="${dataUri(await read('app.js'))}"></script>\n`;
  html = html.replace('</body>', `${inline}</body>`);

  return html;
}
