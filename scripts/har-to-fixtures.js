#!/usr/bin/env node
// har-to-fixtures.js — Convert a browser DevTools HAR export into the
// `preview_fixtures.json` that the venio web-preview replays (see
// apps/venio_app/lib/preview_mocks.dart).
//
// RECORD (no code needed):
//   1. Run the real app where the backend works (mobile via a proxy, or the
//      web build through a CORS proxy) and log in.
//   2. Open DevTools → Network → navigate the pages you want to preview.
//   3. Right-click the request list → "Save all as HAR with content".
//
// CONVERT:
//   node scripts/har-to-fixtures.js session.har preview_fixtures.json
//   → copy preview_fixtures.json into apps/venio_app/web/ and rebuild the
//     web preview. Pages then render with the recorded data, fully offline.
//
// Keyed by "<METHOD> <pathname>" (query string ignored — matches the adapter).
// Only JSON 2xx responses are kept. REVIEW/SANITIZE the output before sharing:
// it contains whatever real data the recorded session returned.

import fs from 'node:fs';

function main() {
  const [inPath, outPath = 'preview_fixtures.json'] = process.argv.slice(2);
  if (!inPath) {
    console.error('usage: node har-to-fixtures.js <input.har> [output.json]');
    process.exit(1);
  }
  const har = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const entries = har?.log?.entries ?? [];
  const fixtures = {};
  let kept = 0;
  let skipped = 0;

  for (const e of entries) {
    const req = e.request;
    const res = e.response;
    if (!req || !res) continue;
    const status = res.status || 0;
    if (status < 200 || status >= 300) {
      skipped++;
      continue;
    }
    const mime = (res.content?.mimeType || '').toLowerCase();
    const text = res.content?.text;
    if (!mime.includes('json') || !text) {
      skipped++;
      continue;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      skipped++;
      continue; // not parseable JSON — skip rather than store a raw string
    }
    let pathname;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      pathname = req.url.split('?')[0];
    }
    const key = `${(req.method || 'GET').toUpperCase()} ${pathname}`;
    fixtures[key] = { status, body }; // last write wins
    kept++;
  }

  fs.writeFileSync(outPath, JSON.stringify(fixtures, null, 2));
  console.log(
    `wrote ${outPath} — ${Object.keys(fixtures).length} unique endpoints ` +
      `(${kept} JSON responses kept, ${skipped} skipped)`,
  );
}

main();
