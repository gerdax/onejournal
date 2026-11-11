'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../cloud-store.js');
const snap = role => ({ state: { heroes: [] }, access: { role, heroId: role === 'gm' ? null : 'hero' }, revision: 1 });
const version = 'a'.repeat(64), next = 'b'.repeat(64);
const image = (mapId = 'eriador', v = version) => ({ mapId, version: v, dataUrl: 'data:image/jpeg;base64,AA==' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('travel map caches detached bytes only in memory and checks known version on reopening', async () => {
  const bodies = [];
  const store = createStore({ request: async body => {
    if (body.action !== 'travelMapGet') return snap('player');
    bodies.push(body);
    return bodies.length === 1 ? image() : bodies.length === 2 ? { mapId: 'eriador', version, unchanged: true } : image('eriador', next);
  } });
  await store.connect();
  assert.equal(store.getCachedTravelMap(), null);
  (await store.getTravelMap()).dataUrl = 'modified';
  assert.deepEqual(store.getCachedTravelMap(), image());
  assert.deepEqual(await store.getTravelMap(), image());
  assert.equal(bodies[1].knownVersion, version);
  assert.deepEqual(await store.getTravelMap(), image('eriador', next));
  store.markOffline();
  assert.deepEqual(store.getCachedTravelMap(), image('eriador', next));
  assert.deepEqual(await store.getTravelMap(), image('eriador', next));
  assert.equal(bodies.length, 3);
  store.stop();
  assert.equal(store.getCachedTravelMap(), null);
});
test('travel map read starts immediately while a mutation is waiting and concurrent reads deduplicate', async () => {
  const write = deferred(), read = deferred(); let reads = 0;
  const store = createStore({ request: async body => {
    if (body.action === 'command') return write.promise;
    if (body.action === 'travelMapGet') { reads++; return read.promise; }
    return snap('player');
  } });
  await store.connect();
  const saving = store.saveHero({ id: 'hero' });
  await Promise.resolve();
  const first = store.getTravelMap(), second = store.getTravelMap();
  assert.equal(reads, 1);
  read.resolve(image());
  assert.deepEqual(await first, image()); assert.deepEqual(await second, image());
  write.resolve({ ...snap('player'), result: null }); await saving;
});
test('reconnecting clears cached GM bytes and late responses cannot enter the player cache', async () => {
  const delayed = deferred(); let calls = 0;
  const store = createStore({ request: async body => {
    if (body.action === 'exchange') return snap('player');
    if (body.action === 'travelMapGet') return ++calls === 1 ? image('podrozy') : delayed.promise;
    return snap('gm');
  } });
  await store.connect(); await store.getTravelMap();
  const pending = store.getTravelMap();
  const switched = store.connect('player');
  assert.equal(store.getCachedTravelMap(), null);
  await switched;
  delayed.resolve(image('podrozy', next));
  await assert.rejects(pending, { stale: true });
  assert.equal(store.getCachedTravelMap(), null);
});
test('revoked access clears cached bytes; unchanged must match both map id and version', async () => {
  for (const response of [{ mapId: 'podrozy', version, unchanged: true }, { mapId: 'eriador', version: next, unchanged: true }, { mapId: 'eriador', version, unchanged: true }]) {
    let calls = 0;
    const store = createStore({ request: async body => body.action === 'travelMapGet' ? (++calls === 1 ? response : image()) : snap('player') });
    await store.connect(); await assert.rejects(store.getTravelMap()); assert.equal(store.getCachedTravelMap(), null);
  }
  let revoked = false;
  const store = createStore({ request: async body => {
    if (revoked) throw Object.assign(new Error('revoked'), { status: 403 });
    return body.action === 'travelMapGet' ? image() : snap('player');
  } });
  await store.connect(); await store.getTravelMap(); revoked = true;
  await assert.rejects(store.getTravelMap(), { status: 403 });
  assert.equal(store.getCachedTravelMap(), null);
});
test('offline and stop invalidate pending reads; refresh identity changes clear private cache', async () => {
  for (const method of ['markOffline', 'stop']) {
    const delayed = deferred();
    const store = createStore({ request: async body => body.action === 'travelMapGet' ? delayed.promise : snap('gm') });
    await store.connect(); const pending = store.getTravelMap(); store[method](); delayed.resolve(image('podrozy'));
    await assert.rejects(pending, { stale: true }); assert.equal(store.getCachedTravelMap(), null);
  }
  let role = 'gm';
  const store = createStore({ request: async body => body.action === 'travelMapGet' ? image('podrozy') : snap(role) });
  await store.connect(); await store.getTravelMap(); role = 'player'; await store.refresh();
  assert.equal(store.getCachedTravelMap(), null);
});
test('travel map retries a failed first read while offline without requiring a snapshot refresh', async () => {
  let reads = 0, snapshots = 0;
  const store = createStore({ request: async body => {
    if (body.action !== 'travelMapGet') { snapshots++; return snap('player'); }
    if (++reads === 1) throw Object.assign(new Error('temporary failure'), { status: 503 });
    return image();
  } });
  await assert.rejects(store.getTravelMap());
  await store.connect();
  await assert.rejects(store.getTravelMap(), { status: 503 });
  assert.equal(store.connection, 'offline');
  assert.equal(store.getCachedTravelMap(), null);
  assert.deepEqual(await store.getTravelMap(), image());
  assert.equal(reads, 2); assert.equal(snapshots, 1);
  assert.equal(store.canWrite, false);
  store.stop(); await assert.rejects(store.getTravelMap());
});

test('an ignored stale identity snapshot preserves accepted access and private cache', async () => {
  const refresh = deferred();
  const store = createStore({ request: async body => {
    if (body.action === 'travelMapGet') return image('podrozy');
    if (body.action === 'command') return { ...snap('gm'), revision: 2, result: null };
    if (body.knownRevision != null) return refresh.promise;
    return snap('gm');
  } });
  await store.connect(); await store.getTravelMap();
  const pending = store.refresh();
  await store.saveHero({ id: 'hero' });
  refresh.resolve(snap('player')); await pending;
  assert.equal(store.access.role, 'gm');
  assert.deepEqual(store.getCachedTravelMap(), image('podrozy'));
});
