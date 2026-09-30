const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerCore, defaultDocument } = require('../server-core.js');

function fixture() {
  let doc = defaultDocument();
  let secretCounter = 0;
  const repository = {
    async get() { return structuredClone(doc); },
    async compareAndSwap(expected, next) {
      if (doc.revision !== expected) return false;
      doc = structuredClone(next);
      return true;
    }
  };
  const core = createServerCore({ repository, hashSecret: x => `hash:${x}`, randomSecret: () => `secret-${String(++secretCounter).padStart(8, '0')}-long-enough`, encryptSecret: x => `encrypted:${x}`, decryptSecret: x => x.slice(10), now: () => '2026-01-01T00:00:00Z' });
  doc.links.push({ id: 'gm-link', role: 'gm', heroId: null, secretHash: 'hash:gm-secret-long-enough', encryptedSecret: 'encrypted:gm-secret-long-enough', version: 1, active: true });
  doc.grants.push({ uid: 'gm', linkId: 'gm-link', version: 1, role: 'gm', heroId: null, active: true });
  return { core, repository, get doc() { return doc; } };
}

test('player projections, assignment, rotation and revocation', async () => {
  const f = fixture();
  const a = await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] });
  const aid = a.result.id;
  const b = await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'B', notes: 'secret' }] });
  const bid = b.result.id;
  await f.core.handle('gm', { action: 'command', method: 'addEnemy', args: [{ name: 'Ork', notes: 'private' }] });
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: aid });
  const player = await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  assert.deepEqual(player.state.heroes.map(h => h.id), [aid]);
  assert.deepEqual(player.state.battle, []);
  assert.deepEqual(player.state.library, []);
  assert.equal(player.catalog, undefined);
  assert.deepEqual(player.participants.map(p => Object.keys(p).sort()), [['defeated','heroId','id','name','type']]);
  await assert.rejects(f.core.handle('p1', { action: 'command', method: 'saveHero', args: [{ id: bid, name: 'Stolen' }], heroVersion: 1 }), { status: 403 });
  await assert.rejects(f.core.handle('p1', { action: 'command', method: 'saveHero', args: [{ id: aid, defeated: true }], heroVersion: player.heroVersions[aid] }), { status: 403 });
  await assert.rejects(f.core.handle('p1', { action: 'command', method: 'deleteHero', args: [aid] }), { status: 403 });
  await f.core.handle('gm', { action: 'rotateLink', heroId: aid });
  await assert.rejects(f.core.handle('p1', { action: 'snapshot' }), { status: 403 });
});

test('hero version conflict preserves draft and resource delta', async () => {
  const f = fixture();
  const saved = await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A', endurance: 6, maxEndurance: 10 }] });
  const id = saved.result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: id });
  const player = await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  await f.core.handle('gm', { action: 'command', method: 'addHero', args: [id] });
  await f.core.handle('gm', { action: 'command', method: 'adjustResource', args: [`hero:${id}`, 'endurance', -2] });
  await assert.rejects(f.core.handle('p1', { action: 'command', method: 'saveHero', args: [{ id, name: 'Draft' }], heroVersion: player.heroVersions[id] }), { status: 409 });
  assert.equal((await f.core.handle('p1', { action: 'snapshot' })).state.heroes[0].endurance, 4);
  const fresh = await f.core.handle('p1', { action: 'snapshot' });
  await f.core.handle('p1', { action: 'command', method: 'saveHero', args: [{ id, name: 'Draft' }], heroVersion: fresh.heroVersions[id] });
  assert.equal((await f.core.handle('p1', { action: 'snapshot' })).state.heroes[0].name, 'Draft');
});

test('roll interpretation, idempotency and private revision', async () => {
  const f = fixture();
  const id = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: id });
  await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  const config = { actor: 'hero', baseDice: 1, bonus: 0, featMode: 'normal', target: 10, hope: false, inspired: false, enemyResource: false, miserable: false, exhausted: false };
  const raw = { feat: [12], success: [1] };
  const r = { action: 'roll', id: 'roll-0001', heroId: id, config: { ...config, privateSecret: 'hidden' }, raw: { ...raw, privateSecret: 'hidden' } };
  const first = await f.core.handle('p1', r);
  assert.equal(first.rolls[0].result.automaticSuccess, true);
  assert.equal(JSON.stringify(first.rolls).includes('hidden'), false);
  assert.equal((await f.core.handle('p1', r)).rolls.length, 1);
  await assert.rejects(f.core.handle('p1', { ...r, id: 'roll-0002', config: { ...config, actor: 'enemy' } }), { status: 403 });
  const before = (await f.core.handle('p1', { action: 'snapshot' })).revision;
  await f.core.handle('gm', { action: 'roll', id: 'roll-0003', config: { ...config, actor: 'enemy' }, raw });
  const after = await f.core.handle('p1', { action: 'snapshot' });
  assert.equal(after.revision, before);
  assert.equal(after.rolls.length, 1);
  assert.equal((await f.core.handle('gm', { action: 'snapshot' })).rolls.length, 2);
});

test('GM generic hero, NPC and enemy rolls need no hero and keep NPC private', async () => {
  const f = fixture();
  const base = { actor: 'hero', baseDice: 0, bonus: 0, featMode: 'normal', target: '', hope: false, inspired: false, enemyResource: false, miserable: false, exhausted: false };
  const heroRoll = { action: 'roll', id: 'gm-hero-0001', heroId: null, config: base, raw: { feat: [12], success: [] } };
  const generic = await f.core.handle('gm', heroRoll);
  assert.equal(generic.rolls[0].name, 'MG');
  assert.equal(generic.rolls[0].heroId, null);
  assert.equal(generic.rolls[0].result.automaticSuccess, true);
  const publicRevision = f.doc.publicRevision;
  const npc = await f.core.handle('gm', { action: 'roll', id: 'gm-npc-0001', heroId: null,
    config: { ...base, actor: 'npc', hope: true, inspired: true }, raw: { feat: [12], success: [1, 2] } });
  assert.equal(npc.rolls.at(-1).name, 'NPC');
  assert.equal(npc.rolls.at(-1).actor, 'npc');
  assert.equal(npc.rolls.at(-1).result.actor, 'hero');
  assert.equal(npc.rolls.at(-1).result.automaticSuccess, true);
  assert.equal(f.doc.publicRevision, publicRevision);
  await f.core.handle('gm', { action: 'roll', id: 'gm-enemy-01', heroId: null,
    config: { ...base, actor: 'enemy' }, raw: { feat: [11], success: [] } });
  assert.equal(f.doc.publicRevision, publicRevision);
  assert.equal((await f.core.handle('gm', heroRoll)).rolls.length, 3);
  await assert.rejects(f.core.handle('gm', { ...heroRoll, raw: { feat: [9], success: [] } }), { status: 409 });
  const heroId = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId });
  const player = await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  assert.deepEqual(player.rolls.map(roll => roll.id), ['gm-hero-0001']);
  assert.equal(player.revision, f.doc.publicRevision);
  await assert.rejects(f.core.handle('p1', { action: 'roll', id: 'player-npc-01', heroId,
    config: { ...base, actor: 'npc' }, raw: { feat: [12], success: [] } }), { status: 403 });
  await assert.rejects(f.core.handle('p1', { action: 'roll', id: 'player-enemy', heroId,
    config: { ...base, actor: 'enemy' }, raw: { feat: [11], success: [] } }), { status: 403 });
});

test('GM old-client heroId is accepted but new entry is generic; restore keeps historical named rolls', async () => {
  const f = fixture();
  const heroId = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'Old Hero' }] })).result.id;
  const config = { actor: 'hero', baseDice: 0, bonus: 0, featMode: 'normal', target: '', hope: false, inspired: false, enemyResource: false, miserable: false, exhausted: false };
  const oldClient = { action: 'roll', id: 'gm-legacy-01', heroId, config, raw: { feat: [12], success: [] } };
  const fresh = await f.core.handle('gm', oldClient);
  assert.equal(fresh.rolls[0].heroId, null);
  assert.equal((await f.core.handle('gm', oldClient)).rolls.length, 1);
  const backup = await f.core.handle('gm', { action: 'export' });
  backup.rolls.push({ ...backup.rolls[0], id: 'new-npc-01', visibility: 'private', actor: 'npc', config: { ...config, actor: 'npc' }, name: 'NPC', heroId: null });
  backup.rolls.push({ ...backup.rolls[0], id: 'historic-01', heroId, heroName: 'Old Hero', name: 'Old Hero', authorRole: 'gm' });
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [backup] });
  const restored = await f.core.handle('gm', { action: 'snapshot' });
  assert.equal(restored.rolls[0].name, 'MG');
  assert.equal(restored.rolls[1].name, 'NPC');
  assert.equal(restored.rolls[2].heroId, heroId);
  assert.equal(restored.rolls[2].name, 'Old Hero');
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId });
  const player = await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  assert.deepEqual(player.rolls.map(roll => roll.id), ['gm-legacy-01', 'historic-01']);
});

test('backup wrapper roundtrip and legacy backup restore retain journal semantics', async () => {
  const f = fixture();
  const h = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result.id;
  const exported = await f.core.handle('gm', { action: 'export' });
  assert.equal(exported.format, 'onejournal');
  assert.equal(exported.state.heroes[0].id, h);
  await f.core.handle('gm', { action: 'command', method: 'clearEncounter', args: [] });
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [exported] });
  assert.equal((await f.core.handle('gm', { action: 'snapshot' })).state.heroes[0].id, h);
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [exported.state] });
});

test('participants include GM details and only assigned player hero details', async () => {
  const f = fixture();
  const a = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A', notes: 'mine' }] })).result.id;
  const b = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'B', notes: 'other secret' }] })).result.id;
  await f.core.handle('gm', { action: 'command', method: 'addHero', args: [a] });
  await f.core.handle('gm', { action: 'command', method: 'addHero', args: [b] });
  const gm = await f.core.handle('gm', { action: 'snapshot' });
  assert.equal(gm.participants.find(p => p.heroId === b).notes, 'other secret');
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: a });
  const player = await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  assert.equal(player.participants.find(p => p.heroId === a).notes, 'mine');
  assert.deepEqual(Object.keys(player.participants.find(p => p.heroId === b)).sort(), ['defeated', 'heroId', 'id', 'name', 'type']);
});

test('hero links are distinct and rotating one preserves the other', async () => {
  const f = fixture();
  const a = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result.id;
  const b = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'B' }] })).result.id;
  const firstA = await f.core.handle('gm', { action: 'rotateLink', heroId: a });
  const firstB = await f.core.handle('gm', { action: 'rotateLink', heroId: b });
  assert.notEqual(firstA.secret, firstB.secret);
  const linksBefore = await f.core.handle('gm', { action: 'links' });
  assert.equal(linksBefore.find(link => link.heroId === a).secret, firstA.secret);
  assert.equal(linksBefore.find(link => link.heroId === b).secret, firstB.secret);
  const nextA = await f.core.handle('gm', { action: 'rotateLink', heroId: a });
  assert.notEqual(nextA.secret, firstA.secret);
  const linksAfter = await f.core.handle('gm', { action: 'links' });
  assert.equal(linksAfter.find(link => link.heroId === a).secret, nextA.secret);
  assert.equal(linksAfter.find(link => link.heroId === b).secret, firstB.secret);
  await assert.rejects(f.core.handle('old', { action: 'exchange', secret: firstA.secret }), { status: 403 });
  const p = await f.core.handle('new', { action: 'exchange', secret: nextA.secret });
  assert.equal(p.access.heroId, a);
});

test('player can toggle only their own battle hero and sees public defeat flags', async () => {
  const f = fixture();
  const a = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result.id;
  const b = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'B' }] })).result.id;
  await f.core.handle('gm', { action: 'command', method: 'addHero', args: [a] });
  await f.core.handle('gm', { action: 'command', method: 'addHero', args: [b] });
  const enemy = (await f.core.handle('gm', { action: 'command', method: 'addEnemy', args: [{ name: 'Ork' }] })).result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: a });
  const player = await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  assert.equal(player.participants.find(p => p.id === enemy).defeated, false);
  await assert.rejects(f.core.handle('p1', { action: 'command', method: 'toggleDefeated', args: [`hero:${b}`] }), { status: 403 });
  await assert.rejects(f.core.handle('p1', { action: 'command', method: 'toggleDefeated', args: [enemy] }), { status: 403 });
  const own = await f.core.handle('p1', { action: 'command', method: 'toggleDefeated', args: [`hero:${a}`] });
  assert.equal(own.participants.find(p => p.id === `hero:${a}`).defeated, true);
  assert.equal(own.heroVersions[a], player.heroVersions[a] + 1);
  await f.core.handle('gm', { action: 'command', method: 'toggleDefeated', args: [enemy] });
  const updated = await f.core.handle('p1', { action: 'snapshot' });
  assert.equal(updated.participants.find(p => p.id === enemy).defeated, true);
  assert.equal(updated.revision, own.revision + 1);
  await f.core.handle('gm', { action: 'command', method: 'removeParticipant', args: [`hero:${a}`] });
  await assert.rejects(f.core.handle('p1', { action: 'command', method: 'toggleDefeated', args: [`hero:${a}`] }), { status: 403 });
});

test('final enemy wound publishes the new defeated flag', async () => {
  const f = fixture();
  const hero = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result.id;
  const enemy = (await f.core.handle('gm', { action: 'command', method: 'addEnemy', args: [{ name: 'Ork', might: 1 }] })).result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: hero });
  const before = await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  await f.core.handle('gm', { action: 'command', method: 'setEnemyWound', args: [enemy, 0, true] });
  const after = await f.core.handle('p1', { action: 'snapshot' });
  assert.equal(after.participants.find(p => p.id === enemy).defeated, true);
  assert.equal(after.revision, before.revision + 1);
});

test('player resource deltas apply only to own battle hero Endurance and Hope', async () => {
  const f = fixture();
  const own = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A', endurance: 6, maxEndurance: 10, hope: 2, maxHope: 5 }] })).result.id;
  const other = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'B' }] })).result.id;
  await f.core.handle('gm', { action: 'command', method: 'addHero', args: [own] });
  await f.core.handle('gm', { action: 'command', method: 'addHero', args: [other] });
  const enemy = (await f.core.handle('gm', { action: 'command', method: 'addEnemy', args: [{ name: 'Ork' }] })).result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: own });
  const initial = await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  const endurance = await f.core.handle('p1', { action: 'command', method: 'adjustResource', args: [`hero:${own}`, 'endurance', -2] });
  assert.equal(endurance.state.heroes[0].endurance, 4);
  const hope = await f.core.handle('p1', { action: 'command', method: 'adjustResource', args: [`hero:${own}`, 'hope', 1] });
  assert.equal(hope.state.heroes[0].hope, 3);
  assert.equal(hope.heroVersions[own], initial.heroVersions[own] + 2);
  for (const args of [[`hero:${other}`, 'endurance', -1], [enemy, 'endurance', -1], [`hero:${own}`, 'hate', 1], [`hero:${own}`, 'hope', '1'], [`hero:${own}`, 'hope', Infinity]]) {
    await assert.rejects(f.core.handle('p1', { action: 'command', method: 'adjustResource', args }), { status: 403 });
  }
  assert.equal((await f.core.handle('p1', { action: 'snapshot' })).state.heroes[0].hope, 3);
});

test('dice target strings normalize and malformed restored journal is rejected', async () => {
  const f = fixture();
  const id = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result.id;
  const config = { actor: 'hero', baseDice: 0, bonus: 0, featMode: 'normal', target: '10', hope: false, inspired: false, enemyResource: false, miserable: false, exhausted: false };
  const result = await f.core.handle('gm', { action: 'roll', id: 'roll-0004', heroId: id, config, raw: { feat: [9], success: [] } });
  assert.equal(result.rolls[0].result.target, 10);
  const exported = await f.core.handle('gm', { action: 'export' });
  exported.rolls[0].result.sum = 999;
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [exported] });
  assert.equal((await f.core.handle('gm', { action: 'snapshot' })).rolls[0].result.sum, 9);
  exported.rolls.push({ ...exported.rolls[0] });
  await assert.rejects(f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [exported] }), { status: 400 });
});

test('restoring a backup without a hero revokes its active player grant', async () => {
  const f = fixture();
  const empty = (await f.core.handle('gm', { action: 'export' })).state;
  const id = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'Temporary' }] })).result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: id });
  await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [empty] });
  await assert.rejects(f.core.handle('p1', { action: 'snapshot' }), { status: 403 });
  await assert.rejects(f.core.handle('p2', { action: 'exchange', secret: link.secret }), { status: 403 });
});

test('only GM clears all public and private rolls and notifies players without changing game data', async () => {
  const f = fixture();
  const id = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: id });
  await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  const config = { actor: 'hero', baseDice: 0, bonus: 0, featMode: 'normal', hope: false, inspired: false, enemyResource: false, miserable: false, exhausted: false };
  for (const [index, actor] of ['hero', 'npc', 'enemy'].entries()) {
    await f.core.handle('gm', { action: 'roll', id: `clear-test-${index}`, config: { ...config, actor }, raw: { feat: [5], success: [] } });
  }
  await f.core.handle('p1', { action: 'roll', id: 'clear-player-roll', heroId: id, config, raw: { feat: [7], success: [] } });
  const before = structuredClone(f.doc);
  await assert.rejects(f.core.handle('p1', { action: 'clearRolls' }), { status: 403 });
  assert.deepEqual(f.doc, before);
  const cleared = await f.core.handle('gm', { action: 'clearRolls' });
  assert.deepEqual(cleared.rolls, []);
  assert.deepEqual(f.doc.state, before.state);
  assert.deepEqual(f.doc.links, before.links);
  assert.equal(f.doc.publicRevision, before.publicRevision + 1);
  assert.deepEqual((await f.core.handle('p1', { action: 'snapshot' })).rolls, []);
  assert.deepEqual((await f.core.handle('gm', { action: 'export' })).rolls, []);
  await f.core.handle('gm', { action: 'clearRolls' });
  await f.core.handle('p1', { action: 'roll', id: 'after-clear-roll', rollEpoch: 2, heroId: id, config, raw: { feat: [3], success: [] } });
  assert.equal(f.doc.rolls.length, 1);
});

test('player Hope spending is atomic, deduplicated, shared across devices, and independent of battle participation', async () => {
  const f = fixture();
  const id = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A', hope: 1, maxHope: 10 }] })).result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: id });
  for (const uid of ['p1', 'p2']) await f.core.handle(uid, { action: 'exchange', secret: link.secret });
  const config = { actor: 'hero', baseDice: 0, bonus: 0, featMode: 'normal', hope: true, inspired: false, enemyResource: false, miserable: false, exhausted: false };
  const request = { action: 'roll', id: 'hope-roll-01', heroId: id, config, raw: { feat: [7], success: [3] } };
  const version = f.doc.heroVersions[id];
  const outcomes = await Promise.allSettled([f.core.handle('p1', request), f.core.handle('p2', { ...request, id: 'hope-roll-02' })]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.status, 409);
  assert.equal(f.doc.state.heroes[0].hope, 0);
  assert.equal(f.doc.rolls.length, 1);
  assert.equal(f.doc.heroVersions[id], version + 1);
  const firstWon = outcomes[0].status === 'fulfilled';
  await f.core.handle(firstWon ? 'p1' : 'p2', firstWon ? request : { ...request, id: 'hope-roll-02' });
  assert.equal(f.doc.rolls.length, 1);
  assert.equal(f.doc.state.heroes[0].hope, 0);
  await f.core.handle('gm', { action: 'clearRolls' });
  await assert.rejects(f.core.handle(firstWon ? 'p1' : 'p2', firstWon ? request : { ...request, id: 'hope-roll-02' }), { status: 409 });
  assert.equal(f.doc.rolls.length, 0);
  assert.equal(f.doc.state.heroes[0].hope, 0);
  await f.core.handle('gm', { ...request, id: 'gm-hope-roll', rollEpoch: 1 });
  assert.equal(f.doc.state.heroes[0].hope, 0);
});

test('enemy editor writes reject Might above five', async () => {
  const f = fixture();
  for (const method of ['addEnemy', 'addLibrary']) {
    await assert.rejects(f.core.handle('gm', { action: 'command', method, args: [{ name: 'Ork', might: 6 }] }), { status: 400 });
    await f.core.handle('gm', { action: 'command', method, args: [{ name: 'Ork', might: 5 }] });
  }
});

test('replacing history from backup invalidates unpublished old rolls', async () => {
  const f = fixture();
  const backup = await f.core.handle('gm', { action: 'export' });
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [backup] });
  assert.equal(f.doc.rollEpoch, 1);
  const config = { actor: 'hero', baseDice: 0, bonus: 0, featMode: 'normal', hope: false, inspired: false, enemyResource: false, miserable: false, exhausted: false };
  await assert.rejects(f.core.handle('gm', { action: 'roll', id: 'old-before-restore', rollEpoch: 0, config, raw: { feat: [1], success: [] } }), { status: 409 });
  assert.equal(f.doc.rolls.length, 0);
});

test('only GM sets battle enemy weariness without exposing it to players', async () => {
  const f = fixture();
  const heroId = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result.id;
  const enemyId = (await f.core.handle('gm', { action: 'command', method: 'addEnemy', args: [{ name: 'Ork' }] })).result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId });
  await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  const before = f.doc.publicRevision;
  await f.core.handle('gm', { action: 'command', method: 'setEnemyWeary', args: [enemyId, true] });
  assert.equal(f.doc.state.battle[0].weary, true);
  assert.equal(f.doc.publicRevision, before);
  assert.equal((await f.core.handle('p1', { action: 'snapshot' })).participants[0].weary, undefined);
  await assert.rejects(f.core.handle('p1', { action: 'command', method: 'setEnemyWeary', args: [enemyId, false] }), { status: 403 });
  await assert.rejects(f.core.handle('gm', { action: 'command', method: 'setEnemyWeary', args: [enemyId, 1] }), { status: 400 });
});

test('bound enemy roll spends exactly once and retains historical name and ID in backup', async () => {
  const f = fixture();
  const enemyId = (await f.core.handle('gm', { action: 'command', method: 'addEnemy', args: [{ name: 'Ork – wartownik', maxHate: 1, resourceType: 'determination' }] })).result.id;
  const config = { actor: 'enemy', baseDice: 0, bonus: 0, featMode: 'normal', target: '', hope: false, inspired: false, enemyResource: true, miserable: false, exhausted: true };
  const request = { action: 'roll', id: 'enemy-roll-01', enemyId, config, raw: { feat: [11], success: [1] } };
  const first = await f.core.handle('gm', request);
  assert.equal(first.rolls[0].name, 'Ork – wartownik');
  assert.equal(first.rolls[0].enemyId, enemyId);
  assert.equal(first.state.battle[0].hate, 0);
  await f.core.handle('gm', request);
  assert.equal(f.doc.state.battle[0].hate, 0);
  await assert.rejects(f.core.handle('gm', { ...request, enemyId: 'other' }), { status: 409 });
  await assert.rejects(f.core.handle('gm', { ...request, id: 'enemy-roll-02' }), { status: 409 });
  assert.equal(f.doc.rolls.length, 1);
  const backup = await f.core.handle('gm', { action: 'export' });
  backup.state.battle = [];
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [backup] });
  assert.equal(f.doc.rolls[0].entry.name, 'Ork – wartownik');
  assert.equal(f.doc.rolls[0].entry.enemyId, enemyId);
});

test('parallel last-point spends serialize, and invalid enemy bindings do not publish', async () => {
  const f = fixture();
  const enemyId = (await f.core.handle('gm', { action: 'command', method: 'addEnemy', args: [{ name: 'Ork', maxHate: 1 }] })).result.id;
  const base = { actor: 'enemy', baseDice: 0, bonus: 0, featMode: 'normal', target: '', hope: false, inspired: false, enemyResource: true, miserable: false, exhausted: false };
  const roll = id => ({ action: 'roll', id, enemyId, config: base, raw: { feat: [5], success: [1] } });
  const results = await Promise.allSettled([f.core.handle('gm', roll('enemy-race-1')), f.core.handle('gm', roll('enemy-race-2'))]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(f.doc.rolls.length, 1);
  assert.equal(f.doc.state.battle[0].hate, 0);
  await assert.rejects(f.core.handle('gm', { ...roll('enemy-race-3'), config: { ...base, actor: 'hero' } }), { status: 403 });
  await assert.rejects(f.core.handle('gm', { ...roll('enemy-race-4'), enemyId: 'missing' }), { status: 409 });
  const heroId = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result.id;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId });
  await f.core.handle('p1', { action: 'exchange', secret: link.secret });
  await assert.rejects(f.core.handle('p1', { ...roll('enemy-race-5'), heroId, config: { ...base, actor: 'hero' } }), { status: 403 });
  await f.core.handle('gm', { action: 'command', method: 'removeParticipant', args: [enemyId] });
  await assert.rejects(f.core.handle('gm', { ...roll('enemy-race-6'), config: { ...base, enemyResource: false }, raw: { feat: [5], success: [] } }), { status: 409 });
  assert.equal(f.doc.rolls.length, 1);
});

test('bound enemy roll backups preserve long imported names', async () => {
  const f = fixture();
  const name = 'Strażnik '.repeat(150);
  const enemyId = (await f.core.handle('gm', { action: 'command', method: 'addEnemy', args: [{ name, maxHate: 1 }] })).result.id;
  const config = { actor: 'enemy', baseDice: 0, bonus: 0, featMode: 'normal', target: '', hope: false, inspired: false, enemyResource: false, miserable: false, exhausted: false };
  await f.core.handle('gm', { action: 'roll', id: 'long-enemy-name', enemyId, config, raw: { feat: [5], success: [] } });
  const backup = await f.core.handle('gm', { action: 'export' });
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [backup] });
  assert.equal(f.doc.rolls[0].entry.name, name);
  assert.equal(f.doc.rolls[0].entry.enemyId, enemyId);
});
