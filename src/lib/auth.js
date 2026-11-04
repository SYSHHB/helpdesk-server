'use strict';
/* Checks the Microsoft sign-in token that the website sends with every request.
   No outside libraries: the signature is checked with Node's own crypto. */
const crypto = require('crypto');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function b64urlToBuf(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function parseJson(buf) { return JSON.parse(buf.toString('utf8')); }

/* fetchKeys() must return the JWKS object: { keys: [ {kid, kty, n, e, ...} ] } */
function makeVerifier(config, fetchKeys) {
  let cache = { at: 0, keys: null };
  async function getKeys(force) {
    if (!force && cache.keys && Date.now() - cache.at < 3600e3) return cache.keys;
    const jwks = await fetchKeys();
    cache = { at: Date.now(), keys: (jwks && jwks.keys) || [] };
    return cache.keys;
  }
  return async function verifyToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new HttpError(401, 'Invalid token');
    let header, claims;
    try { header = parseJson(b64urlToBuf(parts[0])); claims = parseJson(b64urlToBuf(parts[1])); }
    catch (e) { throw new HttpError(401, 'Invalid token'); }
    if (header.alg !== 'RS256') throw new HttpError(401, 'Invalid token');
    let keys = await getKeys(false);
    let jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) { keys = await getKeys(true); jwk = keys.find(k => k.kid === header.kid); }   /* Microsoft rotates keys */
    if (!jwk) throw new HttpError(401, 'Unknown signing key');
    let ok = false;
    try {
      const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), pub, b64urlToBuf(parts[2]));
    } catch (e) { ok = false; }
    if (!ok) throw new HttpError(401, 'Bad signature');
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new HttpError(401, 'Token expired');
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) throw new HttpError(401, 'Token not valid yet');
    const t = String(config.tenantId || '').toLowerCase();
    if (!t || String(claims.tid || '').toLowerCase() !== t) throw new HttpError(401, 'Wrong organisation');
    const issOk = [`https://login.microsoftonline.com/${t}/v2.0`, `https://sts.windows.net/${t}/`];
    if (issOk.indexOf(String(claims.iss || '').toLowerCase()) < 0) throw new HttpError(401, 'Wrong issuer');
    const auds = (config.audiences || []).map(a => String(a).toLowerCase());
    if (auds.indexOf(String(claims.aud || '').toLowerCase()) < 0) throw new HttpError(401, 'Wrong audience');
    const scopes = String(claims.scp || '').split(' ');
    if (scopes.indexOf(config.scope || 'access_as_user') < 0) throw new HttpError(401, 'Missing permission');
    const email = String(claims.preferred_username || claims.upn || claims.email || '').toLowerCase();
    if (!email || email.indexOf('@') < 0) throw new HttpError(401, 'No email in token');
    return { email, name: String(claims.name || ''), oid: String(claims.oid || '') };
  };
}

module.exports = { makeVerifier, HttpError };
