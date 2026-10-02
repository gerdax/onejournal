/* Fully isolated importer exercise: fake PDF bytes and closed network. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

test('interrupted upload resumes stored chunks and checkpointed embeddings without another provider call', async () => {
  const { main } = await import('../scripts/kompendium-import.mjs');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'onejournal-resume-'));
  const pdf = Buffer.from('%PDF-1.4\nprivate fixture\n');
  const sha = createHash('sha256').update(pdf).digest('hex');
  const pdfPath = path.join(temp, 'fixture.pdf'), reviewPath = path.join(temp, 'review.json');
  const id = randomUUID(), stored = new Map();
  const checkpointPath = path.join(__dirname, '../private-kompendium/checkpoints', `${id}.json`);
  const savedEnv = { ...process.env }, originalFetch = global.fetch;
  let providerCalls = 0, uploadCalls = 0, addZeroCalls = 0, resumeReads = 0, failSecond = true, claimed = null;
  const reply = (value, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(value), json: async () => value,
    headers: { get: () => 'provider-request-fixture' } });
  try {
    await fs.writeFile(pdfPath, pdf);
    await fs.writeFile(reviewPath, JSON.stringify({ format: 'onejournal-kompendium-import', version: 1, title: 'Fixture', pdfSha256: sha,
      pageCount: 2, pages: [1, 2].map(pdfPage => ({ pdfPage, text: `Strona ${pdfPage}: dużo tekstu o zasadach gry i przebiegu prób bohaterów.`,
        bookPage: String(pdfPage), section: 'Zasady', exclude: false })) }));
    Object.assign(process.env, { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', OPENAI_API_KEY: 'fixture-openai' });
    global.fetch = async (url, options) => {
      const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : null;
      if (url === 'https://api.openai.com/v1/embeddings') {
        providerCalls++;
        return reply({ data: body.input.map((_, index) => ({ index, embedding: [1, ...Array(1535).fill(0)] })), usage: { prompt_tokens: 100 } });
      }
      if (url.includes('/storage/v1/object/')) { uploadCalls++; return reply({}); }
      const rpc = url.split('/').pop();
      if (rpc === 'kompendium_begin_import') return reply(id);
      if (rpc === 'kompendium_resume_import') return reply({ documentId: id, storagePath: `${sha}/${id}.pdf`, pdfUploaded: true,
        chunks: [...stored.values()].map(chunk => ({ ordinal: chunk.p_ordinal, content: chunk.p_content, embeddingText: chunk.p_embedding_text,
          pdfPage: chunk.p_pdf_page, bookPage: chunk.p_book_page, section: chunk.p_section })) });
      if (rpc === 'kompendium_claim_import') { if (claimed && claimed !== body.p_token) return reply(false); claimed = body.p_token; return reply(true); }
      if (rpc === 'kompendium_release_import') { if (claimed === body.p_token) claimed = null; return reply(null); }
      if (rpc === 'kompendium_record_usage') return reply(null);
      if (rpc === 'kompendium_add_chunk') {
        if (body.p_ordinal === 0) addZeroCalls++;
        if (body.p_ordinal === 1 && failSecond) throw new TypeError('network down');
        stored.set(body.p_ordinal, body); return reply(null);
      }
      if (rpc === 'kompendium_activate_import') return reply(stored.size === 2);
      throw new Error(`Unexpected request: ${url}`);
    };
    const argv = ['upload', '--pdf', pdfPath, '--review', reviewPath, '--reviewed', '--project-ref', 'fixture'];
    // Keep a stable storage path in this fixture: the first run creates a random
    // path, and the server returns that same path on resume.
    const first = global.fetch;
    let actualStoragePath;
    global.fetch = async (url, options) => {
      if (url.endsWith('/kompendium_begin_import')) actualStoragePath = JSON.parse(options.body).p_storage_path;
      if (url.endsWith('/kompendium_resume_import')) {
        const response = await first(url, options), data = await response.json();
        data.storagePath = actualStoragePath;
        // The first read is stale: another owner commits ordinal 0 before
        // releasing its lease. The post-claim read must observe it.
        if (++resumeReads === 1) data.chunks = [];
        return reply(data);
      }
      return first(url, options);
    };
    await assert.rejects(main(argv), /network down/);
    assert.equal(stored.size, 1);
    assert.equal(providerCalls, 1);
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    assert.equal(checkpoint.batches[0].items.length, 2);
    failSecond = false;
    await main([...argv, '--resume']);
    assert.equal(stored.size, 2);
    assert.equal(providerCalls, 1);
    assert.equal(uploadCalls, 1);
    assert.equal(addZeroCalls, 1);
  } finally {
    global.fetch = originalFetch;
    process.env = savedEnv;
    await fs.rm(temp, { recursive: true, force: true });
    await fs.rm(checkpointPath, { force: true });
  }
});
