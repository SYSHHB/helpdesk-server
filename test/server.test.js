'use strict';
const crypto = require('crypto');
const http = require('http');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeVerifier } = require('../src/lib/auth');
const { loadConfig } = require('../src/lib/config');
const { FileStore } = require('../src/lib/filestore');
const { createServer, buildCsp } = require('../server/index');

const TENANT = '11111111-2222-3333-4444-555555555555', CLIENT = 'aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb';
const ADMIN = 'it.helpdesk@syayasan.edu.bn', ALI = 'ali.hassan@syayasan.edu.bn', SITI = 'siti.aminah@syayasan.edu.bn';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const p = b64({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, scp: 'access_as_user', exp: now + 3600, nbf: now - 10, preferred_username: email, name: email.split('@')[0].replace('.', ' ') });
  return h + '.' + p + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url');
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-srv-'));
const pub = path.join(work, 'public'), data = path.join(work, 'data');
fs.mkdirSync(pub); fs.mkdirSync(data);
fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>Helpdesk</title>');
fs.writeFileSync(path.join(pub, 'config.js'), 'window.HELPDESK_CONFIG={};');
fs.writeFileSync(path.join(pub, 'manifest.json'), '{}');
fs.writeFileSync(path.join(pub, 'icon.png'), Buffer.from([137, 80, 78, 71]));
fs.writeFileSync(path.join(pub, 'notes.bin'), 'binary');
fs.writeFileSync(path.join(pub, '.env'), 'SECRET=1');
fs.writeFileSync(path.join(work, 'secret.txt'), 'TOP-SECRET-OUTSIDE');

const config = loadConfig({ TENANT_ID: TENANT, API_CLIENT_ID: CLIENT, ADMIN_EMAILS: ADMIN });
let server, port;
const start = () => new Promise(res => {
  const deps = { config, store: new FileStore(data), verifyToken: makeVerifier(config, async () => ({ keys: [jwk] })) };
  server = createServer(deps, { publicDir: pub, log: false });
  server.listen(0, '127.0.0.1', () => { port = server.address().port; res(); });
});
const stop = () => new Promise(res => server.close(res));
before(start); after(() => stop());

function raw(method, p, headers, body) {   /* sends the address exactly as written, without tidying it up */
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: headers || {} }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
const api = (method, p, who, body) => raw(method, '/api/' + p, Object.assign({ 'content-type': 'application/json' }, who ? { 'x-auth-token': token(who) } : {}), body === undefined ? undefined : JSON.stringify(body));

test('website files are served with the security headers', async () => {
  const r = await raw('GET', '/');
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /text\/html/); assert.match(r.text, /Helpdesk/);
  assert.match(r.headers['strict-transport-security'], /max-age=31536000/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.match((await raw('GET', '/config.js')).headers['content-type'], /javascript/);
  assert.match((await raw('GET', '/manifest.json')).headers['content-type'], /json/);
  const png = await raw('GET', '/icon.png'); assert.equal(png.headers['content-type'], 'image/png'); assert.match(png.headers['cache-control'], /max-age/);
  assert.equal((await raw('HEAD', '/')).status, 200);
});

test('files outside the website folder and hidden files are never served', async () => {
  for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/..\\secret.txt', '/....//secret.txt', '/.env', '/.git/config', '/server/index.js', '/src/lib/rules.js', '/notes.bin', '/missing.html', '/%00', '/%zz']) {
    const r = await raw('GET', p);
    assert.ok([400, 404].includes(r.status), p + ' -> ' + r.status);
    assert.ok(r.text.indexOf('TOP-SECRET') < 0 && r.text.indexOf('SECRET=1') < 0, p + ' leaked');
  }
  assert.equal((await raw('POST', '/index.html')).status, 405);
  assert.equal((await raw('GET', '/data/docs/tickets/x.json')).status, 404);
});

test('the server answers /api/ through the same rules, and keeps data on disk', async () => {
  assert.equal((await api('GET', 'health')).status, 200);
  const none = await api('GET', 'me'); assert.equal(none.status, 401); assert.equal(none.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse((await api('GET', 'me', ALI)).text).exists, false);
  assert.equal((await api('PUT', 'db/accounts/' + ALI, ALI, { name: 'Ali Hassan Ahmad', dept: 'Primary Teacher', phone: '+6737123456', role: 'admin' })).status, 200);
  assert.equal((await api('PUT', 'db/accounts/' + SITI, SITI, { name: 'Siti Aminah Bakar' })).status, 200);
  assert.equal(JSON.parse((await api('GET', 'me', ALI)).text).role, 'user');
  const t = await api('POST', 'tickets', ALI, { title: 'Projector no signal', description: 'Black screen', category: 'Projector', location: 'Primary - Y7' });
  assert.equal(t.status, 201); const id = JSON.parse(t.text).id; assert.match(id, /^IT-\d{4}-0001$/);
  assert.equal(JSON.parse((await api('GET', 'db/tickets', ALI)).text).docs.length, 1);
  assert.equal(JSON.parse((await api('GET', 'db/tickets', SITI)).text).docs.length, 0);
  assert.equal((await api('GET', 'db/tickets/' + id, SITI)).status, 403);
  assert.equal((await raw('POST', '/api/tickets', { 'x-auth-token': token(ALI) }, 'x'.repeat(1100000)).catch(() => ({ status: 413 }))).status, 413);
  await stop(); await start();                                                  // restart the server: the data is still there
  assert.equal(JSON.parse((await api('GET', 'db/tickets/' + id, ALI)).text).data.title, 'Projector no signal');
  assert.equal((await api('POST', 'tickets', ALI, { title: 'Second', description: 'x', category: 'c', location: 'l' })).status, 201);
  assert.match(JSON.parse((await api('GET', 'db/tickets', ALI)).text).docs.map(d => d.id).sort().pop(), /-0002$/);
});

test('the strict policy is worked out from the real page and covers exactly its own scripts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-csp-'));
  const loader = '(function(){var a=1})();', main = '\n(function(){"use strict";})();\n';
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><script src="config.js"></script><script>' + loader + '</script><script src="https://cdn.jsdelivr.net/x.js"></script><script>' + main + '</script>');
  const csp = buildCsp(dir);
  const h = x => "'sha256-" + crypto.createHash('sha256').update(x, 'utf8').digest('base64') + "'";
  assert.ok(csp.includes(h(loader)) && csp.includes(h(main)));
  assert.equal((csp.match(/sha256-/g) || []).length, 2);                     // only the two inline scripts, nothing else
  assert.ok(csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"));
  assert.ok(!csp.includes("'unsafe-inline' https://cdn") && !/script-src[^;]*unsafe-inline/.test(csp));       // scripts can never be "unsafe-inline"
  assert.equal(buildCsp(path.join(dir, 'nowhere')), null);
  const strict = createServer({ config, store: new FileStore(data), verifyToken: async () => { throw new Error('x'); } }, { publicDir: dir, strictCsp: true, log: false });
  await new Promise(r => strict.listen(0, '127.0.0.1', r));
  const got = await new Promise(r => http.get({ host: '127.0.0.1', port: strict.address().port, path: '/' }, res => { res.resume(); res.on('end', () => r(res.headers['content-security-policy'])); }));
  assert.equal(got, csp);
  await new Promise(r => strict.close(r));
});
