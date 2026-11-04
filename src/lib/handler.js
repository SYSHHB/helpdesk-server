'use strict';
/* Turns one web request into one answer. Pure logic, so it can be tested without Azure. */
const { HttpError } = require('./auth');
const { matchSpec, createTicket, importDocs, seedRole, ID_RE } = require('./rules');
const { StoreError } = require('./store');

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

function tokenFrom(headers) {
  const h = {}; Object.keys(headers || {}).forEach(k => { h[k.toLowerCase()] = headers[k]; });
  if (h['x-auth-token']) return String(h['x-auth-token']);
  const a = String(h['authorization'] || '');
  return /^Bearer /i.test(a) ? a.slice(7) : '';
}

async function who(req, deps) {
  const token = tokenFrom(req.headers);
  if (!token) throw new HttpError(401, 'Sign in first');
  const claims = await deps.verifyToken(token);
  const email = claims.email;
  if (email.split('@')[1] !== deps.config.allowedDomain) throw new HttpError(403, 'Only school email addresses are allowed');
  const rec = await deps.store.get('accounts', email);
  const account = rec ? rec.data : null;
  if (account && account.active === false) throw new HttpError(403, 'This account is disabled');
  const role = account ? account.role : (seedRole(email, deps.config) || 'user');
  return { email, role, exists: !!account, account: account || { name: claims.name || email, role, mail: email }, tokenName: claims.name };
}

function parsePath(p) {
  const segs = String(p || '').split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { throw new HttpError(400, 'Bad address'); } });
  segs.forEach(s => { if (!ID_RE.test(s)) throw new HttpError(400, 'Bad address'); });
  return segs;
}

async function handle(req, deps) {
  try {
    const segs = parsePath(req.path);
    if (segs[0] === 'health') return json(200, { ok: true });
    if (req.bodyText && req.bodyText.length > 950000) throw new HttpError(413, 'Too large');
    let body = {};
    if (req.bodyText) { try { body = JSON.parse(req.bodyText); } catch (e) { throw new HttpError(400, 'Bad JSON'); } }

    const user = await who(req, deps);
    const ctx = { user, store: deps.store, config: deps.config, now: (deps.now ? deps.now() : Date.now()) };
    const q = req.query || {};

    if (segs[0] === 'me' && req.method === 'GET') {
      return json(200, { username: user.email, name: user.account.name, role: user.role, exists: user.exists, account: user.exists ? user.account : null });
    }
    if (segs[0] === 'tickets' && segs.length === 1 && req.method === 'POST') {
      const r = await createTicket(ctx, body);
      return json(201, r);
    }
    if (segs[0] === 'admin' && segs[1] === 'import' && segs.length === 2 && req.method === 'POST') {
      return json(200, await importDocs(ctx, body));
    }
    if (segs[0] !== 'db' || segs.length < 2) throw new HttpError(404, 'Not found');

    /* every other request needs a registered account, except registering yourself */
    const parts = segs.slice(1), n = parts.length, isDoc = n % 2 === 0;
    const collPath = (isDoc ? parts.slice(0, -1) : parts).join('/');
    const id = isDoc ? parts[n - 1] : null;
    const selfRegister = req.method === 'PUT' && collPath === 'accounts' && id === user.email;
    const readSettings = req.method === 'GET' && collPath === 'settings';
    if (!user.exists && !selfRegister && !readSettings) throw new HttpError(403, 'Finish your profile first');

    const spec = matchSpec(collPath);
    if (!spec) throw new HttpError(404, 'Not found');
    let out;
    if (!isDoc) {
      if (req.method === 'GET') out = await spec.list(ctx, q);
      else if (req.method === 'POST') out = await spec.add(ctx, body);
      else throw new HttpError(405, 'Method not allowed');
    } else {
      if (req.method === 'GET') out = await spec.get(ctx, id, q);
      else if (req.method === 'PUT') out = await spec.set(ctx, id, body);
      else if (req.method === 'PATCH') out = await spec.update(ctx, id, body);
      else if (req.method === 'DELETE') out = await spec.remove(ctx, id);
      else throw new HttpError(405, 'Method not allowed');
    }
    return json(req.method === 'POST' ? 201 : 200, out);
  } catch (e) {
    if (e instanceof HttpError || e instanceof StoreError) return json(e.status, { error: e.message });
    if (deps.log) deps.log(e);
    return json(500, { error: 'Server error' });
  }
}

module.exports = { handle };
