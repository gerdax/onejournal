/* Execute the real Edge handler with a closed fake network, no live credentials. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
test('Edge function protects access, streams validated citations, and records provider usage', async t => {
  const nativeFetch = global.fetch;
  const chunkId = '11111111-1111-4111-8111-111111111111', documentId = '22222222-2222-4222-8222-222222222222';
  const gm = '33333333-3333-4333-8333-333333333333';
  let handler, mode = 'valid', providerCalls = 0, providerBody, retrievalBody;
  const usage = [], backgrounds = [];
  const env = { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', OPENAI_API_KEY: 'fixture-openai', ONEJOURNAL_ALLOWED_ORIGINS: 'https://fixture.test' };
  global.Deno = { env: { get: key => env[key] }, serve: fn => { handler = fn; } };
  global.EdgeRuntime = { waitUntil: task => backgrounds.push(task) };
  const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (url === env.SUPABASE_URL + '/auth/v1/user') return json({ id: options.headers.Authorization === 'Bearer player' ? 'player' : gm });
    if (url.startsWith(env.SUPABASE_URL + '/rest/v1/rpc/')) {
      const rpc = url.split('/').at(-1);
      if (rpc === 'kompendium_access') return json(body.p_uid === gm);
      if (rpc === 'kompendium_admit') return json(mode !== 'limited');
      if (rpc === 'kompendium_record_usage') { usage.push(body); return new Response(null, { status: 204 }); }
      if (rpc === 'kompendium_retrieve') {
        retrievalBody = body;
        return json([{ chunk_id: chunkId, document_id: documentId, content: 'Postawa obronna.', pdf_page: 2, book_page: '1', section: 'Postawy' }]);
      }
      if (rpc === 'kompendium_neighbors') { assert.deepEqual(body.p_ids, [chunkId]); return json([]); }
      if (rpc === 'kompendium_usage_summary') return json({ month: { costUsd: .1 }, allTime: { costUsd: .2 } });
      if (rpc === 'kompendium_issue_ticket') return json(body.p_uid === gm);
      if (rpc === 'kompendium_redeem_ticket') return json(mode === 'expired' ? null : { storagePath: 'book.pdf', pdfPage: 2, title: 'Fixture' });
      throw new Error('Unexpected RPC: ' + rpc);
    }
    if (url.includes('/storage/v1/object/sign/')) return json({ signedURL: '/object/sign/onejournal-kompendium/book.pdf?token=fixture' });
    if (url === 'https://api.openai.com/v1/embeddings') {
      providerCalls++;
      return json({ data: [{ embedding: mode === 'bad-vector' ? [] : [1, ...Array(1535).fill(0)] }], usage: { prompt_tokens: 10 } }, 200, { 'x-request-id': 'embedding-' + providerCalls });
    }
    if (url === 'https://api.openai.com/v1/responses') {
      providerCalls++; providerBody = body;
      const text = JSON.stringify({ answer: 'Przykładowa odpowiedź.', source_chunk_ids: [mode === 'bad-source' ? 'fake' : chunkId], insufficient_context: false });
      const events = [{ type: 'response.output_text.delta', delta: text }];
      if (mode === 'token-limit') events.push({ type: 'response.incomplete', response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 4096, output_tokens_details: { reasoning_tokens: 4000 } }, incomplete_details: { reason: 'max_output_tokens' } } });
      if (mode !== 'partial' && mode !== 'token-limit') events.push({ type: 'response.completed', response: { id: 'response-fixture', status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30 }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } });
      return new Response(events.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'response-' + providerCalls } });
    }
    throw new Error('Network is disabled in this fixture: ' + url);
  };
  const call = (body, token = 'gm', origin = 'https://fixture.test') => handler(new Request(env.SUPABASE_URL + '/functions/v1/kompendium', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }));
  const final = text => JSON.parse(text.split('\n\n').find(frame => frame.startsWith('event: done'))?.split('\ndata: ')[1]);
  try {
    ({ handleRequest: handler } = await import('../supabase/functions/kompendium/index.ts'));
    await t.test('rejects missing authentication, players, foreign origins and throttled requests before billing', async () => {
      assert.equal((await call({ action: 'ask', question: 'Postawa?' }, null)).status, 401);
      assert.equal((await call({ action: 'ask', question: 'Postawa?' }, 'player')).status, 403);
      assert.equal((await call({ action: 'ask', question: 'Postawa?' }, 'gm', 'https://foreign.test')).status, 403);
      mode = 'limited'; assert.equal((await call({ action: 'ask', question: 'Postawa?' })).status, 429);
      mode = 'valid'; assert.equal(providerCalls, 0);
      assert.equal((await call({ action: 'ask', question: '' })).status, 400);
    });
    await t.test('uses bounded stateless model context, validates source IDs and saves cached usage', async () => {
      const result = await call({ action: 'ask', question: 'A obrona?', history: [{ role: 'user', content: 'Postawa?' }, { role: 'assistant', content: 'Tak.', sources: [{ chunkId }] }] });
      const output = await result.text();
      assert.equal(final(output).sources[0].pdfPage, 2);
      assert.equal(providerBody.store, false);
      assert.equal(providerBody.reasoning.effort, 'medium');
      assert.equal(providerBody.max_output_tokens, 4096);
      assert.match(retrievalBody.p_query, /Postawa/);
      assert.deepEqual(retrievalBody.p_prior_ids, [chunkId]);
      const recorded = usage.findLast(row => row.p_operation === 'question');
      assert.equal(recorded.p_cached_input_tokens, 20);
      assert.equal(recorded.p_incomplete, false);
      assert.equal(recorded.p_cost_usd, (80 * 2.5 + 20 * .25 + 30 * 15) / 1e6);
      assert(!JSON.stringify(usage).includes('Przykładowa odpowiedź'));
    });
    await t.test('three long answers reach token trimming rather than the old byte limit', async () => {
      const pair = [{role:'user',content:'Podróż?'},{role:'assistant',content:'Opis podróży i warunków jej przebiegu. '.repeat(160),sources:[{chunkId}]}];
      const history = [...pair,...pair,...pair];
      assert(new TextEncoder().encode(JSON.stringify(history)).length > 16000);
      const response = await call({action:'ask',question:'A co wtedy?',history});
      assert.equal(response.status,200);
      assert(final(await response.text()).answer);
    });
    await t.test('unknown citation becomes insufficient context; interrupted stream never becomes a final answer', async () => {
      mode = 'bad-source';
      const rejected = final(await (await call({ action: 'ask', question: 'Postawa?' })).text());
      assert.equal(rejected.insufficient_context, true); assert.deepEqual(rejected.sources, []);
      mode = 'partial';
      const interrupted = await (await call({ action: 'ask', question: 'Postawa?' })).text();
      assert(interrupted.includes('event: error')); assert(!interrupted.includes('event: done'));
      assert.equal(usage.findLast(row => row.p_operation === 'question').p_incomplete, true);
    });
    await t.test('output limit bills reasoning once and requires explicit retry', async () => {
      mode = 'token-limit';
      const before = providerCalls;
      const output = await (await call({ action: 'ask', question: 'Złożona reguła?' })).text();
      assert(output.includes('event: error')); assert(!output.includes('event: done'));
      assert.equal(providerCalls, before + 2);
      const billed = usage.findLast(row => row.p_operation === 'question');
      assert.equal(billed.p_output_tokens, 4096);
      assert.equal(billed.p_cost_usd, (80 * 2.5 + 20 * .25 + 4096 * 15) / 1e6);
      assert.equal(billed.p_incomplete, true);
    });
    await t.test('redeems scoped ticket without game JWT and normalizes the storage signed URL', async () => {
      mode = 'valid';
      const response = await call({ action: 'redeem', ticket: 'a'.repeat(43) }, null);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).url, 'https://fixture.supabase.co/storage/v1/object/sign/onejournal-kompendium/book.pdf?token=fixture');
      mode = 'expired'; assert.equal((await call({ action: 'redeem', ticket: 'a'.repeat(43) }, null)).status, 403);
    });
    await t.test('a billed malformed embedding retains known tokens and cost', async () => {
      mode = 'bad-vector';
      const result = await (await call({ action: 'ask', question: 'Postawa?' })).text();
      assert(result.includes('event: error'));
      const measured = usage.findLast(row => row.p_operation === 'embedding');
      assert.equal(measured.p_input_tokens, 10);
      assert.equal(measured.p_cost_usd, 10 * .02 / 1e6);
    });
  } finally {
    await Promise.all(backgrounds);
    global.fetch = nativeFetch; delete global.Deno; delete global.EdgeRuntime;
  }
});
