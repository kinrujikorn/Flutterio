// lsp/client.ts — Minimal JSON-RPC/LSP client over stdio for `dart language-server`.
//
// Speaks the Language Server Protocol with `Content-Length:`-framed JSON-RPC
// messages over a child process's stdin/stdout. Only the subset PageMapper
// needs is implemented: initialize/initialized, documentSymbol, hover,
// references, didOpen, shutdown/exit.
//
// Design notes:
//   - Every request gets a numeric id and a per-request timeout; a timed-out
//     request rejects but leaves the client usable (the late reply is ignored).
//   - Server-initiated requests (e.g. window/workDoneProgress/create,
//     client/registerCapability) are auto-answered with a null result so the
//     server doesn't block waiting on us.
//   - Notifications ($/progress, window/logMessage, ...) are surfaced via the
//     `onNotification` hook so the caller can detect "analysis complete".
//   - Nothing here throws asynchronously into the void: errors reject the
//     pending request or are swallowed; the caller decides policy.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** A JSON-RPC notification delivered by the server. */
export interface LspNotification {
  method: string;
  params: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Convert an absolute filesystem path to a `file://` URI (Windows-aware). */
export function pathToFileUri(absPath: string): string {
  let p = absPath.replace(/\\/g, '/');
  // Encode each path segment but keep the slashes and the drive colon.
  // Windows drive letters become "C:" which must stay literal in the URI.
  const encoded = p
    .split('/')
    .map((seg) =>
      // Keep a leading drive segment like "C:" intact.
      /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg),
    )
    .join('/');
  // Absolute Windows path "C:/..." -> "file:///C:/...".
  if (/^[A-Za-z]:/.test(encoded)) return 'file:///' + encoded;
  // POSIX absolute path "/..." -> "file:///...".
  if (encoded.startsWith('/')) return 'file://' + encoded;
  return 'file:///' + encoded;
}

/** Convert a `file://` URI back to an absolute filesystem path. */
export function fileUriToPath(uri: string): string {
  let u = uri;
  if (u.startsWith('file://')) u = u.slice('file://'.length);
  // After the scheme we may have "/C:/..." (Windows) or "/abs" (POSIX).
  // Decode percent-escapes first.
  u = decodeURIComponent(u);
  if (/^\/[A-Za-z]:/.test(u)) u = u.slice(1); // drop the leading slash before drive
  return u;
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private closed = false;

  /** Notification handler (set by the caller before/after start). */
  onNotification: (n: LspNotification) => void = () => {};
  /** Stderr line handler for diagnostics. */
  onStderr: (line: string) => void = () => {};

  /**
   * Spawn `dart language-server`. On Windows `dart` is resolved via PATH using
   * `shell: true`. Returns false if the process could not be spawned.
   */
  start(): boolean {
    try {
      const proc = spawn('dart', ['language-server', '--client-id', 'pagemapper'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      }) as ChildProcessWithoutNullStreams;
      this.proc = proc;

      proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) this.onStderr(line);
        }
      });
      proc.on('error', () => this.failAll(new Error('language-server process error')));
      proc.on('exit', () => {
        this.closed = true;
        this.failAll(new Error('language-server exited'));
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Reject all in-flight requests (used on process death). */
  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Accumulate stdout and dispatch complete framed messages. */
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Loop while we have at least a full header + declared body.
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        // Malformed header; drop up to the separator and continue.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return; // wait for more
      const body = this.buffer.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + len);
      this.dispatch(body);
    }
  }

  /** Parse and route one JSON-RPC message body. */
  private dispatch(body: string): void {
    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      return;
    }

    // Response to one of our requests.
    if (typeof msg.id === 'number' && (('result' in msg) || ('error' in msg))) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'lsp error'));
      else p.resolve(msg.result);
      return;
    }

    // Server-initiated request: answer with null so the server is not blocked.
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.respond(msg.id, null);
      return;
    }

    // Notification.
    if (typeof msg.method === 'string') {
      this.onNotification({ method: msg.method, params: msg.params });
    }
  }

  /** Write a framed JSON-RPC object to the server's stdin. */
  private write(obj: unknown): void {
    if (!this.proc || this.closed) return;
    const json = JSON.stringify(obj);
    const payload = Buffer.from(json, 'utf8');
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii');
    try {
      this.proc.stdin.write(Buffer.concat([header, payload]));
    } catch {
      // Stdin closed; in-flight requests will time out / be failed on exit.
    }
  }

  /** Send a response to a server-initiated request. */
  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  /** Send a request and resolve with its result, or reject on timeout/error. */
  request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    if (this.closed || !this.proc) {
      return Promise.reject(new Error('language-server not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`lsp request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Gracefully shut down, then kill the child process. Never throws. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      if (!this.closed) {
        await this.request('shutdown', null, 2000).catch(() => {});
        this.notify('exit', null);
      }
    } catch {
      // ignore
    }
    try {
      this.proc.kill();
      // On Windows a tree kill is more reliable for shell-spawned children.
      if (process.platform === 'win32' && this.proc.pid) {
        const { spawn: sp } = await import('node:child_process');
        sp('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], {
          stdio: 'ignore',
        }).on('error', () => {});
      }
    } catch {
      // ignore
    }
    this.closed = true;
    this.proc = null;
    this.failAll(new Error('client stopped'));
  }
}
