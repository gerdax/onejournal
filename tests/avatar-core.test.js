'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServerCore, defaultDocument } = require('../server-core.js');

const jpeg = fs.readFileSync(path.join(__dirname, 'fixtures/avatar-256.jpg'));
const dataUrl = bytes => 'data:image/jpeg;base64,' + bytes.toString('base64');
function fixture(blobs = new Map()) {
  let doc = defaultDocument();
  doc.links.push({ id:'gm-link', role:'gm', heroId:null, secretHash:'gm', encryptedSecret:'gm', version:1, active:true });
  doc.grants.push({ uid:'gm', linkId:'gm-link', version:1, role:'gm', heroId:null, active:true });
  const core = createServerCore({
    repository: { get: async () => structuredClone(doc), compareAndSwap: async (revision, next) => {
      if (doc.revision !== revision) return false;
      doc = structuredClone(next); return true;
    } },
    avatarStorage: { get: async id => blobs.get(id) || null, put: async (id, image) => { blobs.set(id, image); } },
    hashSecret: value => crypto.createHash('sha256').update(value).digest('hex'),
    randomSecret: () => 'long-secret-for-player-link-12345678', encryptSecret: x => x, decryptSecret: x => x
  });
  return { core, blobs, get doc() { return doc; } };
}
async function hero(f, name = 'A') {
  return (await f.core.handle('gm', { action:'command', method:'saveHero', args:[{ name }] })).result;
}
async function player(f, id, uid) {
  const link = await f.core.handle('gm', { action:'rotateLink', heroId:id });
  await f.core.handle(uid, { action:'exchange', secret:link.secret });
}

test('avatar access, immutable reference, snapshot privacy, conflict and removal', async () => {
  const f = fixture(), a = await hero(f), b = await hero(f, 'B');
  await player(f, a.id, 'p1');
  const before = await f.core.handle('p1', { action:'snapshot' });
  await assert.rejects(f.core.handle('p1', { action:'avatarGet', heroId:b.id }), { status:403 });
  await assert.rejects(f.core.handle('p1', { action:'avatarSet', heroId:b.id, dataUrl:dataUrl(jpeg), heroVersion:1 }), { status:403 });
  await assert.rejects(f.core.handle('p1', { action:'command', method:'saveHero', args:[{ id:a.id, avatarId:'a'.repeat(64) }], heroVersion:1 }), { status:400 });
  await assert.rejects(f.core.handle('gm', { action:'command', method:'saveHero', args:[{ id:a.id, avatarId:'a'.repeat(64) }], heroVersion:1 }), { status:400 });
  const set = await f.core.handle('p1', { action:'avatarSet', heroId:a.id, dataUrl:dataUrl(jpeg), heroVersion:before.heroVersions[a.id] });
  const id = set.result.avatarId;
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id, crypto.createHash('sha256').update(jpeg).digest('hex'));
  assert.equal((await f.core.handle('p1', { action:'avatarGet', heroId:a.id })).dataUrl, dataUrl(jpeg));
  assert.equal(JSON.stringify(set).includes('base64,'), false);
  assert.equal(JSON.stringify(await f.core.handle('gm', { action:'snapshot' })).includes('base64,'), false);
  await assert.rejects(f.core.handle('p1', { action:'avatarSet', heroId:a.id, dataUrl:null, heroVersion:before.heroVersions[a.id] }), { status:409 });
  const removed = await f.core.handle('gm', { action:'avatarSet', heroId:a.id, dataUrl:null, heroVersion:set.heroVersions[a.id] });
  assert.equal(removed.result.avatarId, null);
  assert.deepEqual(await f.core.handle('p1', { action:'avatarGet', heroId:a.id }), { avatarId:null, dataUrl:null });
  assert.equal(f.blobs.get(id), dataUrl(jpeg));
  await f.core.handle('gm', { action:'revokeLink', heroId:a.id });
  await assert.rejects(f.core.handle('p1', { action:'avatarGet', heroId:a.id }), { status:403 });
});

test('rejects malformed, rectangular and oversized avatar bytes', async () => {
  const f = fixture(), h = await hero(f);
  const broken = Buffer.from(jpeg); broken[0] = 0;
  const rectangle = Buffer.from(jpeg);
  const sof = rectangle.indexOf(Buffer.from([0xff,0xc0]));
  assert.ok(sof > 0);
  rectangle[sof + 7] = 1; rectangle[sof + 8] = 255;
  const noScan = Buffer.from([255,216,255,192,0,11,8,1,0,1,0,1,1,1,17,0,255,217]);
  for (const bytes of [broken, rectangle, noScan, Buffer.alloc(65537, 255)]) {
    await assert.rejects(f.core.handle('gm', { action:'avatarSet', heroId:h.id, dataUrl:dataUrl(bytes), heroVersion:1 }), { status:400 });
  }
  assert.equal(f.doc.state.heroes[0].avatarId, null);
  assert.equal(f.blobs.size, 0);
});

test('v2 backup carries bytes and restores through staged storage; missing refs cannot replace state', async () => {
  const source = fixture(), h = await hero(source);
  const set = await source.core.handle('gm', { action:'avatarSet', heroId:h.id, dataUrl:dataUrl(jpeg), heroVersion:1 });
  const id = set.result.avatarId;
  const backup = await source.core.handle('gm', { action:'export' });
  assert.equal(backup.version, 2);
  assert.equal(backup.avatars[id], dataUrl(jpeg));
  const dest = fixture();
  await assert.rejects(dest.core.handle('gm', { action:'command', method:'restoreBackup', args:[{ ...backup, avatars:{ [id]:null } }] }), { status:400 });
  assert.deepEqual(dest.doc.state.heroes, []);
  assert.deepEqual(await dest.core.handle('gm', { action:'avatarStage', dataUrl:backup.avatars[id] }), { avatarId:id });
  await assert.rejects(dest.core.handle('gm', { action:'command', method:'restoreBackup', args:[{ ...backup, avatars:{ ['f'.repeat(64)]:null } }] }), { status:400 });
  await dest.core.handle('gm', { action:'command', method:'restoreBackup', args:[{ ...backup, avatars:{ [id]:null } }] });
  assert.equal((await dest.core.handle('gm', { action:'avatarGet', heroId:h.id })).dataUrl, dataUrl(jpeg));
  const legacy = { ...backup, version:1 }; delete legacy.avatars;
  await assert.rejects(dest.core.handle('gm', { action:'command', method:'restoreBackup', args:[legacy] }), { status:400 });
  const v1 = { format:'onejournal', version:1, state:{ ...backup.state, heroes:[{ ...backup.state.heroes[0], avatarId:null }] }, rolls:[] };
  await dest.core.handle('gm', { action:'command', method:'restoreBackup', args:[v1] });
  assert.equal(dest.doc.state.heroes[0].avatarId, null);
});
