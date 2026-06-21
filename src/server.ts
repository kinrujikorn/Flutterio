// server.ts — Minimal static file + graph JSON server, with live updates.
//
// Serves the web UI from `webDir`, the computed graph at `/graph.json`, and a
// Server-Sent Events stream at `/events`. When the graph is rebuilt (watch
// mode), call the returned `update()` to push the new graph and notify clients.
// Picks an open port starting at the requested default (4567), incrementing on
// EADDRINUSE.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { GraphData } from './types.js';
import { buildStandaloneHtml } from './export.js';
import { renderPreview, type PreviewContext } from './preview.js';
import { createPreviewContext } from './preview-context.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** Resolve a URL path to a safe absolute file path inside webDir. */
function resolveStatic(webDir: string, urlPath: string): string | null {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const abs = path.resolve(webDir, rel);
  // Prevent path traversal outside webDir.
  const webResolved = path.resolve(webDir);
  if (abs !== webResolved && !abs.startsWith(webResolved + path.sep)) return null;
  return abs;
}

/** A running server with a handle to push graph updates to live clients. */
export interface RunningServer {
  url: string;
  /** Replace the served graph and notify all connected SSE clients. */
  update(graph: GraphData): void;
  /** Tell connected clients the component catalog was rebuilt (reload Live). */
  notifyCatalog(): void;
}

export interface ServerOptions {
  /**
   * Handler for the "Re-run LSP" button (`POST /refine`). Should run the
   * accurate analysis and call `update()` itself; the returned object is sent
   * back to the caller. Omit to disable the feature.
   */
  onRefine?: () => Promise<{ ok: boolean; uses?: number; reason?: string }>;
  /**
   * Project root used to serve file source for the "View source" button
   * (`GET /source?path=<project-relative>`). Omit to disable the feature.
   */
  sourceRoot?: string;
  /**
   * Base URL of a built Flutter-Web component catalog (Widgetbook-style). When
   * set, the UI offers a "Live" tab that embeds `<catalogUrl>?widget=<Class>`
   * for faithful, real-engine rendering. Omit to disable.
   */
  catalogUrl?: string;
  /**
   * Base URL of the real app running on Flutter Web. When set, the Live tab for
   * a page node deep-links to `<appUrl>/#<routePath>` — the actual page in the
   * actual app. Omit to disable.
   */
  appUrl?: string;
}

/** Start the server, returning the bound URL + an update handle. */
export async function startServer(
  graph: GraphData,
  webDir: string,
  port = 4567,
  opts: ServerOptions = {},
): Promise<RunningServer> {
  let currentGraph = graph;
  let graphJson = JSON.stringify(graph);
  let revision = 0;
  const clients = new Set<ServerResponse>();
  // Cache mockups by file, keyed on content hash so edits regenerate.
  const previewCache = new Map<string, { hash: string; html: string }>();
  // Project knowledge for resolving custom widgets + theme colors in previews.
  const previewCtx: PreviewContext | undefined = opts.sourceRoot
    ? createPreviewContext(opts.sourceRoot)
    : undefined;

  function emit(event: string, data: string | number): void {
    const payload = `event: ${event}\ndata: ${data}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }
  function broadcast(): void {
    emit('graph', revision);
  }

  // Heartbeat keeps SSE connections from being closed by idle timeouts.
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, 25_000);
  heartbeat.unref?.();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? '/';

    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: graph\ndata: ${revision}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url === '/graph.json' || url.startsWith('/graph.json?')) {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(graphJson);
      return;
    }

    if (url === '/capabilities') {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        refine: !!opts.onRefine,
        export: true,
        source: !!opts.sourceRoot,
        preview: !!opts.sourceRoot,
        catalog: opts.catalogUrl ?? null,
        appUrl: opts.appUrl ?? null,
      }));
      return;
    }

    if (url.startsWith('/preview?')) {
      if (!opts.sourceRoot) {
        res.writeHead(501, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Preview unavailable.');
        return;
      }
      const rel = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('path') ?? '';
      const root = path.resolve(opts.sourceRoot);
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      try {
        const code = await fs.readFile(abs, 'utf8');
        const hash = createHash('sha1').update(code).digest('hex');
        const cached = previewCache.get(rel);
        let html: string;
        if (cached && cached.hash === hash) {
          html = cached.html;
        } else {
          html = renderPreview(rel, code, previewCtx);
          previewCache.set(rel, { hash, html });
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Preview generation failed: ' + (err as Error).message);
      }
      return;
    }

    if (url.startsWith('/source?')) {
      if (!opts.sourceRoot) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('source unavailable');
        return;
      }
      const rel = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('path') ?? '';
      const root = path.resolve(opts.sourceRoot);
      const abs = path.resolve(root, rel);
      // Prevent path traversal outside the project root.
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      try {
        const text = await fs.readFile(abs, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(text);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
      }
      return;
    }

    if (url === '/export.html') {
      try {
        const out = await buildStandaloneHtml(currentGraph, webDir);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="pagemapper.html"',
        });
        res.end(out);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Export failed</h1>');
      }
      return;
    }

    if (url === '/refine') {
      if (!opts.onRefine) {
        res.writeHead(501, { 'Content-Type': MIME['.json'] });
        res.end('{"ok":false,"reason":"unavailable"}');
        return;
      }
      try {
        const result = await opts.onRefine();
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end('{"ok":false,"reason":"error"}');
      }
      return;
    }

    const filePath = resolveStatic(webDir, url);
    if (!filePath) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404 Not Found</h1>');
    }
  };

  // Try ports starting at `port`, incrementing on EADDRINUSE (up to 50 tries).
  for (let p = port; p < port + 50; p++) {
    try {
      const url = await tryListen(handler, p);
      return {
        url,
        update(next: GraphData): void {
          currentGraph = next;
          graphJson = JSON.stringify(next);
          revision++;
          broadcast();
        },
        notifyCatalog(): void {
          emit('catalog', Date.now());
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  throw new Error(`No open port found in range ${port}-${port + 50}`);
}

/** Attempt to listen on a single port; resolve with the URL or reject. */
function tryListen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  port: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}
