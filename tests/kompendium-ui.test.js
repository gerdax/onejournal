const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ReadableStream } = require('node:stream/web');

function transportWith(fetchImpl) {
  const storage = new Map();
  const context = { window: {}, location: { pathname: '/' }, sessionStorage: {
    getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)
  }, fetch: fetchImpl, URL, AbortController, TextDecoder, ReadableStream, setTimeout, clearTimeout, Date, JSON, WebSocket: class { static OPEN = 1; } };
  vm.runInNewContext(fs.readFileSync('supabase-adapter.js', 'utf8'), context);
  return context.window.OneJournalSupabase.createTransport({ supabaseUrl: 'https://example.test', supabaseAnonKey: 'anon' });
}
function stream(chunks) {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
}
test('Kompendium consumes split SSE frames and keeps full provisional delta', async () => {
  const events = []; let calls = 0;
  const transport = transportWith(async (url, options) => {
    if (url.endsWith('/auth/v1/signup')) return { ok: true, json: async () => ({ access_token: 'jwt', refresh_token: 'refresh', expires_in: 3600 }) };
    calls++; assert.equal(options.headers.Authorization, 'Bearer jwt');
    return { ok: true, body: stream(['event: status\r', '\ndata: {"message":"Szukam"}\r\n\r', '\nevent: delta\ndata: {"text":"A"}\n\nevent: delta\ndata: {"text":"AB"}\n\nevent: done\ndata: {"answer":"AB","sources":[]}\n\n']) };
  });
  const result = await transport.compendium({ action: 'ask', question: 'Pytanie', history: [] }, { onEvent: (name, payload) => events.push([name, payload]) });
  assert.equal(calls, 1); assert.equal(result.answer, 'AB');
  assert.deepEqual(events.map(item => item[0]), ['status', 'delta', 'delta', 'done']);
  assert.equal(events[2][1].text, 'AB');
});
test('Kompendium never retries an interrupted paid stream', async () => {
  let calls = 0;
  const transport = transportWith(async url => {
    if (url.endsWith('/auth/v1/signup')) return { ok: true, json: async () => ({ access_token: 'jwt', refresh_token: 'refresh', expires_in: 3600 }) };
    calls++; return { ok: true, body: stream(['event: delta\ndata: {"text":"część"}\n\n']) };
  });
  await assert.rejects(transport.compendium({ action: 'ask', question: 'Pytanie' }), /przerwana/);
  assert.equal(calls, 1);
});
