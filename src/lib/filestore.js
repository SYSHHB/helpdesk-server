'use strict';
/* Saves every record as a small file on the server's disk (inside DATA_DIR).
   - One folder per collection, one file per record, written safely (temp file, then rename).
   - Everything is also kept in memory, so reading is fast. Only this one server process writes.
   - To back up: copy the DATA_DIR folder. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { StoreError } = require('./store');

const SAFE = /^(?!\.+$)[A-Za-z0-9@._+\-]{1,200}$/;

class FileStore {
  constructor(dir) {
    this.root = path.resolve(dir);
    this.cache = new Map();     /* collection -> Map(id -> {json, v}) */
    this.loading = new Map();
    this.locks = new Map();
  }
  check(coll, id) {
    const segs = coll.split('/');
    if (!segs.every(s => SAFE.test(s)) || (id !== undefined && !SAFE.test(id))) throw new StoreError(400, 'Bad key');
  }
  isBig(coll) { return coll === 'images'; }
  dirOf(coll) { return this.isBig(coll) ? path.join(this.root, 'images') : path.join(this.root, 'docs', coll.split('/').join('~')); }
  fileOf(coll, id) {
    const f = path.join(this.dirOf(coll), id + '.json');
    if (f.indexOf(this.root + path.sep) !== 0) throw new StoreError(400, 'Bad key');
    return f;
  }
  lock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => {});
    this.locks.set(key, tail);
    tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return p;
  }
  async readFile(file) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async writeFile(file, obj) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
    const fh = await fsp.open(tmp, 'w');
    try { await fh.writeFile(JSON.stringify(obj)); await fh.sync(); } finally { await fh.close(); }
    await fsp.rename(tmp, file);
  }
  async load(coll) {
    if (this.cache.has(coll)) return this.cache.get(coll);
    if (!this.loading.has(coll)) {
      this.loading.set(coll, (async () => {
        const m = new Map();
        let names = [];
        try { names = await fsp.readdir(this.dirOf(coll)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        for (const n of names) {
          if (!n.endsWith('.json')) continue;
          const o = await this.readFile(path.join(this.dirOf(coll), n));
          if (o) m.set(n.slice(0, -5), { json: JSON.stringify(o.data), v: o.v });
        }
        this.cache.set(coll, m); this.loading.delete(coll);
        return m;
      })());
    }
    return this.loading.get(coll);
  }
  async current(coll, id) {
    if (this.isBig(coll)) { const o = await this.readFile(this.fileOf(coll, id)); return o ? { json: JSON.stringify(o.data), v: o.v } : null; }
    return (await this.load(coll)).get(id) || null;
  }
  async save(coll, id, data, v) {
    await this.writeFile(this.fileOf(coll, id), { v, data });
    if (!this.isBig(coll)) (await this.load(coll)).set(id, { json: JSON.stringify(data), v });
  }
  async get(coll, id) {
    this.check(coll, id);
    const c = await this.current(coll, id);
    return c ? { data: JSON.parse(c.json), etag: String(c.v) } : null;
  }
  async list(coll) {
    this.check(coll);
    const m = await this.load(coll);
    return [...m.entries()].map(([id, c]) => ({ id, data: JSON.parse(c.json) }));
  }
  async put(coll, id, data, etag) {
    this.check(coll, id);
    return this.lock(coll + '\u0000' + id, async () => {
      const c = await this.current(coll, id);
      if (etag && (!c || String(c.v) !== String(etag))) throw new StoreError(412, 'Changed by someone else');
      await this.save(coll, id, data, (c ? c.v : 0) + 1);
    });
  }
  async create(coll, id, data) {
    this.check(coll, id);
    return this.lock(coll + '\u0000' + id, async () => {
      if (await this.current(coll, id)) throw new StoreError(409, 'Already exists');
      await this.save(coll, id, data, 1);
    });
  }
  async del(coll, id) {
    this.check(coll, id);
    return this.lock(coll + '\u0000' + id, async () => {
      try { await fsp.unlink(this.fileOf(coll, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!this.isBig(coll)) (await this.load(coll)).delete(id);
    });
  }
  async increment(coll, id, field) {
    this.check(coll, id);
    return this.lock(coll + '\u0000' + id, async () => {
      const c = await this.current(coll, id);
      const data = c ? JSON.parse(c.json) : {};
      data[field] = (data[field] || 0) + 1;
      await this.save(coll, id, data, (c ? c.v : 0) + 1);
      return data[field];
    });
  }
}

module.exports = { FileStore };
