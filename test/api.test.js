'use strict';
const crypto = require('crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeVerifier } = require('../src/lib/auth');
const { handle } = require('../src/lib/handler');
const { MemoryStore } = require('../src/lib/store');
const { loadConfig } = require('../src/lib/config');

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb';
const ADMIN = 'it.helpdesk@syayasan.edu.bn', TECH = 'zulfa.zaini@syayasan.edu.bn', ALI = 'ali.hassan@syayasan.edu.bn', SITI = 'siti.aminah@syayasan.edu.bn';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function sign(claims, key = privateKey, kid = 'k1') {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid }), p = b64(claims);
  return h + '.' + p + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key).toString('base64url');
}
function claimsFor(email, over) {
  const now = Math.floor(Date.now() / 1000);
  return Object.assign({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, scp: 'access_as_user', exp: now + 3600, nbf: now - 10, preferred_username: email, name: email.split('@')[0].replace('.', ' ') }, over || {});
}

function setup(nowMs) {
  const config = loadConfig({ TENANT_ID: TENANT, API_CLIENT_ID: CLIENT, ADMIN_EMAILS: ADMIN, SEED_USERS: JSON.stringify([{ email: TECH, role: 'technician' }]) });
  const store = new MemoryStore();
  const deps = { config, store, verifyToken: makeVerifier(config, async () => ({ keys: [jwk] })), now: nowMs ? () => nowMs.t : undefined };
  async function call(method, path, opt) {
    opt = opt || {};
    const headers = {};
    const tok = opt.token !== undefined ? opt.token : (opt.as ? sign(claimsFor(opt.as, opt.claims)) : '');
    if (tok) headers['x-auth-token'] = tok;
    const r = await handle({ method, path, query: opt.query || {}, headers, bodyText: opt.body === undefined ? '' : (typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body)) }, deps);
    return { status: r.status, body: JSON.parse(r.body || '{}') };
  }
  return { call, store, deps };
}
const profile = (name, extra) => Object.assign({ name, dept: 'Primary Teacher', phone: '+6737123456' }, extra || {});
async function register(s, email, name) { const r = await s.call('PUT', 'db/accounts/' + email, { as: email, body: profile(name) }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
async function world() {
  const s = setup({ t: Date.UTC(2026, 10, 4, 3, 0) });
  await register(s, ADMIN, 'IT Helpdesk Admin'); await register(s, TECH, 'Zulfa Zaini');
  await register(s, ALI, 'Ali Hassan Ahmad'); await register(s, SITI, 'Siti Aminah Bakar');
  return s;
}
const newTicket = (s, as, title) => s.call('POST', 'tickets', { as, body: { title: title || 'Projector no signal', description: 'Black screen', category: 'Projector', location: 'Primary - Y7' } });

/* ---------- 1. signing in ---------- */
test('requests without a valid Microsoft token are refused', async () => {
  const s = setup();
  assert.equal((await s.call('GET', 'me')).status, 401);
  assert.equal((await s.call('GET', 'me', { token: 'abc.def.ghi' })).status, 401);
  const bads = [
    sign(claimsFor(ALI, { tid: '99999999-0000-0000-0000-000000000000', iss: 'https://login.microsoftonline.com/99999999-0000-0000-0000-000000000000/v2.0' })),   // another school's tenant
    sign(claimsFor(ALI, { exp: Math.floor(Date.now() / 1000) - 3600 })),                                                                                             // expired
    sign(claimsFor(ALI, { aud: 'someone-elses-app' })),                                                                                                                // token for another app
    sign(claimsFor(ALI, { scp: 'User.Read' })),                                                                                                                        // missing helpdesk permission
    sign(claimsFor(ALI), otherKeys.privateKey),                                                                                                                        // forged signature
    sign(claimsFor(ALI), privateKey, 'unknown-kid')
  ];
  for (const t of bads) assert.equal((await s.call('GET', 'me', { token: t })).status, 401);
  const none = sign(claimsFor(ALI)).split('.'); none[2] = 'AAAA';
  assert.equal((await s.call('GET', 'me', { token: none.join('.') })).status, 401);
  assert.equal((await s.call('GET', 'me', { as: 'someone@gmail.com' })).status, 403);   // right tenant claims but not a school address
  assert.equal((await s.call('GET', 'me', { as: ALI })).status, 200);
});

/* ---------- 2. first sign-in ---------- */
test('first sign-in: people can only register themselves, and never as admin', async () => {
  const s = setup();
  let me = (await s.call('GET', 'me', { as: ALI })).body;
  assert.deepEqual([me.exists, me.role], [false, 'user']);
  assert.equal((await s.call('GET', 'db/tickets', { as: ALI })).status, 403);                 // must finish profile first
  assert.equal((await s.call('PUT', 'db/accounts/' + ALI, { as: ALI, body: { name: 'Ali' } })).status, 400);   // one-word name refused
  assert.equal((await s.call('PUT', 'db/accounts/' + SITI, { as: ALI, body: profile('Siti Aminah') })).status, 403);   // cannot register someone else
  const r = await s.call('PUT', 'db/accounts/' + ALI, { as: ALI, body: profile('Ali Hassan Ahmad', { role: 'admin', active: false }) });
  assert.equal(r.status, 200); assert.equal(r.body.data.role, 'user'); assert.equal(r.body.data.active, true);   // asking for admin has no effect
  assert.equal((await s.call('PUT', 'db/accounts/' + ALI, { as: ALI, body: profile('Ali Hassan Ahmad', { role: 'admin' }) })).status, 403);   // cannot overwrite after registering
  assert.equal((await register(setup(), ADMIN, 'IT Helpdesk Admin')).data.role, 'admin');      // listed admin email
  assert.equal((await register(setup(), TECH, 'Zulfa Zaini')).data.role, 'technician');        // seeded technician
});

/* ---------- 3. complaints ---------- */
test('new complaints get a server-made number that restarts each year', async () => {
  const clock = { t: Date.UTC(2026, 10, 4, 3, 0) };
  const s = setup(clock); for (const [e, n] of [[ADMIN, 'IT Helpdesk Admin'], [ALI, 'Ali Hassan Ahmad']]) await register(s, e, n);
  const a = await newTicket(s, ALI), b = await newTicket(s, ALI, 'Printer jam');
  assert.equal(a.status, 201); assert.equal(a.body.id, 'IT-2026-0001'); assert.equal(b.body.id, 'IT-2026-0002');
  assert.equal(a.body.data.status, 'open'); assert.equal(a.body.data.createdBy, ALI); assert.equal(a.body.data.priority, 'medium');
  clock.t = Date.UTC(2026, 11, 31, 15, 59);   // 23:59 in Brunei: still 2026
  assert.equal((await newTicket(s, ALI)).body.id, 'IT-2026-0003');
  clock.t = Date.UTC(2026, 11, 31, 16, 1);    // 00:01 in Brunei on 1 Jan 2027
  assert.equal((await newTicket(s, ALI)).body.id, 'IT-2027-0001');
  assert.equal((await newTicket(s, ALI)).body.id, 'IT-2027-0002');
  const hist = await s.call('GET', 'db/tickets/IT-2026-0001/comments', { as: ALI });
  assert.equal(hist.body.docs[0].data.text, 'Complaint submitted');
  const staffNotifs = (await s.call('GET', 'db/notifs', { as: ADMIN })).body.docs.map(d => d.data.text);
  assert.ok(staffNotifs.some(t => t.startsWith('New complaint IT-2026-0001 from Ali Hassan Ahmad')));
  const log = (await s.call('GET', 'db/audit', { as: ADMIN })).body.docs.map(d => d.data.action);
  assert.ok(log.includes('ticket.create'));
});

test('people cannot see or change each other\'s complaints', async () => {
  const s = await world();
  const t = (await newTicket(s, ALI)).body.id;
  assert.equal((await s.call('GET', 'db/tickets/' + t, { as: SITI })).status, 403);
  assert.equal((await s.call('GET', 'db/tickets', { as: SITI })).body.docs.length, 0);
  assert.equal((await s.call('GET', 'db/tickets', { as: SITI, query: { where: 'createdBy,==,' + ALI } })).body.docs.length, 0);   // asking nicely does not work
  assert.equal((await s.call('PATCH', 'db/tickets/' + t, { as: SITI, body: { updatedAt: 1 } })).status, 403);
  assert.equal((await s.call('DELETE', 'db/tickets/' + t, { as: SITI })).status, 403);
  assert.equal((await s.call('DELETE', 'db/tickets/' + t, { as: ALI })).status, 403);
  assert.equal((await s.call('GET', 'db/tickets', { as: ALI })).body.docs.length, 1);
  assert.equal((await s.call('GET', 'db/tickets', { as: TECH })).body.docs.length, 1);          // technicians see everything
  assert.equal((await s.call('GET', 'db/tickets/' + t + '/comments', { as: SITI })).status, 403);
});

test('a user cannot promote their own complaint; staff can; only the owner can reopen', async () => {
  const s = await world();
  const t = (await newTicket(s, ALI)).body.id;
  for (const body of [{ status: 'closed' }, { status: 'progress' }, { assignedTo: ALI }, { priority: 'urgent' }, { progress: 100 }, { createdBy: SITI }, { due: '2026-12-01' }]) {
    assert.equal((await s.call('PATCH', 'db/tickets/' + t, { as: ALI, body })).status, 403, JSON.stringify(body));
  }
  assert.equal((await s.call('PATCH', 'db/tickets/' + t, { as: ALI, body: { status: 'open', progress: 0 } })).status, 403);   // already open: nothing to reopen
  assert.equal((await s.call('PATCH', 'db/tickets/' + t, { as: TECH, body: { status: 'closed', progress: 100, priority: 'urgent', assignedTo: TECH, assignedName: 'Zulfa Zaini' } })).status, 200);
  assert.equal((await s.call('PATCH', 'db/tickets/' + t, { as: TECH, body: { createdBy: SITI } })).status, 403);              // even staff cannot change the owner
  assert.equal((await s.call('PATCH', 'db/tickets/' + t, { as: SITI, body: { status: 'open', progress: 0 } })).status, 403);
  assert.equal((await s.call('PATCH', 'db/tickets/' + t, { as: ALI, body: { status: 'progress' } })).status, 403);
  assert.equal((await s.call('PATCH', 'db/tickets/' + t, { as: ALI, body: { status: 'open', progress: 0, resolvedAt: null, updatedAt: 5 } })).status, 200);
  assert.equal((await s.call('GET', 'db/tickets/' + t, { as: ALI })).body.data.status, 'open');
  assert.equal((await s.call('DELETE', 'db/tickets/' + t, { as: TECH })).status, 403);           // only admins delete
  assert.equal((await s.call('DELETE', 'db/tickets/' + t, { as: ADMIN })).status, 200);
});

test('comments: internal notes stay with staff, and users cannot forge history', async () => {
  const s = await world();
  const t = (await newTicket(s, ALI)).body.id, path = 'db/tickets/' + t + '/comments';
  const mine = await s.call('POST', path, { as: ALI, body: { type: 'comment', text: 'Still broken', internal: true, by: SITI, byName: 'Siti', role: 'admin', ts: 1 } });
  assert.equal(mine.status, 201); assert.deepEqual([mine.body.data.internal, mine.body.data.by, mine.body.data.role], [false, ALI, 'user']);   // fields forced by the server
  assert.ok(mine.body.data.ts > 1e12);
  assert.equal((await s.call('POST', path, { as: ALI, body: { type: 'event', text: 'Status changed from Open to Closed' } })).status, 403);
  assert.equal((await s.call('POST', path, { as: ALI, body: { type: 'event', text: 'Complaint reopened' } })).status, 201);
  assert.equal((await s.call('POST', path, { as: TECH, body: { type: 'comment', text: 'Check the lamp', internal: true } })).status, 201);
  assert.equal((await s.call('POST', path, { as: TECH, body: { type: 'comment', text: 'We are on it' } })).status, 201);
  const seenByAli = (await s.call('GET', path, { as: ALI })).body.docs.map(d => d.data.text);
  assert.ok(seenByAli.includes('We are on it') && !seenByAli.includes('Check the lamp'));
  assert.ok((await s.call('GET', path, { as: TECH })).body.docs.map(d => d.data.text).includes('Check the lamp'));
  assert.equal((await s.call('POST', path, { as: SITI, body: { text: 'hello' } })).status, 403);
  assert.equal((await s.call('POST', path, { as: ALI, body: { text: '' } })).status, 400);
  assert.equal((await s.call('PATCH', path + '/' + mine.body.id, { as: ALI, body: { text: 'edited' } })).status, 403);
  assert.equal((await s.call('DELETE', path + '/' + mine.body.id, { as: ALI })).status, 403);
});

/* ---------- 4. notifications, audit, accounts, settings, photos ---------- */
test('notifications only reach the people they are for', async () => {
  const s = await world();
  const t = (await newTicket(s, ALI)).body.id;
  assert.equal((await s.call('POST', 'db/notifs', { as: TECH, body: { to: ALI, text: 'Progress: 50%', ticketId: t, kind: 'update' } })).status, 201);
  const ali = (await s.call('GET', 'db/notifs', { as: ALI })).body.docs.map(d => d.data.text);
  assert.deepEqual(ali, ['Progress: 50%']);                                              // Ali does not see the staff-only "New complaint" alert
  assert.equal((await s.call('GET', 'db/notifs', { as: SITI })).body.docs.length, 0);
  assert.ok((await s.call('GET', 'db/notifs', { as: TECH })).body.docs.some(d => d.data.to === 'staff'));
  assert.equal((await s.call('POST', 'db/notifs', { as: ALI, body: { to: 'staff', text: 'Ali commented', ticketId: t } })).status, 201);
  assert.equal((await s.call('POST', 'db/notifs', { as: ALI, body: { to: SITI, text: 'spam', ticketId: t } })).status, 403);
  assert.equal((await s.call('POST', 'db/notifs', { as: ALI, body: { to: 'admin', text: 'spam', ticketId: t } })).status, 403);
  assert.equal((await s.call('POST', 'db/notifs', { as: SITI, body: { to: 'staff', text: 'about Ali', ticketId: t } })).status, 403);
  const forged = (await s.call('POST', 'db/notifs', { as: ALI, body: { to: 'staff', text: 'x', ticketId: t, by: ADMIN, ts: 5 } })).body.data;
  assert.deepEqual([forged.by, forged.ts > 1e12], [ALI, true]);
});

test('audit log: anyone can add a line, only admins can read it', async () => {
  const s = await world();
  const r = await s.call('POST', 'db/audit', { as: ALI, body: { action: 'auth.login', target: ALI, actor: ADMIN, role: 'admin' } });
  assert.equal(r.status, 201); assert.deepEqual([r.body.data.actor, r.body.data.role], [ALI, 'user']);
  assert.equal((await s.call('GET', 'db/audit', { as: ALI })).status, 403);
  assert.equal((await s.call('GET', 'db/audit', { as: TECH })).status, 403);
  assert.ok((await s.call('GET', 'db/audit', { as: ADMIN })).body.docs.length >= 1);
  assert.equal((await s.call('DELETE', 'db/audit/' + r.body.id, { as: ADMIN })).status, 403);   // the log cannot be erased
});

test('accounts: roles can only be changed by admins', async () => {
  const s = await world();
  assert.deepEqual((await s.call('GET', 'db/accounts', { as: ALI })).body.docs.map(d => d.id), [ALI]);
  assert.equal((await s.call('GET', 'db/accounts', { as: TECH })).body.docs.length, 4);
  assert.equal((await s.call('GET', 'db/accounts/' + SITI, { as: ALI })).status, 403);
  assert.equal((await s.call('PATCH', 'db/accounts/' + ALI, { as: ALI, body: { role: 'admin' } })).status, 403);
  assert.equal((await s.call('PATCH', 'db/accounts/' + ALI, { as: ALI, body: { active: true } })).status, 403);
  assert.equal((await s.call('PATCH', 'db/accounts/' + ALI, { as: ALI, body: { phone: '+6737999999', name: 'Ali Hassan bin Ahmad' } })).status, 200);
  assert.equal((await s.call('PATCH', 'db/accounts/' + SITI, { as: ALI, body: { phone: '1' } })).status, 403);
  assert.equal((await s.call('PATCH', 'db/accounts/' + ALI, { as: TECH, body: { role: 'admin' } })).status, 403);      // technicians cannot promote
  assert.equal((await s.call('PATCH', 'db/accounts/' + ALI, { as: ADMIN, body: { role: 'technician' } })).status, 200);
  assert.equal((await s.call('GET', 'me', { as: ALI })).body.role, 'technician');
  assert.equal((await s.call('PATCH', 'db/accounts/' + ADMIN, { as: ADMIN, body: { role: 'user' } })).status, 403);    // no locking yourself out
  assert.equal((await s.call('DELETE', 'db/accounts/' + ADMIN, { as: ADMIN })).status, 403);
  assert.equal((await s.call('PATCH', 'db/accounts/' + SITI, { as: ADMIN, body: { active: false } })).status, 200);
  assert.equal((await s.call('GET', 'me', { as: SITI })).status, 403);                                                    // disabled people are locked out at once
  assert.equal((await s.call('GET', 'db/tickets', { as: SITI })).status, 403);
  assert.equal((await s.call('DELETE', 'db/accounts/' + SITI, { as: TECH })).status, 403);
  assert.equal((await s.call('DELETE', 'db/accounts/' + SITI, { as: ADMIN })).status, 200);
});

test('settings: everyone reads the Hijri calendar, only admins change it; the counter is untouchable', async () => {
  const s = await world();
  assert.equal((await s.call('PUT', 'db/settings/hijri', { as: ADMIN, body: { adj: 0, starts: { '1448-6': '2026-10-12' } } })).status, 200);
  assert.equal((await s.call('GET', 'db/settings/hijri', { as: ALI })).body.data.adj, 0);
  assert.equal((await s.call('PUT', 'db/settings/hijri', { as: ALI, body: { adj: 1 } })).status, 403);
  assert.equal((await s.call('PUT', 'db/settings/hijri', { as: TECH, body: { adj: 1 } })).status, 403);
  assert.equal((await s.call('PUT', 'db/settings/hijri', { as: ADMIN, body: { adj: 5 } })).status, 400);
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((await s.call(m, 'db/settings/ticketcounter', { as: ADMIN, body: { n: 0 } })).status, 403);
});

test('photos: private to the uploader, the complaint owner and staff', async () => {
  const s = await world();
  const pic = { data: 'data:image/jpeg;base64,AAAA' };
  assert.equal((await s.call('PUT', 'db/images/img-1', { as: ALI, body: pic })).status, 200);
  assert.equal((await s.call('GET', 'db/images/img-1', { as: ALI })).status, 200);
  assert.equal((await s.call('GET', 'db/images/img-1', { as: SITI })).status, 403);
  assert.equal((await s.call('GET', 'db/images/img-1', { as: TECH })).status, 200);
  assert.equal((await s.call('PUT', 'db/images/img-1', { as: SITI, body: pic })).status, 403);                // cannot overwrite someone else's photo
  assert.equal((await s.call('DELETE', 'db/images/img-1', { as: SITI })).status, 403);
  const stolen = await s.call('POST', 'tickets', { as: SITI, body: { title: 'x', description: 'y', category: 'c', location: 'l', images: ['img-1'] } });
  assert.equal(stolen.status, 400);                                                                           // cannot attach Ali's photo to Siti's complaint
  const ok = await s.call('POST', 'tickets', { as: ALI, body: { title: 'x', description: 'y', category: 'c', location: 'l', images: ['img-1'] } });
  assert.equal(ok.status, 201);
  assert.equal((await s.call('GET', 'db/images', { as: ALI })).status, 403);                                  // no listing of photos
});

/* ---------- 5. odd requests ---------- */
test('odd requests are refused', async () => {
  const s = await world();
  assert.equal((await s.call('GET', 'db/tickets/..%2F..%2Fsecret', { as: ALI })).status, 400);
  assert.equal((await s.call('GET', 'db/tickets/%2e%2e/comments', { as: ALI })).status, 400);
  assert.equal((await s.call('GET', 'db/secrets', { as: ADMIN })).status, 404);
  assert.equal((await s.call('GET', 'db/outbox', { as: ADMIN })).status, 404);
  assert.equal((await s.call('PUT', 'db/tickets/IT-2026-0099', { as: ALI, body: { createdBy: ALI, status: 'closed' } })).status, 403);   // cannot write a complaint directly
  assert.equal((await s.call('POST', 'db/tickets', { as: ALI, body: { title: 'x' } })).status, 405);
  assert.equal((await s.call('POST', 'tickets', { as: ALI, body: '{not json' })).status, 400);
  assert.equal((await newTicket(s, ALI, 'T'.repeat(500))).status, 400);
  assert.equal((await s.call('POST', 'tickets', { as: ALI, body: { title: 'x', description: 'D'.repeat(6000), category: 'c', location: 'l' } })).status, 400);
  assert.equal((await s.call('POST', 'tickets', { as: ALI, body: 'x'.repeat(960000) })).status, 413);
  assert.equal((await s.call('POST', 'tickets', { as: ALI, body: { title: 'x', description: 'y', category: 'c', location: 'l', images: ['a', 'b', 'c', 'd', 'e'] } })).status, 400);
  assert.equal((await s.call('GET', 'health')).status, 200);
});

/* ---------- 6. photos as the website sends them, and the one-time import ---------- */
test('photos work in the website\'s format {k, id, n}, on complaints and comments', async () => {
  const s = await world();
  const pic = { data: 'data:image/jpeg;base64,AAAA', n: 'projector.jpg' };
  assert.equal((await s.call('PUT', 'db/images/img-9', { as: ALI, body: pic })).status, 200);
  const t = await s.call('POST', 'tickets', { as: ALI, body: { title: 'x', description: 'y', category: 'c', location: 'l', images: [{ k: 'd', id: 'img-9', n: 'projector.jpg' }] } });
  assert.equal(t.status, 201); assert.deepEqual(t.body.data.images, [{ k: 'd', id: 'img-9', n: 'projector.jpg' }]);
  assert.equal((await s.call('GET', 'db/images/img-9', { as: ALI })).status, 200);
  assert.equal((await s.call('GET', 'db/images/img-9', { as: SITI, query: { t: t.body.id } })).status, 403);           // another person cannot use ?t= to peek
  assert.equal((await s.call('POST', 'tickets', { as: SITI, body: { title: 'x', description: 'y', category: 'c', location: 'l', images: [{ k: 'd', id: 'img-9' }] } })).status, 400);
  // a technician adds a photo to a comment; the owner may see it only through their own complaint
  assert.equal((await s.call('PUT', 'db/images/img-10', { as: TECH, body: pic })).status, 200);
  const c = await s.call('POST', 'db/tickets/' + t.body.id + '/comments', { as: TECH, body: { type: 'comment', text: 'Photo of the fix', images: [{ k: 'd', id: 'img-10', n: 'fix.jpg' }] } });
  assert.equal(c.status, 201);
  assert.equal((await s.call('GET', 'db/images/img-10', { as: ALI })).status, 403);
  assert.equal((await s.call('GET', 'db/images/img-10', { as: ALI, query: { t: t.body.id } })).status, 200);
  assert.equal((await s.call('GET', 'db/images/img-10', { as: SITI, query: { t: t.body.id } })).status, 403);
  const internal = await s.call('POST', 'db/tickets/' + t.body.id + '/comments', { as: TECH, body: { type: 'comment', text: 'private', internal: true, images: [{ k: 'd', id: 'img-10', n: 'x' }] } });
  assert.equal(internal.status, 201);
  assert.equal((await s.call('POST', 'tickets', { as: ALI, body: { title: 'x', description: 'y', category: 'c', location: 'l', images: [{ k: 'd', id: '../x' }] } })).status, 400);
});

test('only an admin can import the old data, and it keeps the old numbers and the counter', async () => {
  const s = await world();
  const docs = {
    'accounts/old.person@syayasan.edu.bn': { name: 'Old Person', role: 'technician', active: true, createdAt: 1 },
    'tickets/SYSHHB-IT-0013': { title: 'Mouse Rusak', createdBy: ALI, createdByName: 'Ali Hassan Ahmad', status: 'closed', createdAt: 1793000000000, images: [] },
    'tickets/SYSHHB-IT-0013/comments/c-old': { type: 'comment', text: 'Replaced', by: TECH, byName: 'Zulfa Zaini', role: 'technician', ts: 5, internal: false },
    'notifs/n-old': { ts: 6, to: 'staff', text: 'old', ticketId: 'SYSHHB-IT-0013' },
    'audit/a-old': { ts: 7, actor: TECH, action: 'ticket.update', target: 'SYSHHB-IT-0013', detail: '' },
    'settings/hijri': { adj: 0, starts: {} },
    'settings/ticketcounter': { n: 14 },
    'images/img-old': { data: 'data:image/png;base64,AAAA', by: ALI },
    '../etc/passwd': { x: 1 }, 'secrets/x': { x: 1 }, 'tickets/a/b/c/d/e': { x: 1 }, 'tickets/SYSHHB-IT-0014/other/x': { x: 1 }
  };
  for (const who of [ALI, TECH]) assert.equal((await s.call('POST', 'admin/import', { as: who, body: { docs } })).status, 403);
  assert.equal((await s.call('POST', 'admin/import', { body: { docs } })).status, 401);
  const r = await s.call('POST', 'admin/import', { as: ADMIN, body: { docs } });
  assert.deepEqual([r.status, r.body.imported, r.body.skipped], [200, 8, 4]);
  assert.equal((await s.call('GET', 'db/tickets/SYSHHB-IT-0013', { as: ALI })).body.data.title, 'Mouse Rusak');          // old number kept
  assert.equal((await s.call('GET', 'db/tickets/SYSHHB-IT-0013', { as: SITI })).status, 403);
  assert.equal((await s.call('GET', 'db/tickets/SYSHHB-IT-0013/comments', { as: ALI })).body.docs[0].data.text, 'Replaced');
  assert.equal((await s.call('GET', 'db/images/img-old', { as: TECH })).body.data.uploadedBy, ALI);
  const next = await s.call('POST', 'tickets', { as: ALI, body: { title: 'New', description: 'x', category: 'c', location: 'l' } });
  assert.equal(next.body.id, 'IT-2026-0015');                                                                              // numbering continues after the old counter
  assert.equal((await s.call('GET', 'me', { as: 'old.person@syayasan.edu.bn' })).body.role, 'technician');                  // imported accounts keep their roles
});
