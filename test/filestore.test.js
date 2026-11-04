'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { FileStore } = require('../src/lib/filestore');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hd-store-'));

test('records survive a restart', async () => {
  const dir = tmp();
  const a = new FileStore(dir);
  await a.create('tickets', 'IT-2026-0001', { title: 'Projector' });
  await a.create('tickets/IT-2026-0001/comments', 'c1', { text: 'hello' });
  await a.put('images', 'img-1', { data: 'AAAA', uploadedBy: 'x' });
  await a.increment('settings', 'ticketcounter', 'n'); await a.increment('settings', 'ticketcounter', 'n');
  const b = new FileStore(dir);                                        // a brand new process reading the same folder
  assert.equal((await b.get('tickets', 'IT-2026-0001')).data.title, 'Projector');
  assert.deepEqual((await b.list('tickets/IT-2026-0001/comments')).map(d => d.data.text), ['hello']);
  assert.equal((await b.get('images', 'img-1')).data.data, 'AAAA');
  assert.equal(await b.increment('settings', 'ticketcounter', 'n'), 3);
  assert.equal(await b.get('tickets', 'nope'), null);
});

test('changes by two people at once do not overwrite each other', async () => {
  const s = new FileStore(tmp());
  await s.create('tickets', 't', { n: 0 });
  const first = await s.get('tickets', 't');
  await s.put('tickets', 't', { n: 1 }, first.etag);
  await assert.rejects(() => s.put('tickets', 't', { n: 2 }, first.etag), { status: 412 });      // stale copy refused
  await assert.rejects(() => s.create('tickets', 't', {}), { status: 409 });
  assert.equal((await s.get('tickets', 't')).data.n, 1);
});

test('counter gives every caller a different number even when 60 ask together', async () => {
  const s = new FileStore(tmp());
  const nums = await Promise.all(Array.from({ length: 60 }, () => s.increment('settings', 'ticketcounter', 'n')));
  assert.deepEqual([...nums].sort((a, b) => a - b), Array.from({ length: 60 }, (_, i) => i + 1));
  assert.equal(new Set(nums).size, 60);
});

test('delete works and unsafe names are refused', async () => {
  const dir = tmp(), s = new FileStore(dir);
  await s.create('notifs', 'n1', { x: 1 }); await s.del('notifs', 'n1');
  assert.equal(await s.get('notifs', 'n1'), null); assert.equal((await s.list('notifs')).length, 0);
  await s.del('notifs', 'never-existed');
  for (const [c, id] of [['tickets', '..'], ['tickets', '../x'], ['../etc', 'passwd'], ['tickets', 'a/b'], ['tickets/../x', 'y']]) {
    await assert.rejects(() => s.get(c, id), { status: 400 });
    await assert.rejects(() => s.put(c, id, {}), { status: 400 });
  }
  assert.deepEqual(fs.readdirSync(dir).filter(n => n !== 'docs'), []);                              // nothing written outside docs/
});

test('a half-written file from a crash is never used', async () => {
  const dir = tmp(), s = new FileStore(dir);
  await s.create('tickets', 'a', { ok: 1 });
  fs.writeFileSync(path.join(dir, 'docs', 'tickets', 'b.json.tmp-123456'), '{"v":1,"data":{"broken":');
  const fresh = new FileStore(dir);
  assert.deepEqual((await fresh.list('tickets')).map(d => d.id), ['a']);
});
