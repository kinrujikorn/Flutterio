// git.ts — Mine git history for per-file churn + temporal (co-change) coupling.
//
// One `git log` invocation produces, per commit, its author/date + the list of
// changed files. From that we derive:
//   - churn: how many commits touched each file (+ distinct authors, last date)
//   - co-change: how often two files changed in the SAME commit (temporal
//     coupling — a hidden dependency the import graph can't see)
//
// Only files present in the scanned set are counted, so deleted/renamed-away and
// non-Dart paths drop out. Returns null when the project isn't a git repo or git
// isn't on PATH (callers fall back to no history overlay).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChurnInfo, CoChangePair, GitInsightData, ScannedFile } from './types.js';

const execFileAsync = promisify(execFile);

export interface GitOptions {
  /** Max commits to inspect. Default 800. */
  commits?: number;
  /** Only commits newer than this many days. Default 540 (~18 months). */
  sinceDays?: number;
  /** Skip commits touching more than this many scanned files (mega-commits /
   *  sweeping refactors create spurious co-change). Default 40. */
  maxFilesPerCommit?: number;
  /** Minimum commits a pair must co-change to be recorded. Default 3. */
  minTogether?: number;
}

// Field/record separators chosen to never appear in commit metadata or paths.
const REC = '\x01'; // precedes each commit header
const FS = '\x1f'; // between header fields

/**
 * Run `git log` once and derive churn + co-change for the scanned files.
 * Resolves to null when git is unavailable or the dir isn't a repo.
 */
export async function collectGit(
  projectRoot: string,
  files: ScannedFile[],
  opts: GitOptions = {},
): Promise<GitInsightData | null> {
  const commits = opts.commits ?? 800;
  const sinceDays = opts.sinceDays ?? 540;
  const maxFiles = opts.maxFilesPerCommit ?? 40;
  const minTogether = opts.minTogether ?? 3;

  // Membership set — only count files that ended up in the graph.
  const known = new Set(files.map((f) => f.relPath));
  if (!known.size) return { churn: [], coChange: [], commitsScanned: 0 };

  let stdout: string;
  try {
    const res = await execFileAsync(
      'git',
      [
        'log',
        '-n', String(commits),
        `--since=${sinceDays} days ago`,
        '--no-merges',
        '--name-only',
        `--pretty=format:${REC}%H${FS}%an${FS}%aI`,
      ],
      { cwd: projectRoot, maxBuffer: 96 * 1024 * 1024, windowsHide: true },
    );
    stdout = res.stdout;
  } catch {
    return null; // not a repo / git not installed / detached weirdness
  }

  const churnMap = new Map<string, { commits: number; authors: Set<string>; last?: string }>();
  const pairCount = new Map<string, number>();
  let commitsScanned = 0;

  for (const rec of stdout.split(REC)) {
    if (!rec.trim()) continue;
    const nl = rec.indexOf('\n');
    const header = nl === -1 ? rec : rec.slice(0, nl);
    const body = nl === -1 ? '' : rec.slice(nl + 1);
    const parts = header.split(FS); // [hash, author, dateISO]
    const author = parts[1] ?? '';
    const dateISO = parts[2] ?? '';
    commitsScanned++;

    const changed: string[] = [];
    for (const line of body.split('\n')) {
      const g = line.trim();
      if (!g) continue;
      const rel = gitPathToRel(g);
      if (known.has(rel)) changed.push(rel);
    }
    if (!changed.length) continue;

    const uniq = Array.from(new Set(changed));

    // churn — newest-first log means the first time we see a file is its latest change.
    for (const rel of uniq) {
      let c = churnMap.get(rel);
      if (!c) {
        c = { commits: 0, authors: new Set() };
        churnMap.set(rel, c);
      }
      c.commits++;
      if (author) c.authors.add(author);
      if (!c.last && dateISO) c.last = dateISO;
    }

    // co-change — skip mega-commits that would couple everything to everything.
    if (uniq.length >= 2 && uniq.length <= maxFiles) {
      uniq.sort();
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const key = uniq[i] + '\x00' + uniq[j];
          pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const churn: ChurnInfo[] = [];
  for (const [relPath, c] of churnMap) {
    const info: ChurnInfo = { relPath, commits: c.commits, authors: c.authors.size };
    if (c.last) info.lastChange = c.last;
    churn.push(info);
  }
  churn.sort((a, b) => b.commits - a.commits || a.relPath.localeCompare(b.relPath));

  const coChange: CoChangePair[] = [];
  for (const [key, together] of pairCount) {
    if (together < minTogether) continue;
    const i = key.indexOf('\x00');
    const a = key.slice(0, i);
    const b = key.slice(i + 1);
    const ca = churnMap.get(a)?.commits ?? 0;
    const cb = churnMap.get(b)?.commits ?? 0;
    const union = ca + cb - together; // commits touching either file
    const support = union > 0 ? together / union : 0;
    coChange.push({ a, b, together, support: Math.round(support * 100) / 100 });
  }
  coChange.sort((x, y) => y.together - x.together || y.support - x.support);

  return { churn, coChange, commitsScanned };
}

/**
 * Normalize a path from `git log --name-only` to project-relative POSIX. Git
 * quotes paths containing special bytes (e.g. "\\303\\251.dart"); do a
 * best-effort unquote, then swap separators.
 */
function gitPathToRel(g: string): string {
  let p = g;
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    p = p
      .slice(1, -1)
      // A run of octal escapes is the UTF-8 byte sequence of one or more chars —
      // decode the whole run as UTF-8, not byte-by-byte (which would mojibake
      // multi-byte names: Thai, CJK, accented filenames).
      .replace(/(?:\\[0-7]{3})+/g, (m) => {
        const bytes = (m.match(/[0-7]{3}/g) ?? []).map((o) => parseInt(o, 8));
        return Buffer.from(bytes).toString('utf8');
      })
      .replace(/\\(.)/g, '$1');
  }
  return p.split('\\').join('/');
}
