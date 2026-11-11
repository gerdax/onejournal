'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createServerCore, defaultDocument } = require('../server-core.js');
const jpeg = fs.readFileSync(`${__dirname}/fixtures/map-1024.jpg`);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const version = hash(jpeg);
const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
function fixture() {
  const doc = defaultDocument();
  doc.state.heroes.push({ id: 'hero', name: 'Ala' });
  for (const [uid, role, heroId] of [['gm', 'gm', null], ['player', 'player', 'hero']]) {
    doc.links.push({ id: uid, role, heroId, version: 1, active: true });
    doc.grants.push({ uid, linkId: uid, role, heroId, version: 1, active: true });
  }
  const manifest = { maps: Object.fromEntries(['eriador', 'podrozy'].map(id => [id, { version, path: `${id}-${version}.jpg` }])) };
  const f = { doc, manifest, reads: [], onManifest: () => {}, onImage: () => {}, image: dataUrl };
  f.core = createServerCore({
    repository: { get: async () => structuredClone(doc) },
    travelMapStorage: {
      getManifest: async () => { await f.onManifest(); return structuredClone(manifest); },
      get: async path => { f.reads.push(path); await f.onImage(); return f.image; }
    },
    hashSecret: hash, randomSecret: () => 'secret', encryptSecret: x => x, decryptSecret: x => x
  });
  return f;
}
test('travel map identity comes from the active grant; full and unchanged responses are private', async () => {
  const f = fixture();
  await assert.rejects(f.core.handle('unknown', { action: 'travelMapGet' }), { status: 403 });
  assert.equal(f.reads.length, 0);
  assert.deepEqual(await f.core.handle('player', { action: 'travelMapGet', mapId: 'podrozy' }), { mapId: 'eriador', version, dataUrl });
  assert.deepEqual(await f.core.handle('gm', { action: 'travelMapGet' }), { mapId: 'podrozy', version, dataUrl });
  const reads = f.reads.length;
  assert.deepEqual(await f.core.handle('player', { action: 'travelMapGet', knownVersion: version }), { mapId: 'eriador', version, unchanged: true });
  assert.equal(f.reads.length, reads);
  assert.equal(JSON.stringify(await f.core.handle('gm', { action: 'snapshot' })).includes('data:image'), false);
});
test('travel map validates versions, immutable paths and downloaded content hash', async () => {
  const f = fixture();
  await assert.rejects(f.core.handle('gm', { action: 'travelMapGet', knownVersion: 'old' }), { status: 400 });
  f.manifest.maps.podrozy.path = `eriador-${version}.jpg`;
  await assert.rejects(f.core.handle('gm', { action: 'travelMapGet' }), { status: 500 });
  f.manifest.maps.podrozy.path = `podrozy-${version}.jpg`;
  const corrupted = Buffer.from(jpeg); corrupted[20] ^= 1;
  f.image = `data:image/jpeg;base64,${corrupted.toString('base64')}`;
  await assert.rejects(f.core.handle('gm', { action: 'travelMapGet' }), { status: 500 });
  f.image = 'data:image/jpeg;base64,AAAA';
  await assert.rejects(f.core.handle('gm', { action: 'travelMapGet' }), { status: 500 });
});
test('updated travel map version replaces the image without exposing its storage path', async () => {
  const f = fixture(), changed = Buffer.from(jpeg); changed[20] ^= 1;
  const nextVersion = hash(changed);
  f.image = `data:image/jpeg;base64,${changed.toString('base64')}`;
  f.manifest.maps.eriador = { version: nextVersion, path: `eriador-${nextVersion}.jpg` };
  assert.deepEqual(await f.core.handle('player', { action: 'travelMapGet', knownVersion: version }), { mapId: 'eriador', version: nextVersion, dataUrl: f.image });
});
test('revocation during image or manifest IO blocks full and unchanged responses', async () => {
  for (const unchanged of [false, true]) {
    const f = fixture();
    f[unchanged ? 'onManifest' : 'onImage'] = () => { f.doc.links.find(x => x.id === 'player').active = false; };
    await assert.rejects(f.core.handle('player', { action: 'travelMapGet', ...(unchanged ? { knownVersion: version } : {}) }), { status: 403 });
  }
});
test('switching a grant to GM during IO cannot return a map selected under its previous identity', async () => {
  const f = fixture();
  f.onImage = () => Object.assign(f.doc.grants.find(x => x.uid === 'player'), { linkId: 'gm', role: 'gm', heroId: null });
  await assert.rejects(f.core.handle('player', { action: 'travelMapGet' }), { status: 403 });
});
test('travel map accepts multi-megabyte JPEG bytes up to 20 MiB and rejects larger objects', async () => {
  const f = fixture(), bytes = Buffer.alloc(20 * 1024 * 1024);
  jpeg.copy(bytes, 0, 0, jpeg.length - 2); bytes[bytes.length - 2] = 255; bytes[bytes.length - 1] = 217;
  const largeVersion = hash(bytes);
  f.manifest.maps.eriador = { version: largeVersion, path: `eriador-${largeVersion}.jpg` };
  f.image = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  assert.equal((await f.core.handle('player', { action: 'travelMapGet' })).version, largeVersion);
  const oversized = Buffer.concat([bytes.subarray(0, bytes.length - 2), Buffer.from([0, 255, 217])]);
  const oversizedVersion = hash(oversized);
  f.manifest.maps.eriador = { version: oversizedVersion, path: `eriador-${oversizedVersion}.jpg` };
  f.image = `data:image/jpeg;base64,${oversized.toString('base64')}`;
  await assert.rejects(f.core.handle('player', { action: 'travelMapGet' }), { status: 500 });
});
