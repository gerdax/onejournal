'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServerCore, defaultDocument } = require('../server-core.js');
const { createStore } = require('../state.js');
const { createStore: createCloudStore } = require('../cloud-store.js');

const full = fs.readFileSync(path.join(__dirname, 'fixtures/map-1024.jpg'));
const thumb = fs.readFileSync(path.join(__dirname, 'fixtures/map-384.jpg'));
const dataUrl = bytes => 'data:image/jpeg;base64,' + bytes.toString('base64');
const imageId = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const upload = { action: 'mapUpload', id: 'map-one', name: 'Moria', dataUrl: dataUrl(full), thumbnailDataUrl: dataUrl(thumb) };

function fixture(blobs = new Map()) {
  let doc = defaultDocument();
  doc.links.push({ id: 'gm-link', role: 'gm', heroId: null, secretHash: 'gm', encryptedSecret: 'gm', version: 1, active: true });
  doc.grants.push({ uid: 'gm', linkId: 'gm-link', version: 1, role: 'gm', heroId: null, active: true });
  const core = createServerCore({
    repository: { get: async () => structuredClone(doc), compareAndSwap: async (revision, next) => {
      if (doc.revision !== revision) return false;
      doc = structuredClone(next); return true;
    } },
    mapStorage: { get: async id => blobs.get(id) || null, put: async (id, image) => { blobs.set(id, image); } },
    hashSecret: value => crypto.createHash('sha256').update(value).digest('hex'),
    randomSecret: () => 'long-secret-for-player-link-12345678', encryptSecret: x => x, decryptSecret: x => x
  });
  return { core, blobs, get doc() { return doc; } };
}
async function player(f) {
  const hero = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'Ala' }] })).result;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: hero.id });
  await f.core.handle('player', { action: 'exchange', secret: link.secret });
  return hero;
}

test('private library, idempotent upload, active image access and retained deletion', async () => {
  const f = fixture(); await player(f);
  const playerBefore = await f.core.handle('player', { action: 'snapshot' });
  const first = await f.core.handle('gm', upload);
  assert.equal(first.result.imageId, imageId(full));
  assert.equal(first.result.thumbnailId, imageId(thumb));
  assert.equal(first.result.uploadedAt.length > 10, true);
  assert.equal(f.doc.publicRevision, playerBefore.revision);
  assert.deepEqual((await f.core.handle('gm', upload)).result, first.result);
  assert.equal(f.doc.state.mapLibrary.length, 1);
  await assert.rejects(f.core.handle('gm', { ...upload, name: 'Other' }), { status: 409 });
  await assert.rejects(f.core.handle('player', upload), { status: 403 });
  await assert.rejects(f.core.handle('player', { action: 'mapGet', imageId: first.result.imageId }), { status: 409 });
  await assert.rejects(f.core.handle('player', { action: 'mapGet', imageId: first.result.thumbnailId }), { status: 409 });
  assert.equal((await f.core.handle('gm', { action: 'mapGet', imageId: first.result.thumbnailId })).dataUrl, upload.thumbnailDataUrl);
  await f.core.handle('gm', { action: 'command', method: 'loadMap', args: [upload.id] });
  const active = await f.core.handle('player', { action: 'snapshot' });
  assert.deepEqual(active.state.map, { kind: 'image', imageId: first.result.imageId, width: 1200, height: 1200, positions: {} });
  assert.equal(active.state.mapLibrary, undefined);
  assert.equal(JSON.stringify(active).includes('Moria'), false);
  assert.equal((await f.core.handle('player', { action: 'mapGet', imageId: first.result.imageId })).dataUrl, upload.dataUrl);
  await f.core.handle('gm', { action: 'command', method: 'removeMap', args: [upload.id] });
  assert.equal(f.doc.state.mapLibrary.length, 0);
  assert.equal(f.doc.state.map.imageId, first.result.imageId);
  assert.equal((await f.core.handle('player', { action: 'mapGet', imageId: first.result.imageId })).dataUrl, upload.dataUrl);
  await assert.rejects(f.core.handle('gm', { action: 'command', method: 'loadMap', args: [upload.id] }), { status: 400 });
});

test('a queued image read after map switch conflicts without revoking the player session', async () => {
  const f = fixture(), hero = await player(f);
  const record = (await f.core.handle('gm', upload)).result;
  await f.core.handle('gm', { action: 'command', method: 'loadMap', args: [record.id] });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = createCloudStore({ request: async body => {
    if (body.action === 'mapGet') { entered(); await gate; }
    return f.core.handle('player', body);
  } });
  await store.connect();
  const pending = store.getMapImage(record.imageId);
  await started;
  await f.core.handle('gm', { action: 'command', method: 'setMap', args: [null] });
  release();
  await assert.rejects(pending, { status: 409 });
  assert.equal(store.connection, 'online');
  assert.equal(store.canWrite, true);
  assert.equal(store.getState().map, null);
  await store.refresh();
  assert.equal(store.connection, 'online');
  await f.core.handle('gm', { action: 'revokeLink', heroId: hero.id });
  await assert.rejects(f.core.handle('player', { action: 'mapGet', imageId: record.imageId }), { status: 403 });
});

test('rejects malformed bytes and unauthorized image references', async () => {
  const f = fixture(); await player(f);
  const malformed = Buffer.from(full); malformed[0] = 0;
  for (const request of [
    { ...upload, dataUrl: dataUrl(malformed) },
    { ...upload, thumbnailDataUrl: dataUrl(full) },
    { ...upload, dataUrl: dataUrl(Buffer.alloc(2 * 1024 * 1024 + 1)) }
  ]) await assert.rejects(f.core.handle('gm', request), { status: 400 });
  assert.equal(f.blobs.size, 0);
  const map = { kind: 'image', imageId: imageId(full), width: 1200, height: 1200, positions: {} };
  await assert.rejects(f.core.handle('gm', { action: 'command', method: 'setMap', args: [map] }), { status: 400 });
  await f.core.handle('gm', upload);
  await assert.rejects(f.core.handle('gm', { action: 'command', method: 'setMap', args: [{ ...map, imageId: imageId(thumb) }] }), { status: 400 });
  await assert.rejects(f.core.handle('player', { action: 'mapStage', dataUrl: upload.dataUrl }), { status: 403 });
  await assert.rejects(f.core.handle('player', { action: 'command', method: 'loadMap', args: ['map-one'] }), { status: 403 });
});

test('portable backup stages all refs, validates before restore, and retains old library for legacy backup', async () => {
  const source = fixture();
  await source.core.handle('gm', upload);
  await source.core.handle('gm', { action: 'command', method: 'loadMap', args: [upload.id] });
  const backup = await source.core.handle('gm', { action: 'export' });
  assert.deepEqual(Object.keys(backup.maps).sort(), [imageId(full), imageId(thumb)].sort());
  const dest = fixture();
  const staged = structuredClone(backup);
  for (const [id, bytes] of Object.entries(staged.maps)) {
    assert.deepEqual(await dest.core.handle('gm', { action: 'mapStage', dataUrl: bytes, thumbnail: id === imageId(thumb) }), { imageId: id });
    staged.maps[id] = null;
  }
  const before = structuredClone(dest.doc.state);
  await assert.rejects(dest.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [{ ...staged, maps: { [imageId(full)]: null } }] }), { status: 400 });
  assert.deepEqual(dest.doc.state, before);
  const wrongRole = structuredClone(staged);
  wrongRole.state.mapLibrary[0].thumbnailId = imageId(full);
  delete wrongRole.maps[imageId(thumb)];
  await assert.rejects(dest.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [wrongRole] }), { status: 400 });
  assert.deepEqual(dest.doc.state, before);
  dest.blobs.delete(imageId(thumb));
  await assert.rejects(dest.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [staged] }), { status: 400 });
  assert.deepEqual(dest.doc.state, before);
  await dest.core.handle('gm', { action: 'mapStage', dataUrl: upload.thumbnailDataUrl, thumbnail: true });
  await dest.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [staged] });
  assert.equal(dest.doc.state.mapLibrary[0].name, 'Moria');
  assert.equal((await dest.core.handle('gm', { action: 'mapGet', imageId: imageId(full) })).dataUrl, upload.dataUrl);
  await assert.rejects(dest.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [{ format: 'onejournal', version: 1, state: backup.state, rolls: [] }] }), { status: 400 });
  const legacy = { format: 'onejournal', version: 1, state: { ...backup.state, map: null }, rolls: [] };
  delete legacy.state.mapLibrary;
  await dest.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [legacy] });
  assert.equal(dest.doc.state.mapLibrary[0].name, 'Moria');
});

test('state normalizes legacy saves and validates image map geometry', () => {
  const saved = { version: 2, library: [], battle: [], heroes: [], heroParticipants: [], map: null };
  const storage = { getItem: () => JSON.stringify(saved), setItem: () => {} };
  const store = createStore(storage);
  assert.deepEqual(store.getState().mapLibrary, []);
  store.setMap({ kind: 'image', imageId: imageId(full), width: 1200, height: 1200, positions: {} });
  assert.equal(store.getState().map.imageId, imageId(full));
  assert.throws(() => store.setMap({ kind: 'image', imageId: imageId(full), width: 1024, height: 1024, positions: {} }), /Invalid image map/);
  assert.throws(() => store.setMap({ kind: 'image', imageId: [imageId(full)], width: 1200, height: 1200, positions: {} }), /Invalid image map/);
  assert.equal(store.getState().map.width, 1200);
});
