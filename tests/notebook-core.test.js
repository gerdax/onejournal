'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNotebook } = require('../state.js');
const { createServerCore, defaultDocument } = require('../server-core.js');

const note = text => ({ blocks: [{ type: 'paragraph', runs: [{ text }] }] });

function fixture() {
  let doc = defaultDocument();
  doc.links.push({ id: 'gm-link', role: 'gm', heroId: null, secretHash: 'gm', encryptedSecret: 'gm', version: 1, active: true });
  doc.grants.push({ uid: 'gm', linkId: 'gm-link', version: 1, role: 'gm', heroId: null, active: true });
  const repository = {
    get: async () => structuredClone(doc),
    compareAndSwap: async (expected, next) => {
      if (doc.revision !== expected) return false;
      doc = structuredClone(next);
      return true;
    }
  };
  const core = createServerCore({ repository, hashSecret: x => x, randomSecret: () => 'long-secret-for-player-link-12345678', encryptSecret: x => x, decryptSecret: x => x });
  return { core, get doc() { return doc; } };
}

async function addPlayer(f) {
  const hero = (await f.core.handle('gm', { action: 'command', method: 'saveHero', args: [{ name: 'A' }] })).result;
  const link = await f.core.handle('gm', { action: 'rotateLink', heroId: hero.id });
  await f.core.handle('player', { action: 'exchange', secret: link.secret });
}

test('notebook normalizer canonicalizes extras and rejects malformed or oversized content', () => {
  assert.deepEqual(normalizeNotebook({ blocks: [
    { type: 'paragraph', runs: [{ text: 'A', bold: true, ignored: 'x' }], ignored: 1 },
    { type: 'horizontalRule', runs: [{ text: 'ignored' }], ignored: 1 },
    { type: 'bulletList', items: [[{ text: 'B', italic: true }]] }
  ], ignored: true }), { blocks: [
    { type: 'paragraph', runs: [{ text: 'A', bold: true }] },
    { type: 'horizontalRule' },
    { type: 'bulletList', items: [[{ text: 'B', italic: true }]] }
  ] });
  for (const invalid of [null, {}, { blocks: [null] }, { blocks: [{ type: 'heading', runs: [] }] },
    { blocks: [{ type: 'paragraph', runs: [{ text: 4 }] }] },
    { blocks: [{ type: 'paragraph', runs: [{ text: 'x', bold: false }] }] },
    { blocks: [{ type: 'orderedList', items: ['not runs'] }] }, note('x'.repeat(10001)),
    { blocks: Array.from({ length: 1001 }, () => ({ type: 'paragraph', runs: [] })) }]) {
    assert.throws(() => normalizeNotebook(invalid));
  }
});

test('only GM can read or save notebook; notebook writes advance private revision only', async () => {
  const f = fixture();
  await addPlayer(f);
  const playerBefore = await f.core.handle('player', { action: 'snapshot' });
  const gmBefore = await f.core.handle('gm', { action: 'snapshot' });
  assert.deepEqual(gmBefore.notebook, { document: { blocks: [] }, version: 0 });
  assert.equal(Object.hasOwn(playerBefore, 'notebook'), false);
  await assert.rejects(f.core.handle('player', { action: 'notebookSave', document: note('secret'), version: 0 }), { status: 403 });
  const saved = await f.core.handle('gm', { action: 'notebookSave', document: note('secret'), version: 0 });
  assert.deepEqual(saved.result, { document: note('secret'), version: 1 });
  assert.equal(saved.revision, gmBefore.revision + 1);
  assert.equal(f.doc.publicRevision, playerBefore.revision);
  const playerAfter = await f.core.handle('player', { action: 'snapshot' });
  assert.deepEqual(playerAfter, playerBefore);
  assert.equal(JSON.stringify(playerAfter).includes('secret'), false);
  assert.equal(JSON.stringify(await f.core.handle('gm', { action: 'export' })).includes('secret'), true);
});

test('notebook optimistic version conflicts, retries, and unrelated game writes', async () => {
  const f = fixture();
  const first = await f.core.handle('gm', { action: 'notebookSave', document: note('one'), version: 0 });
  await f.core.handle('gm', { action: 'command', method: 'addLibrary', args: [{ name: 'Ork' }] });
  assert.deepEqual((await f.core.handle('gm', { action: 'notebookSave', document: note('one'), version: 0 })).result, first.result);
  await assert.rejects(f.core.handle('gm', { action: 'notebookSave', document: note('other'), version: 0 }), { status: 409 });
  await assert.rejects(f.core.handle('gm', { action: 'notebookSave', document: { blocks: [{ type: 'paragraph' }] }, version: 1 }), { status: 400 });
  assert.equal(f.doc.notebookVersion, 1);
  const second = await f.core.handle('gm', { action: 'notebookSave', document: note('two'), version: 1 });
  assert.equal(second.result.version, 2);
  await assert.rejects(f.core.handle('gm', { action: 'notebookSave', document: note('one'), version: 0 }), { status: 409 });
});

test('horizontal rules survive notebook save, snapshot, export and restore', async () => {
  const f = fixture();
  const document = { blocks: [
    { type: 'paragraph', runs: [{ text: 'Przed' }] },
    { type: 'horizontalRule' },
    { type: 'paragraph', runs: [{ text: 'Po' }] }
  ] };
  const saved = await f.core.handle('gm', { action: 'notebookSave', document, version: 0 });
  assert.deepEqual(saved.result.document, document);
  assert.deepEqual((await f.core.handle('gm', { action: 'snapshot' })).notebook.document, document);
  const backup = await f.core.handle('gm', { action: 'export' });
  assert.deepEqual(backup.notebook, document);
  await f.core.handle('gm', { action: 'notebookSave', document: { blocks: [] }, version: 1 });
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [backup] });
  assert.deepEqual(f.doc.notebook, document);
});

test('backup notebook is optional; present empty clears and malformed content leaves state untouched', async () => {
  const f = fixture();
  await f.core.handle('gm', { action: 'notebookSave', document: note('keep'), version: 0 });
  const backup = await f.core.handle('gm', { action: 'export' });
  assert.deepEqual(backup.notebook, note('keep'));
  const legacy = structuredClone(backup);
  delete legacy.notebook;
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [legacy] });
  assert.deepEqual(f.doc.notebook, note('keep'));
  assert.equal(f.doc.notebookVersion, 1);
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [backup] });
  assert.equal(f.doc.notebookVersion, 2);
  const empty = { ...backup, notebook: { blocks: [] } };
  await f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [empty] });
  assert.deepEqual(f.doc.notebook, { blocks: [] });
  assert.equal(f.doc.notebookVersion, 3);
  const before = structuredClone(f.doc);
  await assert.rejects(f.core.handle('gm', { action: 'command', method: 'restoreBackup', args: [{ ...backup, notebook: { blocks: 'bad' } }] }), { status: 400 });
  assert.deepEqual(f.doc, before);
});
