'use strict';
/* Where the data lives.
   - MemoryStore: used by the automatic tests.
   - FileStore (filestore.js): files on the server's disk. */

class StoreError extends Error { constructor(status, message) { super(message); this.status = status; } }

class MemoryStore {
  constructor() { this.m = new Map(); this.v = 0; }
  k(coll, id) { return coll + '\u0000' + id; }
  async get(coll, id) { const r = this.m.get(this.k(coll, id)); return r ? { data: JSON.parse(r.json), etag: r.etag } : null; }
  async list(coll) {
    const out = [];
    for (const [k, r] of this.m) { const [c, id] = k.split('\u0000'); if (c === coll) out.push({ id, data: JSON.parse(r.json) }); }
    return out;
  }
  async put(coll, id, data, etag) {
    const cur = this.m.get(this.k(coll, id));
    if (etag && (!cur || cur.etag !== etag)) throw new StoreError(412, 'Changed by someone else');
    this.m.set(this.k(coll, id), { json: JSON.stringify(data), etag: String(++this.v) });
  }
  async create(coll, id, data) {
    if (this.m.has(this.k(coll, id))) throw new StoreError(409, 'Already exists');
    this.m.set(this.k(coll, id), { json: JSON.stringify(data), etag: String(++this.v) });
  }
  async del(coll, id) { this.m.delete(this.k(coll, id)); }
  async increment(coll, id, field) {
    const cur = await this.get(coll, id);
    const n = ((cur && cur.data[field]) || 0) + 1;
    await this.put(coll, id, Object.assign({}, cur ? cur.data : {}, { [field]: n }));
    return n;
  }
}

module.exports = { MemoryStore, StoreError };
