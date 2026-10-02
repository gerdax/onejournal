const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = import('../scripts/kompendium-import-core.mjs');
test('a scanned book containing only a repeated watermark cannot be indexed', async () => {
  const { assertTextLayer } = await core;
  assert.throws(() => assertTextLayer(Array.from({ length: 200 }, () => ({ text: 'Buyer watermark and order number only' }))), /OCR/);
  assert.doesNotThrow(() => assertTextLayer(Array.from({ length: 10 }, (_, i) => ({ text: `Header\nUnique paragraph ${i} containing actual printed rules and more than thirty characters.` }))));
});
test('review requires every physical page, numbering and explicit exclusion of empty text', async () => {
  const { validatePages } = await core;
  const page = { pdfPage: 1, text: 'a'.repeat(50), bookPage: 'iv', section: '', exclude: false };
  assert.equal(validatePages([page], 1)[0].bookPage, 'iv');
  assert.throws(() => validatePages([{ ...page, pdfPage: 2 }], 1));
  assert.throws(() => validatePages([{ ...page, text: '' }], 1));
  assert.equal(validatePages([{ ...page, text: '', exclude: true }], 1).length, 1);
});
test('overlapping chunks never cross pages or create redundant tail chunks', async () => {
  const { chunkPages } = await core;
  const tokenizer = { encode: text => [...text], decode: tokens => tokens.join('') };
  const pages = [1, 2].map(pdfPage => ({ pdfPage, text: String(pdfPage).repeat(950), bookPage: String(pdfPage), exclude: false }));
  const chunks = chunkPages(pages, tokenizer, 550, 100);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.map(c => c.pdfPage), [1, 1, 2, 2]);
  chunks.forEach(c => assert.equal(new Set(c.content).size, 1));
});
test('a review cannot be used with another PDF or an unintended project', async () => {
  const { validatePrepared, safeTarget, sha256 } = await core;
  const pdf = Buffer.from('%PDF-fixture');
  assert.throws(() => validatePrepared({ format: 'onejournal-kompendium-import', version: 1, pdfSha256: sha256(Buffer.from('other')) }, pdf));
  assert.equal(safeTarget('https://test-ref.supabase.co', 'test-ref'), 'https://test-ref.supabase.co');
  assert.throws(() => safeTarget('https://production.supabase.co', 'test-ref'));
  assert.throws(() => safeTarget('https://test-ref.supabase.co.evil.test', 'test-ref'));
});
test('token boundaries preserve multibyte characters in Polish passages', async () => {
  const { chunkPages } = await core;
  const { getEncoding } = await import('js-tiktoken');
  const chunks = chunkPages([{ pdfPage: 1, text: 'Źdźbło żółtej trawy, wytrzymałość i mądrość 🧙. '.repeat(300), bookPage: '1', exclude: false }], getEncoding('cl100k_base'));
  assert(chunks.length > 1);
  assert(chunks.every(chunk => !chunk.content.includes('\ufffd')));
});
