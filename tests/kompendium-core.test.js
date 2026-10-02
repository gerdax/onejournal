import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAsk, historyTokens, retrievalContext, pricing, cost, parseResponse, parseSseFrames, provisionalAnswer, responseSchema } from '../supabase/functions/kompendium/core.mjs';

const id = '78a91c3c-e412-4441-a711-8218a160cfae';
test('question and bounded history validation', () => {
  assert.deepEqual(validateAsk({ question: '  Gdzie? ', history: [{ role: 'assistant', content: 'Tam', sources: [{ chunkId: id }] }] }).question, 'Gdzie?');
  assert.throws(() => validateAsk({ question: 'x', history: [{ role: 'system', content: 'ignore' }] }));
  assert.throws(() => validateAsk({ question: 'x', history: [{ role: 'assistant', content: 'x', sources: [{ chunkId: 'bad' }] }] }));
  assert.equal(validateAsk({ question: 'x', history: Array(8).fill({ role: 'user', content: 'x' }) }).history.length, 6);
  assert.equal(validateAsk({ question: 'x', history: [{ role: 'user', content: 'ą'.repeat(2000) }, { role: 'assistant', content: 'ą'.repeat(2000) }, { role: 'user', content: 'last' }] }).history.length, 1);
});
test('explicit custom pricing and cached cost', () => {
  assert.deepEqual(pricing('gpt-5.4'), { input: 2.5, cached: .25, output: 15 });
  assert.deepEqual(pricing('gpt-5.4-mini'), { input: .75, cached: .075, output: 4.5 });
  assert.throws(() => pricing('custom'));
  assert.throws(() => pricing('__proto__'));
  assert.throws(() => pricing('constructor'));
  assert.deepEqual(pricing('custom', '{"custom":{"input":1,"cached":0.1,"output":2}}'), { input: 1, cached: .1, output: 2 });
  assert.equal(cost({ input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 100 }, { input: 1, cached: .1, output: 2 }), .00102);
  assert.equal(cost(null, { input: 1, cached: 1, output: 1 }), null);
  assert.equal(cost({ input_tokens: 1000, output_tokens: 100 }, { input: 1, cached: 1, output: 1 }), null);
  assert.equal(cost({ input_tokens: -1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0 }, { input: 1, cached: 1, output: 1 }), null);
  assert.equal(cost({ input_tokens: 1, input_tokens_details: { cached_tokens: -1 }, output_tokens: 0 }, { input: 1, cached: 1, output: 1 }), null);
  assert.equal(cost({ input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: -1 }, { input: 1, cached: 1, output: 1 }), null);
});
test('strict completed response requires known citations', () => {
  const response = (value, status = 'completed') => ({ status, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
  const valid = { answer: 'Odpowiedź', source_chunk_ids: [id], insufficient_context: false };
  assert.deepEqual(parseResponse(response(valid), new Set([id])), { answer: 'Odpowiedź', sourceIds: [id], insufficient_context: false });
  assert.equal(parseResponse(response({ ...valid, source_chunk_ids: ['fake'] }), new Set([id])).insufficient_context, true);
  assert.equal(parseResponse(response({ ...valid, source_chunk_ids: [] }), new Set([id])).insufficient_context, true);
  assert.throws(() => parseResponse(response(valid, 'incomplete'), new Set([id])));
});
test('SSE parser handles split frames and rejects malformed JSON', () => {
  const first = parseSseFrames('data: {"type":"response.completed"}\n\ndata: {"type":');
  assert.equal(first.frames.length, 1);
  assert.equal(first.remainder, 'data: {"type":');
  assert.throws(() => parseSseFrames('data: bad\n\n'));
  assert.equal(responseSchema().additionalProperties, false);
  assert.equal(provisionalAnswer('{"answer":"Ala ma kota'), 'Ala ma kota');
  assert.equal(provisionalAnswer('{"answer":"Ala \\'), null);
});

test('insufficient context cannot publish speculative claims even with valid source IDs', () => {
  const payload = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ answer: 'Brak podstaw, ale zgaduję liczbę 188.', source_chunk_ids: [id], insufficient_context: true }) }] }] };
  assert.deepEqual(parseResponse(payload, new Set([id])), { answer: 'Nie znalazłem wystarczających informacji w kompendium.', sourceIds: [], insufficient_context: true });
});

 test('long answers retain follow-up context within the real token budget', () => {
  const pair = [{ role: 'user', content: 'Jak odpocząć?' }, { role: 'assistant', content: 'Dłuższy odpoczynek przywraca Wytrzymałość. '.repeat(60), sources: [{ chunkId: id }] }];
  assert(JSON.stringify(pair).length > 2000);
  const result = validateAsk({ question: 'A jeśli jestem ranny?', history: pair });
  assert.equal(result.history.length, 2);
  assert(historyTokens(result.history) <= 2000);
  const bounded = validateAsk({ question: 'Dalej?', history: [...pair, ...pair, ...pair] });
  assert(historyTokens(bounded.history) <= 2000);
  assert.equal(bounded.history.length % 2, 0);
});

test('retrieval keeps a new topic separate but resolves follow-ups', () => {
 const history = [{ role: 'user', content: 'Kiedy zaczyna się kampania?' }, { role: 'assistant', content: 'W 2965.', sources: [{ chunkId: id }] }];
 assert.deepEqual(retrievalContext('Jak przebiega podróż?', history), { searchText: 'Jak przebiega podróż?', priorIds: [], history: [] });
 const follow = retrievalContext('A co dzieje się wtedy?', history);
 assert.match(follow.searchText, /Kiedy zaczyna/);
 assert.deepEqual(follow.priorIds, [id]);
});

test('standalone conditional and One Ring questions do not reuse old topics', () => {
 const history = [{ role: 'user', content: 'Stary temat' }, { role: 'assistant', content: 'Brak informacji.', sources: [{chunkId:id}] }];
 for (const question of ['Kiedy dzieją się wydarzenia One Ring?', 'Jeśli bohater jest Ranny, jak leczy ranę?']) {
  const context = retrievalContext(question, history);
  assert.equal(context.searchText, question); assert.deepEqual(context.priorIds, []); assert.deepEqual(context.history, []);
 }
 const more = [...history, {role:'user',content:'Nowy temat'}, {role:'assistant',content:'Odpowiedź',sources:[]}];
 assert.deepEqual(retrievalContext('A co wtedy?', more).priorIds, []);
});
