'use strict';
/* One small web server: it shows the website (public/ folder) and answers /api/. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('../src/lib/handler');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};
const SECURITY = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin'
};
const BODY_LIMIT = 1000000;

/* Builds the strict Content-Security-Policy header from the real index.html:
   the page may run only its own two inline scripts (fingerprints worked out here), the Microsoft
   sign-in library, and talk to this server and Microsoft. Anything injected is refused. */
function buildCsp(publicDir) {
  let html = '';
  try { html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'); } catch (e) { return null; }
  const crypto = require('crypto');
  const hashes = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] && /\ssrc\s*=/.test(m[1])) continue;                         /* external scripts: allowed by address instead */
    hashes.push("'sha256-" + crypto.createHash('sha256').update(m[2], 'utf8').digest('base64') + "'");
  }
  return [
    "default-src 'none'",
    "script-src 'self' " + hashes.join(' ') + " https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://graph.microsoft.com https://login.microsoftonline.com https://cdn.jsdelivr.net",
    "frame-src https://login.microsoftonline.com",
    "worker-src 'self'", "manifest-src 'self'", "base-uri 'self'",
    "form-action 'self' https://login.microsoftonline.com",
    "object-src 'none'", "frame-ancestors 'none'"
  ].join('; ');
}

function createServer(deps, opts) {
  opts = opts || {};
  const publicDir = path.resolve(opts.publicDir || path.join(__dirname, '..', 'public'));
  const basic = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
  const csp = opts.csp === 'off' ? basic : (opts.csp || (opts.strictCsp ? buildCsp(publicDir) : null) || basic);
  const headersFor = extra => Object.assign({}, SECURITY, { 'Content-Security-Policy': csp }, extra || {});

  function send(res, status, headers, body) { res.writeHead(status, headersFor(headers)); res.end(body); }
  const plain = (res, status, text) => send(res, status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, text);

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', c => { n += c.length; if (n > BODY_LIMIT) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function api(req, res, url) {
    let bodyText = '';
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
      try { bodyText = await readBody(req); } catch (e) { return send(res, e.status || 400, { 'content-type': 'application/json' }, JSON.stringify({ error: e.status === 413 ? 'Too large' : 'Bad request' })); }
    }
    const query = {}; url.searchParams.forEach((v, k) => { query[k] = v; });
    const r = await handle({ method: req.method, path: url.pathname.replace(/^\/api\/?/, ''), query, headers: req.headers, bodyText }, deps);
    send(res, r.status, r.headers, r.body);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (e) { return plain(res, 400, 'Bad address'); }
    if (p.indexOf('\0') >= 0 || p.split('/').some(s => s === '..' || (s.startsWith('.') && s.length > 0))) return plain(res, 404, 'Not found');
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(publicDir, p);
    if (file.indexOf(publicDir + path.sep) !== 0) return plain(res, 404, 'Not found');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return plain(res, 404, 'Not found');
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext];
      if (!type) return plain(res, 404, 'Not found');
      const cache = /\.(png|svg|ico)$/.test(ext) ? 'public, max-age=86400' : 'no-cache';
      res.writeHead(200, headersFor({ 'content-type': type, 'content-length': st.size, 'cache-control': cache, 'last-modified': st.mtime.toUTCString() }));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  return http.createServer((req, res) => {
    const t0 = Date.now();
    res.on('finish', () => { if (opts.log !== false) console.log(req.method, String(req.url).split('?')[0], res.statusCode, (Date.now() - t0) + 'ms'); });
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return plain(res, 400, 'Bad address'); }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return api(req, res, url).catch(e => { console.error(e); if (!res.headersSent) plain(res, 500, 'Server error'); });
    }
    serveStatic(req, res, url);
  });
}

module.exports = { createServer, buildCsp };

if (require.main === module) {
  const { loadConfig, fetchJwks } = require('../src/lib/config');
  const { makeVerifier } = require('../src/lib/auth');
  const { FileStore } = require('../src/lib/filestore');
  const config = loadConfig(process.env);
  if (!config.tenantId || !config.audiences.length) { console.error('Set TENANT_ID and API_CLIENT_ID in the environment variables.'); process.exit(1); }
  const store = new FileStore(process.env.DATA_DIR || '/data');
  /* JWKS_FILE is only for automatic tests: it replaces the call to Microsoft for signing keys. Never set it on the real server. */
  const keys = process.env.JWKS_FILE ? () => Promise.resolve(JSON.parse(fs.readFileSync(process.env.JWKS_FILE, 'utf8'))) : fetchJwks(config.tenantId);
  const deps = { config, store, verifyToken: makeVerifier(config, keys), log: e => console.error(e) };
  const server = createServer(deps, { publicDir: process.env.PUBLIC_DIR, csp: process.env.CSP_HEADER || undefined, strictCsp: true });
  const port = parseInt(process.env.PORT || '3000', 10);
  server.listen(port, '0.0.0.0', () => console.log('SYSHHB helpdesk listening on port ' + port));
  const stop = () => { console.log('Stopping'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
