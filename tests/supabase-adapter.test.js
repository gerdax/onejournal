const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../supabase-adapter.js'), 'utf8');
function fixture(handler) {
  const saved = new Map([['onejournal:auth:/game/:https://example.supabase.co', JSON.stringify({ access_token: 'old', refresh_token: 'refresh', expires_at: Date.now() / 1000 + 3600 })]]);
  const calls = [];
  const context = { WebSocket: { OPEN: 1 }, window: {}, location: { pathname: '/game/' }, URL, AbortController, setTimeout, clearTimeout, sessionStorage: { getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v), removeItem: k => saved.delete(k) },
    fetch: async (url, options) => { calls.push({url,options}); const [status, body] = handler(url, options, calls.length); return { ok: status < 400, status, json: async () => body }; } };
  vm.runInNewContext(source, context);
  return { calls, transport: context.window.OneJournalSupabase.createTransport({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'public' }) };
}
test('401 refreshes once and retries the same request with the new token', async () => {
  const f = fixture((url, options, n) => {
    if (n === 1) return [401, { error: 'Sesja wygasła.' }];
    if (n === 2) { assert(url.includes('/token?')); return [200, { access_token: 'new', refresh_token: 'refresh2', expires_in: 3600 }]; }
    assert.equal(options.headers.Authorization, 'Bearer new');
    return [200, { ok: true }];
  });
  await f.transport.request({ action: 'snapshot' });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].options.body, f.calls[2].options.body);
});
test('revoked access is not retried or exchanged', async () => {
  const f = fixture(() => [403, { error: 'Dostęp wygasł.' }]);
  await assert.rejects(f.transport.request({ action: 'snapshot' }), { status: 403 });
  assert.equal(f.calls.length, 1);
});
test('repeated unauthorized response stops after one retry', async () => {
  const f = fixture(url => url.includes('/token?') ? [200, { access_token: 'new', refresh_token: 'refresh2', expires_in: 3600 }] : [401, { error: 'Sesja wygasła.' }]);
  await assert.rejects(f.transport.request({ action: 'snapshot' }), { status: 401 });
  assert.equal(f.calls.length, 3);
});
