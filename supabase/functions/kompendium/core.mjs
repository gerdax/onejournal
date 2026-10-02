import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';
const historyEncoding = new Tiktoken(ranks);
export const DEFAULT_MODEL = 'gpt-5.4';
export const EMBEDDING_MODEL = 'text-embedding-3-small';
const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAsk(body) {
  if (!body || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000 || encoder.encode(body.question).length > 8000) throw new Error('Nieprawidłowe pytanie.');
  if (body.history != null && !Array.isArray(body.history)) throw new Error('Nieprawidłowa historia.');
  const history = body.history || [];
  if (history.length > 20 || history.some((m) => !m || !['user','assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > (m.role === 'assistant' ? 8000 : 2000) || (m.sources != null && (!Array.isArray(m.sources) || m.sources.some((s) => !s || !UUID.test(s.chunkId)))))) throw new Error('Nieprawidłowa historia.');
  const trimmed = history.slice(-6).map(({role,content,sources}) => ({role,content,sources: sources || []}));
  while (trimmed.length && historyTokens(trimmed) > 2000) trimmed.splice(0, Math.min(2, trimmed.length));
  return { question: body.question.trim(), history: trimmed };
}

export function historyTokens(history) {
  return history.reduce((sum, message) => sum + historyEncoding.encode(message.content, [], []).length + 8, 0);
}

export function pricing(model, raw) {
  const defaults = { 'gpt-5.4': { input: 2.5, cached: .25, output: 15 }, 'gpt-5.4-mini': { input: .75, cached: .075, output: 4.5 } };
  if (!raw && Object.hasOwn(defaults, model)) return { ...defaults[model] };
  if (!raw) throw new Error('Model wymaga jawnej konfiguracji cen.');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Nieprawidłowa konfiguracja cen.'); }
  const item = value[model];
  if (!item || !['input','cached','output'].every((key) => Number.isFinite(item[key]) && item[key] >= 0)) throw new Error('Brak ceny dla modelu.');
  return item;
}

export function cost(usage, rates) {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) return null;
  const cached = usage.input_tokens_details?.cached_tokens;
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > usage.input_tokens) return null;
  return ((usage.input_tokens - cached) * rates.input + cached * rates.cached + usage.output_tokens * rates.output) / 1e6;
}

export function parseResponse(payload, allowedIds) {
  if (!payload || payload.status !== 'completed' || !Array.isArray(payload.output)) throw new Error('Niepełna odpowiedź modelu.');
  const texts = payload.output.flatMap((o) => o.type === 'message' && o.role === 'assistant' ? (o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text) : []);
  if (texts.length !== 1 || typeof texts[0] !== 'string') throw new Error('Nieprawidłowa odpowiedź modelu.');
  let value;
  try { value = JSON.parse(texts[0]); } catch { throw new Error('Nieprawidłowy JSON modelu.'); }
  if (!value || typeof value.answer !== 'string' || !value.answer.trim() || value.answer.length > 8000 || typeof value.insufficient_context !== 'boolean' || !Array.isArray(value.source_chunk_ids)) throw new Error('Nieprawidłowa odpowiedź modelu.');
  if (value.insufficient_context || value.source_chunk_ids.some((id) => typeof id !== 'string' || !allowedIds.has(id)) || (!value.insufficient_context && value.source_chunk_ids.length === 0)) return { answer: 'Nie znalazłem wystarczających informacji w kompendium.', sourceIds: [], insufficient_context: true };
  return { answer: value.answer.trim(), sourceIds: [...new Set(value.source_chunk_ids)], insufficient_context: value.insufficient_context };
}

export function parseSseFrames(buffer) {
  const frames = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  for (const part of parts.slice(0,-1)) {
    const data = part.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data && data !== '[DONE]') { try { frames.push(JSON.parse(data)); } catch { throw new Error('Nieprawidłowy strumień modelu.'); } }
  }
  return { frames, remainder: parts.at(-1) };
}

export function provisionalAnswer(jsonText) {
  const match = /"answer"\s*:\s*"/.exec(jsonText);
  if (!match) return null;
  const start = match.index + match[0].length;
  let escaped = false;
  for (let i = start; i < jsonText.length; i++) {
    const char = jsonText[i];
    if (!escaped && char === '"') {
      try { return JSON.parse(`"${jsonText.slice(start, i)}"`); } catch { return null; }
    }
    if (!escaped && char === '\\') escaped = true;
    else escaped = false;
  }
  try { return JSON.parse(`"${jsonText.slice(start)}"`); } catch { return null; }
}

export function responseSchema() {
  return { type: 'object', additionalProperties: false, required: ['answer','source_chunk_ids','insufficient_context'], properties: {
    answer: { type: 'string' }, source_chunk_ids: { type: 'array', items: { type: 'string' } }, insufficient_context: { type: 'boolean' }
  } };
}

// Keep a new, self-contained question from inheriting the previous topic.
export function retrievalContext(question, history) {
  const continuation = /^(?:a|i|czyli)(?:\s|,)|^dlaczego\s*\?*$/iu.test(question) || /(?:^|\s)(?:wtedy|tego|temu|tym|tej|ten|tamten|ona|on|jej|jego|ją|to samo)(?=$|[\s,.?!])/iu.test(question);
  const contextualHistory = continuation ? history : [];
  const previous = continuation ? [...history].reverse().find(m => m.role === 'user')?.content || '' : '';
  const priorIds = continuation ? [...new Set(([...history].reverse().find(m => m.role === 'assistant')?.sources || []).map(s => s.chunkId))].slice(-6) : [];
  return { searchText: `${question} ${previous.slice(0, 400)}`.slice(0, 2000).trim(), priorIds, history: contextualHistory };
}
