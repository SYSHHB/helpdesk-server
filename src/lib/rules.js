'use strict';
/* WHO MAY DO WHAT. This file is the security boundary of the helpdesk.
   Every request passes through here, and the checks run on the server, not in the browser. */
const { HttpError } = require('./auth');

const ID_RE = /^(?!\.+$)[A-Za-z0-9@._+\-]{1,200}$/;   /* letters, digits and @ . _ + - only; never just dots */
const ROLES = ['admin', 'technician', 'user'];
const IMMUTABLE_TICKET = ['id', 'createdBy', 'createdByName', 'createdByMail', 'createdByPhone', 'createdAt'];
const OWNER_TICKET_FIELDS = ['status', 'updatedAt', 'resolvedAt', 'progress', 'lastActAt', 'lastActBy', 'lastActByName', 'lastActKind', 'lastActText', 'lastActInternal'];
const SELF_ACCOUNT_FIELDS = ['name', 'dept', 'phone', 'mail', 'confirmedAt'];
const USER_EVENTS = ['Complaint submitted', 'Complaint reopened'];

const isStaff = u => u.role === 'technician' || u.role === 'admin';
const isAdmin = u => u.role === 'admin';
const deny = (msg) => { throw new HttpError(403, msg || 'Not allowed'); };
const bad = (msg) => { throw new HttpError(400, msg); };

function str(v, max, name, required) {
  if (v === undefined || v === null || v === '') { if (required) bad(name + ' is required'); return ''; }
  if (typeof v !== 'string') bad(name + ' must be text');
  if (v.length > max) bad(name + ' is too long');
  return v;
}
function plain(obj, maxJson, name) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) bad(name + ' must be an object');
  const j = JSON.stringify(obj);
  if (j.length > maxJson) throw new HttpError(413, name + ' is too large');
  return obj;
}
function pick(obj, keys) { const o = {}; keys.forEach(k => { if (obj[k] !== undefined) o[k] = obj[k]; }); return o; }
function onlyKeys(obj, allowed, who) {
  Object.keys(obj).forEach(k => { if (allowed.indexOf(k) < 0) deny(who + ' cannot change "' + k + '"'); });
}
/* The website sends photos as small records {k, id, n}; plain ids are accepted too. */
function normImages(arr, max) {
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr)) bad('Photos must be a list');
  if (arr.length > (max || 4)) bad('At most 4 photos');
  return arr.map(x => {
    const o = (x && typeof x === 'object') ? x : { id: x };
    const id = String(o.id === undefined ? '' : o.id);
    if (!ID_RE.test(id)) bad('Bad photo id');
    return { k: str(o.k, 8, 'Photo kind') || 'd', id, n: str(o.n, 120, 'Photo name') };
  });
}
const imgIds = arr => (arr || []).map(x => (x && typeof x === 'object') ? x.id : x);
function newId(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function bruneiYear(ts) { return new Date(ts + 8 * 3600e3).getUTCFullYear(); }

function applyQuery(docs, q) {
  q = q || {};
  if (q.orderBy) {
    const [f, dirRaw] = String(q.orderBy).split(',');
    const dir = dirRaw === 'desc' ? -1 : 1;
    docs = docs.slice().sort((a, b) => ((a.data[f] > b.data[f]) - (a.data[f] < b.data[f])) * dir);
  }
  const lim = Math.max(1, Math.min(1000, parseInt(q.limit, 10) || 500));
  return docs.slice(0, lim);
}
const wrap = d => ({ id: d.id, data: d.data });

/* ---------------- accounts ---------------- */
function seedRole(email, config) {
  if ((config.adminEmails || []).indexOf(email) >= 0) return 'admin';
  const s = (config.seedUsers || []).find(x => String(x.email).toLowerCase() === email);
  return s && ROLES.indexOf(s.role) >= 0 ? s.role : null;
}
const accounts = {
  async list(ctx) {
    const all = await ctx.store.list('accounts');
    return { docs: (isStaff(ctx.user) ? all : all.filter(d => d.id === ctx.user.email)).map(wrap) };
  },
  async get(ctx, id) {
    if (id !== ctx.user.email && !isStaff(ctx.user)) deny();
    const r = await ctx.store.get('accounts', id);
    return r ? { exists: true, id, data: r.data } : { exists: false, id };
  },
  async set(ctx, id, body) {
    if (!ID_RE.test(id) || id !== id.toLowerCase()) bad('Bad account id');
    if (id.split('@')[1] !== ctx.config.allowedDomain) deny('Only school email addresses are allowed');
    body = plain(body, 4000, 'Account');
    const existing = await ctx.store.get('accounts', id);
    if (isAdmin(ctx.user) && ctx.user.exists) {
      const role = body.role === undefined ? (existing ? existing.data.role : 'user') : body.role;
      if (ROLES.indexOf(role) < 0) bad('Bad role');
      if (id === ctx.user.email && existing && (role !== existing.data.role || body.active === false)) deny('You cannot change your own role or disable yourself');
      const data = Object.assign({}, existing ? existing.data : {}, pick(body, ['name', 'dept', 'phone', 'mail', 'confirmedAt', 'active', 'createdAt']), { role, username: id });
      data.name = str(data.name, 120, 'Name', true); data.active = data.active !== false;
      if (!data.createdAt) data.createdAt = ctx.now;
      await ctx.store.put('accounts', id, data);
      return { id, data };
    }
    if (id === ctx.user.email && !existing) {            /* first sign-in: the person registers themselves */
      const name = str(body.name, 120, 'Name', true);
      if (name.trim().split(/\s+/).length < 2) bad('Enter your full name');
      const data = {
        username: id, name, role: seedRole(id, ctx.config) || 'user', active: true, createdAt: ctx.now,
        dept: str(body.dept, 80, 'Staff group'), phone: str(body.phone, 30, 'Phone'), mail: str(body.mail, 200, 'Mail') || id,
        confirmedAt: ctx.now
      };
      await ctx.store.create('accounts', id, data);
      return { id, data };
    }
    deny();
  },
  async update(ctx, id, body) {
    body = plain(body, 4000, 'Account');
    const existing = await ctx.store.get('accounts', id);
    if (!existing) throw new HttpError(404, 'No such account');
    if (isAdmin(ctx.user)) {
      onlyKeys(body, SELF_ACCOUNT_FIELDS.concat(['role', 'active']), 'Admin');
      if (body.role !== undefined && ROLES.indexOf(body.role) < 0) bad('Bad role');
      if (id === ctx.user.email && ((body.role !== undefined && body.role !== existing.data.role) || body.active === false)) deny('You cannot change your own role or disable yourself');
    } else {
      if (id !== ctx.user.email) deny();
      onlyKeys(body, SELF_ACCOUNT_FIELDS, 'You');
    }
    ['name', 'dept', 'phone', 'mail'].forEach(k => { if (body[k] !== undefined) str(body[k], k === 'mail' ? 200 : 120, k); });
    const data = Object.assign({}, existing.data, body);
    await ctx.store.put('accounts', id, data, existing.etag);
    return { id, data };
  },
  async remove(ctx, id) {
    if (!isAdmin(ctx.user)) deny();
    if (id === ctx.user.email) deny('You cannot delete yourself');
    await ctx.store.del('accounts', id);
    return { ok: true };
  }
};

/* ---------------- tickets ---------------- */
async function ticketFor(ctx, id) {
  const t = await ctx.store.get('tickets', id);
  if (!t) throw new HttpError(404, 'No such complaint');
  if (!isStaff(ctx.user) && t.data.createdBy !== ctx.user.email) deny();
  return t;
}
const tickets = {
  async list(ctx, q) {
    const all = await ctx.store.list('tickets');
    const mine = isStaff(ctx.user) ? all : all.filter(d => d.data.createdBy === ctx.user.email);
    return { docs: applyQuery(mine, q).map(wrap) };
  },
  async get(ctx, id) {
    try { const t = await ticketFor(ctx, id); return { exists: true, id, data: t.data }; }
    catch (e) { if (e.status === 404) return { exists: false, id }; throw e; }
  },
  async add() { throw new HttpError(405, 'Use POST /api/tickets'); },
  async set(ctx, id, body) {
    if (!isAdmin(ctx.user)) deny();
    body = plain(body, 30000, 'Complaint');
    await ctx.store.put('tickets', id, body);
    return { id, data: body };
  },
  async update(ctx, id, body) {
    body = plain(body, 30000, 'Complaint');
    const t = await ticketFor(ctx, id);
    if (isStaff(ctx.user)) {
      IMMUTABLE_TICKET.forEach(k => { if (body[k] !== undefined && body[k] !== t.data[k]) deny('Nobody can change "' + k + '"'); });
    } else {
      onlyKeys(body, OWNER_TICKET_FIELDS, 'You');
      if (body.status !== undefined) {
        if (body.status !== 'open' || ['resolved', 'closed'].indexOf(t.data.status) < 0) deny('You can only reopen a resolved or closed complaint');
        if (body.progress !== undefined && body.progress !== 0) deny();
        if (body.resolvedAt !== undefined && body.resolvedAt !== null) deny();
      } else if (body.progress !== undefined || body.resolvedAt !== undefined) deny();
    }
    const data = Object.assign({}, t.data, body);
    await ctx.store.put('tickets', id, data, t.etag);
    return { id, data };
  },
  async remove(ctx, id) {
    if (!isAdmin(ctx.user)) deny();
    await ctx.store.del('tickets', id);
    return { ok: true };
  }
};

/* New complaint: the SERVER gives it its number, owner, status and first history line. */
async function createTicket(ctx, body) {
  if (!ctx.user.exists) deny('Finish your profile first');
  body = plain(body, 30000, 'Complaint');
  const title = str(body.title, 200, 'Title', true).trim();
  const description = str(body.description, 5000, 'Details', true).trim();
  const category = str(body.category, 120, 'Category', true);
  const location = str(body.location, 160, 'Location', true);
  const images = normImages(body.images);
  for (const im0 of images) {
    if (im0.k === 'a') continue;                       /* hosted assets are not used on this server */
    const im = await ctx.store.get('images', im0.id);
    if (!im || im.data.uploadedBy !== ctx.user.email) bad('Photo not found');
  }
  const year = bruneiYear(ctx.now);
  const field = year === (ctx.config.legacyYear || 2026) ? 'n' : 'y' + year;
  const acct = ctx.user.account;
  for (let tries = 0; tries < 5; tries++) {
    const n = await ctx.store.increment('settings', 'ticketcounter', field);
    const id = 'IT-' + year + '-' + String(n).padStart(4, '0');
    const data = {
      title, description, category, location, images, priority: 'medium', status: 'open', progress: 0,
      createdBy: ctx.user.email, createdByName: acct.name, createdByMail: acct.mail || ctx.user.email, createdByPhone: acct.phone || '',
      createdAt: ctx.now, updatedAt: ctx.now, assignedTo: null, assignedName: '', due: null,
      lastActAt: ctx.now, lastActBy: ctx.user.email, lastActByName: acct.name, lastActKind: 'created', lastActText: title
    };
    try { await ctx.store.create('tickets', id, data); }
    catch (e) { if (e.status === 409) continue; throw e; }
    await ctx.store.create('tickets/' + id + '/comments', newId('c'), { type: 'event', text: 'Complaint submitted', by: ctx.user.email, byName: acct.name, role: ctx.user.role, ts: ctx.now, internal: false });
    await ctx.store.create('notifs', newId('n'), { ts: ctx.now, to: 'staff', text: 'New complaint ' + id + ' from ' + acct.name + ': ' + title, ticketId: id, kind: 'new', by: ctx.user.email, byName: acct.name });
    await ctx.store.create('audit', newId('a'), { ts: ctx.now, actor: ctx.user.email, actorName: acct.name, role: ctx.user.role, action: 'ticket.create', target: id, detail: title });
    return { id, data };
  }
  throw new HttpError(503, 'Busy, try again');
}

/* ---------------- comments (history lines too) ---------------- */
const commentsFor = (tid) => ({
  async list(ctx, q) {
    await ticketFor(ctx, tid);
    let all = await ctx.store.list('tickets/' + tid + '/comments');
    if (!isStaff(ctx.user)) all = all.filter(d => !d.data.internal);
    return { docs: applyQuery(all, q).map(wrap) };
  },
  async get(ctx, id) {
    await ticketFor(ctx, tid);
    const c = await ctx.store.get('tickets/' + tid + '/comments', id);
    if (!c || (c.data.internal && !isStaff(ctx.user))) return { exists: false, id };
    return { exists: true, id, data: c.data };
  },
  async add(ctx, body) {
    await ticketFor(ctx, tid);
    body = plain(body, 20000, 'Comment');
    const type = body.type === 'event' ? 'event' : 'comment';
    const text = str(body.text, 4000, 'Text');
    const images = normImages(body.images);
    for (const im0 of images) {
      const im = await ctx.store.get('images', im0.id);
      if (!im || (im.data.uploadedBy !== ctx.user.email && !isStaff(ctx.user))) bad('Photo not found');
    }
    if (!text && !images.length) bad('Write something or add a photo');
    let internal = !!body.internal;
    if (!isStaff(ctx.user)) {
      internal = false;
      if (type === 'event' && USER_EVENTS.indexOf(text) < 0) deny('You cannot add that history line');
    }
    const acct = ctx.user.account;
    const data = { type, text, images, internal, by: ctx.user.email, byName: acct.name, role: ctx.user.role, ts: ctx.now };
    if (body.via === 'email' && isStaff(ctx.user)) data.via = 'email';
    const id = newId('c');
    await ctx.store.create('tickets/' + tid + '/comments', id, data);
    return { id, data };
  },
  async set() { deny(); }, async update() { deny(); },
  async remove(ctx, id) { if (!isAdmin(ctx.user)) deny(); await ctx.store.del('tickets/' + tid + '/comments', id); return { ok: true }; }
});

/* ---------------- notifications ---------------- */
const forMe = (u, n) => n.to === u.email || (n.to === 'staff' && isStaff(u)) || (n.to === 'admin' && isAdmin(u));
const notifs = {
  async list(ctx, q) {
    const all = (await ctx.store.list('notifs')).filter(d => forMe(ctx.user, d.data));
    return { docs: applyQuery(all, q).map(wrap) };
  },
  async get(ctx, id) {
    const n = await ctx.store.get('notifs', id);
    return n && forMe(ctx.user, n.data) ? { exists: true, id, data: n.data } : { exists: false, id };
  },
  async add(ctx, body) {
    body = plain(body, 3000, 'Notification');
    const to = str(body.to, 200, 'To', true);
    const text = str(body.text, 500, 'Text', true);
    const ticketId = str(body.ticketId, 200, 'Complaint');
    if (!isStaff(ctx.user)) {
      if (to !== 'staff') deny('You can only notify the helpdesk team');
      if (!ticketId) deny();
      await ticketFor(ctx, ticketId);
    } else if (!(to === 'staff' || to === 'admin' || ID_RE.test(to))) bad('Bad recipient');
    const data = { ts: ctx.now, to, text, ticketId, kind: str(body.kind, 20, 'Kind') || 'info', by: ctx.user.email, byName: ctx.user.account.name };
    const id = newId('n');
    await ctx.store.create('notifs', id, data);
    return { id, data };
  },
  async set() { deny(); }, async update() { deny(); },
  async remove(ctx, id) { if (!isAdmin(ctx.user)) deny(); await ctx.store.del('notifs', id); return { ok: true }; }
};

/* ---------------- audit log ---------------- */
const audit = {
  async list(ctx, q) { if (!isAdmin(ctx.user)) deny(); return { docs: applyQuery(await ctx.store.list('audit'), Object.assign({ orderBy: 'ts,desc' }, q)).map(wrap) }; },
  async get(ctx, id) { if (!isAdmin(ctx.user)) deny(); const a = await ctx.store.get('audit', id); return a ? { exists: true, id, data: a.data } : { exists: false, id }; },
  async add(ctx, body) {
    body = plain(body, 3000, 'Entry');
    const data = {
      ts: ctx.now, actor: ctx.user.email, actorName: ctx.user.account.name, role: ctx.user.role,
      action: str(body.action, 80, 'Action', true), target: str(body.target, 200, 'Target'), detail: str(body.detail, 500, 'Detail')
    };
    const id = newId('a');
    await ctx.store.create('audit', id, data);
    return { id, data };
  },
  async set() { deny(); }, async update() { deny(); }, async remove() { deny(); }
};

/* ---------------- settings (Hijri calendar) ---------------- */
const settings = {
  async list() { deny(); },
  async get(ctx, id) {
    if (id !== 'hijri') deny();
    const s = await ctx.store.get('settings', id);
    return s ? { exists: true, id, data: s.data } : { exists: false, id };
  },
  async add() { deny(); },
  async set(ctx, id, body) {
    if (id !== 'hijri' || !isAdmin(ctx.user)) deny();
    body = plain(body, 20000, 'Settings');
    if (body.adj !== undefined && !(Number.isInteger(body.adj) && body.adj >= -3 && body.adj <= 3)) bad('Bad adjustment');
    if (body.starts !== undefined && (typeof body.starts !== 'object' || body.starts === null || Object.keys(body.starts).length > 400)) bad('Bad month list');
    const data = pick(body, ['adj', 'starts']);
    await ctx.store.put('settings', id, data);
    return { id, data };
  },
  async update(ctx, id, body) {
    const cur = await ctx.store.get('settings', id);
    return settings.set(ctx, id, Object.assign({}, cur ? cur.data : {}, body));
  },
  async remove() { deny(); }
};

/* ---------------- photos ---------------- */
const images = {
  async list() { deny(); },
  async get(ctx, id, q) {
    const im = await ctx.store.get('images', id);
    if (!im) return { exists: false, id };
    let ok = isStaff(ctx.user) || im.data.uploadedBy === ctx.user.email;
    if (!ok && q && q.t) {
      const t = await ctx.store.get('tickets', String(q.t));
      ok = !!t && t.data.createdBy === ctx.user.email && imgIds(t.data.images).indexOf(id) >= 0;
      if (!ok) { /* a photo inside a comment of the person's own complaint */
        const cs = t && t.data.createdBy === ctx.user.email ? await ctx.store.list('tickets/' + String(q.t) + '/comments') : [];
        ok = cs.some(c => !c.data.internal && imgIds(c.data.images).indexOf(id) >= 0);
      }
    }
    if (!ok) deny();
    return { exists: true, id, data: im.data };
  },
  async add() { throw new HttpError(405, 'Use PUT'); },
  async set(ctx, id, body) {
    if (!ctx.user.exists) deny();
    if (!ID_RE.test(id)) bad('Bad photo id');
    body = plain(body, 750000, 'Photo');
    const cur = await ctx.store.get('images', id);
    if (cur && cur.data.uploadedBy !== ctx.user.email && !isStaff(ctx.user)) deny();
    const data = { data: str(body.data, 740000, 'Photo data', true), n: str(body.n, 120, 'Photo name'), uploadedBy: cur ? cur.data.uploadedBy : ctx.user.email, ts: ctx.now };
    await ctx.store.put('images', id, data);
    return { id, ok: true };
  },
  async update() { deny(); },
  async remove(ctx, id) {
    const cur = await ctx.store.get('images', id);
    if (!cur) return { ok: true };
    if (cur.data.uploadedBy !== ctx.user.email && !isStaff(ctx.user)) deny();
    await ctx.store.del('images', id);
    return { ok: true };
  }
};

function matchSpec(collPath) {
  if (collPath === 'accounts') return accounts;
  if (collPath === 'tickets') return tickets;
  if (collPath === 'notifs') return notifs;
  if (collPath === 'audit') return audit;
  if (collPath === 'settings') return settings;
  if (collPath === 'images') return images;
  const m = /^tickets\/([^/]+)\/comments$/.exec(collPath);
  if (m && ID_RE.test(m[1])) return commentsFor(m[1]);
  return null;
}

/* ---------------- one-time import of the old OneDrive files (admins only) ---------------- */
const IMPORT_TOP = ['accounts', 'tickets', 'notifs', 'audit', 'settings', 'images'];
async function importDocs(ctx, body) {
  if (!isAdmin(ctx.user)) deny();
  body = plain(body, 900000, 'Import');
  const docs = body.docs;
  if (!docs || typeof docs !== 'object' || Array.isArray(docs)) bad('Nothing to import');
  let done = 0, skipped = 0;
  for (const path of Object.keys(docs)) {
    const segs = path.split('/');
    if (segs.length < 2 || segs.length % 2 !== 0 || IMPORT_TOP.indexOf(segs[0]) < 0 || !segs.every(x => ID_RE.test(x))) { skipped++; continue; }
    if (segs.length === 4 && segs[2] !== 'comments') { skipped++; continue; }
    if (segs.length > 4) { skipped++; continue; }
    const data = docs[path];
    if (!data || typeof data !== 'object' || Array.isArray(data)) { skipped++; continue; }
    const coll = segs.slice(0, -1).join('/'), id = segs[segs.length - 1];
    if (coll === 'accounts') { if (id !== id.toLowerCase()) { skipped++; continue; } data.username = id; }
    if (coll === 'images') { if (typeof data.data !== 'string') { skipped++; continue; } if (!data.uploadedBy) data.uploadedBy = data.by || ctx.user.email; }
    await ctx.store.put(coll, id, data);
    done++;
  }
  return { imported: done, skipped };
}

module.exports = { matchSpec, createTicket, importDocs, seedRole, ID_RE, isStaff, isAdmin };
