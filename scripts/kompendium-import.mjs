/* Administrative CLI. Never runs in the browser or as part of a public build. */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { sha256, chunkPages, validatePrepared, safeTarget, assertTextLayer } from './kompendium-import-core.mjs';

const fail = message => { throw new Error(message); };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokenEncoding = getEncoding('cl100k_base');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function saveCheckpoint(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}
function checkedVector(vector) {
  if (!Array.isArray(vector) || vector.length !== 1536 || vector.some(n => !Number.isFinite(n))) fail('Nieprawidłowy embedding.');
  return vector;
}
function validateManifest(stored, chunks) {
  if (!Array.isArray(stored)) fail('Nieprawidłowy manifest wznowienia.');
  const found = new Set();
  for (const item of stored) {
    const expected = chunks[item.ordinal];
    if (!expected || found.has(item.ordinal) || item.content !== expected.content || item.embeddingText !== expected.content ||
      item.pdfPage !== expected.pdfPage || item.bookPage !== expected.bookPage || item.section !== expected.section) {
      fail(`Zapisane fragmenty nie odpowiadają bieżącej mapie stron (ordinal ${item.ordinal}). Import przerwany.`);
    }
    found.add(item.ordinal);
  }
  return found;
}
export async function main(argv = process.argv.slice(2)) {
  const args = [...argv], command = args.shift();
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!['prepare', 'upload'].includes(command)) {
    console.log('prepare --pdf PATH --title TITLE --out private-kompendium/review.json\nupload --pdf PATH --review PATH --reviewed --project-ref REF [--resume]');
    return;
  }
  const pdfPath = flag('--pdf') || fail('Wymagane --pdf.'), pdf = await readFile(pdfPath);
  if (pdf.length > 50 * 1024 * 1024 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('Wymagany PDF do 50 MiB.');
  if (command === 'prepare') {
    const output = flag('--out') || fail('Wymagane --out w prywatnym katalogu.'), title = flag('--title') || fail('Wymagane --title.');
    // A tracked review would expose the entire handbook. Only use the ignored directory.
    const target = resolve(output), privateRoot = resolve(root, 'private-kompendium');
    if (!target.startsWith(privateRoot + '/')) fail('Zapis ekstrakcji dozwolony tylko w ignorowanym private-kompendium/.');
    const { stdout } = await promisify(execFile)(process.env.PYTHON || 'python3', [resolve(root, 'scripts/kompendium-extract.py'), resolve(pdfPath)], { maxBuffer: 64 * 1024 * 1024 });
    const extracted = JSON.parse(stdout);
    assertTextLayer(extracted);
    const prepared = { format: 'onejournal-kompendium-import', version: 1, title, pdfSha256: sha256(pdf), pageCount: extracted.length,
      pages: extracted.map(page => ({ ...page, bookPage: null, section: '', exclude: false })) };
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(prepared, null, 2), { mode: 0o600 });
    console.log(`Przygotowano ${extracted.length} stron. Sprawdź tekst i tabele, uzupełnij bookPage/section; jawnie wyklucz puste strony. Nic nie wysłano.`);
    return;
  }
  if (!args.includes('--reviewed')) fail('Sprawdź ekstrakcję i mapę stron, następnie podaj --reviewed.');
  const prepared = JSON.parse(await readFile(flag('--review') || fail('Wymagane --review.'), 'utf8'));
  const pages = validatePrepared(prepared, pdf), chunks = chunkPages(pages, tokenEncoding);
  const projectRef = flag('--project-ref') || fail('Wymagane --project-ref testowego projektu.');
  const base = safeTarget(process.env.SUPABASE_URL || fail('Brak SUPABASE_URL.'), projectRef);
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || fail('Brak SUPABASE_SERVICE_ROLE_KEY.');
  const apiKey = process.env.OPENAI_API_KEY || fail('Brak OPENAI_API_KEY.');
  const embeddingModel = 'text-embedding-3-small';
  const price = Number(process.env.KOMPENDIUM_EMBEDDING_INPUT_PRICE || '0.02');
  if (!Number.isFinite(price) || price < 0) fail('Nieprawidłowa cena embeddingów.');
  const priceSnapshot = { input: price, cached: price, output: 0, unit: 'USD/1M tokens' };
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  async function rpc(name, body, retryable = true) {
    for (let attempt = 0; attempt < (retryable ? 4 : 1); attempt++) {
      try {
        const response = await fetch(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        if (!response.ok) {
          if (retryable && response.status >= 500 && attempt < 3) { await wait(300 * 2 ** attempt); continue; }
          fail(`Operacja ${name} nie powiodła się (${response.status}); poprzedni indeks pozostaje aktywny.`);
        }
        const text = await response.text(); return text ? JSON.parse(text) : null;
      } catch (error) {
        if (retryable && (error instanceof TypeError || error?.name === 'TimeoutError') && attempt < 3) {
          await wait(300 * 2 ** attempt); continue;
        }
        throw error;
      }
    }
  }
  const resume = args.includes('--resume');
  let previous = resume ? await rpc('kompendium_resume_import', { p_title: prepared.title, p_pdf_pages: pages.length, p_sha256: prepared.pdfSha256 }) : null;
  if (resume && !previous) fail('Brak zgodnego, nieaktywnego importu do wznowienia. Uruchom upload bez --resume, aby utworzyć nowy.');
  const storagePath = previous?.storagePath || `${prepared.pdfSha256}/${randomUUID()}.pdf`;
  const documentId = previous?.documentId || await rpc('kompendium_begin_import',
    { p_title: prepared.title, p_storage_path: storagePath, p_pdf_pages: pages.length, p_sha256: prepared.pdfSha256 }, false);
  if (typeof documentId !== 'string' || !/^[a-f0-9-]{36}$/i.test(documentId) ||
      !storagePath.startsWith(`${prepared.pdfSha256}/`)) fail('Nieprawidłowy dokument importu.');
  const leaseToken = randomUUID();
  const lease = () => rpc('kompendium_claim_import', { p_document_id: documentId, p_token: leaseToken });
  if (await lease() !== true) fail('Ten import jest już wznawiany przez inny proces. Spróbuj ponownie po jego zakończeniu.');
  try {
  if (resume) {
    const fresh = await rpc('kompendium_resume_import', { p_title: prepared.title, p_pdf_pages: pages.length, p_sha256: prepared.pdfSha256 });
    if (!fresh || fresh.documentId !== documentId || fresh.storagePath !== storagePath) fail('Dokument importu zmienił się przed przejęciem blokady. Ponów --resume.');
    previous = fresh;
  }
  const stored = validateManifest(previous?.chunks || [], chunks);
  const checkpointDir = resolve(root, 'private-kompendium', 'checkpoints');
  await mkdir(checkpointDir, { recursive: true, mode: 0o700 });
  const checkpointPath = resolve(checkpointDir, `${documentId}.json`);
  const chunkDigest = sha256(JSON.stringify(chunks));
  let checkpoint;
  try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (checkpoint && (checkpoint.documentId !== documentId || checkpoint.project !== base || checkpoint.pdfSha256 !== prepared.pdfSha256 ||
      checkpoint.chunkDigest !== chunkDigest || checkpoint.storagePath !== storagePath || !checkpoint.batches || typeof checkpoint.batches !== 'object')) {
    fail('Prywatny checkpoint nie odpowiada importowi. Sprawdź go ręcznie.');
  }
  checkpoint ||= { version: 1, documentId, project: base, pdfSha256: prepared.pdfSha256, chunkDigest, storagePath, batches: {} };
  await saveCheckpoint(checkpointPath, checkpoint);
  if (!previous?.pdfUploaded) {
    const uploaded = await fetch(`${base}/storage/v1/object/onejournal-kompendium/${storagePath}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store' }, body: pdf, signal: AbortSignal.timeout(120000) });
    if (!uploaded.ok) fail(`Wgrywanie PDF nie powiodło się (${uploaded.status}).`);
  }
  for (let i = 0; i < chunks.length; i += 32) {
    if (await lease() !== true) fail('Utracono wyłączność importu.');
    const batch = chunks.slice(i, i + 32).filter(chunk => !stored.has(chunk.ordinal));
    if (!batch.length) continue;
    const cached = checkpoint.batches[i];
    if (cached && (!Array.isArray(cached.items) || batch.some(chunk => !cached.items.some(item => item.ordinal === chunk.ordinal)))) {
      fail(`Niekompletny checkpoint dla partii ${i}.`);
    }
    const id = cached?.usage?.p_id || randomUUID();
    const baseUsage = { p_id: id, p_uid: null, p_operation: 'indexing', p_question_id: null, p_provider_request_id: null, p_model: embeddingModel,
      p_input_tokens: null, p_cached_input_tokens: null, p_output_tokens: null, p_cost_usd: null, p_incomplete: true, p_error: null, p_price_snapshot: priceSnapshot };
    let data = cached;
    if (!data) {
      await rpc('kompendium_record_usage', baseUsage);
      let response, result;
      try {
        response = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: embeddingModel, input: batch.map(chunk => chunk.content), dimensions: 1536 }), signal: AbortSignal.timeout(60000) });
        result = await response.json();
      } catch {
        await rpc('kompendium_record_usage', { ...baseUsage, p_error: 'provider_unavailable' });
        fail('Przerwane wywołanie embeddingów; zapisano niepełne zużycie. Import nie został aktywowany.');
      }
      const tokens = result?.usage?.prompt_tokens, known = Number.isSafeInteger(tokens) && tokens >= 0;
      const usage = { ...baseUsage, p_provider_request_id: response.headers.get('x-request-id'), p_input_tokens: known ? tokens : null,
        p_cached_input_tokens: known ? 0 : null, p_output_tokens: known ? 0 : null, p_cost_usd: known ? tokens * price / 1e6 : null,
        p_incomplete: !known, p_error: response.ok ? null : 'provider_error' };
      if (!response.ok || !Array.isArray(result.data) || result.data.length !== batch.length) {
        await rpc('kompendium_record_usage', usage);
        fail('Błąd embeddingów. Import nie został aktywowany.');
      }
      let items;
      try { items = batch.map((chunk, j) => ({ ordinal: chunk.ordinal, vector: checkedVector(result.data.find(item => item.index === j)?.embedding) })); }
      catch (error) { await rpc('kompendium_record_usage', usage); throw error; }
      data = { usage, items };
      checkpoint.batches[i] = data;
      try { await saveCheckpoint(checkpointPath, checkpoint); }
      catch (error) { await rpc('kompendium_record_usage', usage); throw error; }
    }
    await rpc('kompendium_record_usage', data.usage);
    for (const chunk of batch) {
      if (await lease() !== true) fail('Utracono wyłączność importu.');
      const vector = checkedVector(data.items.find(item => item.ordinal === chunk.ordinal)?.vector);
      await rpc('kompendium_add_chunk', { p_document_id: documentId, p_ordinal: chunk.ordinal, p_content: chunk.content, p_embedding_text: chunk.content,
        p_pdf_page: chunk.pdfPage, p_book_page: chunk.bookPage, p_section: chunk.section, p_embedding: JSON.stringify(vector) });
    }
    console.log(`Zindeksowano ${Math.min(i + 32, chunks.length)}/${chunks.length} fragmentów.`);
  }
  if (await lease() !== true) fail('Utracono wyłączność importu.');
  const activated = await rpc('kompendium_activate_import', { p_document_id: documentId, p_expected_chunks: chunks.length });
  if (activated !== true) fail('Nie udało się aktywować kompletnego indeksu.');
  console.log(`Aktywowano podręcznik ${documentId}; wcześniejszy indeks zachowano.`);
  } finally {
    try { await rpc('kompendium_release_import', { p_document_id: documentId, p_token: leaseToken }); }
    catch (error) { console.error(`Nie udało się zwolnić blokady importu: ${error.message}`); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
