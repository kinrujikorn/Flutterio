// preview-middleware.js
// Shared-password (HTTP Basic Auth) gate for the deployed venio Live preview.
//
// Runs as a Vercel Edge Middleware on EVERY request (HTML + assets +
// preview_fixtures.json), so nothing is reachable without the password — not
// even the bundle or the recorded data.
//
// Setup (one-time, in your Vercel project):
//   vercel env add PREVIEW_PASS production     # the shared password
//   vercel env add PREVIEW_USER production      # optional; defaults to "venio"
// then redeploy. If PREVIEW_PASS is unset the site stays OPEN (so a misconfig
// can't silently lock everyone out) — set it to actually enable the gate.
//
// `build-venio-preview.ps1` copies this file into build/web as `middleware.js`
// after each Flutter build, so a redeploy keeps the gate.

export const config = {
  // Protect everything except Vercel's own internals.
  matcher: '/((?!_vercel|.well-known).*)',
};

export default function middleware(request) {
  const PASS = process.env.PREVIEW_PASS;
  if (!PASS) return; // not configured → allow through (fail-open by design)

  const USER = process.env.PREVIEW_USER || 'venio';
  const header = request.headers.get('authorization') || '';
  const space = header.indexOf(' ');
  const scheme = space === -1 ? '' : header.slice(0, space);
  const encoded = space === -1 ? '' : header.slice(space + 1);

  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = atob(encoded); } catch (_) { decoded = ''; }
    const sep = decoded.indexOf(':');
    if (sep !== -1) {
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (user === USER && pass === PASS) return; // authorized → continue
    }
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="PageMapper Live preview", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
