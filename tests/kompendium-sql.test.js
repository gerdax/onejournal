/* Real PostgreSQL/pgvector in memory: no network, Supabase project or live data. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
test('Kompendium SQL: permissions, activation, retrieval, tickets and durable accounting', async t => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const db = new PGlite({ extensions: { vector } });
  const gm = '00000000-0000-0000-0000-000000000001', player = '00000000-0000-0000-0000-000000000002';
  const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.value;
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema extensions; create schema storage; create schema onejournal_private;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
      alter table storage.objects enable row level security;
      grant usage on schema storage to anon,authenticated,service_role;
      grant select on storage.objects to anon,authenticated,service_role;
      create policy existing_permissive on storage.objects for select to anon,authenticated using(true);
      create table onejournal_private.access_links(id text primary key,role text,hero_id text,version integer,active boolean);
      create table onejournal_private.grants(uid uuid primary key,link_id text,role text,hero_id text,version integer,active boolean);
      insert into onejournal_private.access_links values('gm','gm',null,1,true),('player','player','hero',1,true);
      insert into onejournal_private.grants values('${gm}','gm','gm',null,1,true),('${player}','player','player','hero',1,true);`);
    await db.exec(await fs.readFile(require('node:path').join(__dirname, '../supabase/migrations/202610010001_kompendium.sql'), 'utf8'));
    await db.exec(await fs.readFile(require('node:path').join(__dirname, '../supabase/migrations/202610010002_kompendium_resume.sql'), 'utf8'));
    await db.exec(await fs.readFile(require('node:path').join(__dirname, '../supabase/migrations/202610020002_kompendium_retrieval.sql'), 'utf8'));
    await db.exec(await fs.readFile(require('node:path').join(__dirname, '../supabase/migrations/202610030001_kompendium_neighbors.sql'), 'utf8'));
    await db.exec(await fs.readFile(require('node:path').join(__dirname, '../supabase/migrations/202610030002_kompendium_neighbor_clusters.sql'), 'utf8'));
    const vec = JSON.stringify([1, ...Array(1535).fill(0)]);
    const create = async name => scalar('select public.kompendium_begin_import($1,$2,2,$3) as value', [name, name + '.pdf', 'a'.repeat(64)]);
    const add = async (doc, i, page, content) => db.query('select public.kompendium_add_chunk($1,$2,$3,$3,$4,$5,$6,$7::extensions.vector)', [doc, i, content, page, String(page - 1), 'Postawy', vec]);
    const doc = await create('first');
    await t.test('resume returns only a matching staging document and exact duplicate writes are idempotent', async () => {
      const staged = await create('staged');
      const leaseOne = randomUUID(), leaseTwo = randomUUID();
      assert.equal(await scalar('select public.kompendium_claim_import($1,$2) as value', [staged, leaseOne]), true);
      assert.equal(await scalar('select public.kompendium_claim_import($1,$2) as value', [staged, leaseTwo]), false);
      await db.query('select public.kompendium_release_import($1,$2)', [staged, leaseTwo]);
      assert.equal(await scalar('select public.kompendium_claim_import($1,$2) as value', [staged, leaseTwo]), false);
      await db.query('select public.kompendium_release_import($1,$2)', [staged, leaseOne]);
      assert.equal(await scalar('select public.kompendium_claim_import($1,$2) as value', [staged, leaseTwo]), true);
      await db.query("update onejournal_private.kompendium_documents set import_lease_until=now()-interval '1 second' where id=$1", [staged]);
      assert.equal(await scalar('select public.kompendium_claim_import($1,$2) as value', [staged, leaseOne]), true);
      await add(staged, 0, 1, 'Tekst fragmentu w dokumencie testowym.');
      await add(staged, 0, 1, 'Tekst fragmentu w dokumencie testowym.');
      assert.equal(Number(await scalar('select count(*) as value from onejournal_private.kompendium_chunks where document_id=$1', [staged])), 1);
      await assert.rejects(add(staged, 0, 1, 'Zmieniony fragment w dokumencie testowym.'));
      const resumed = await scalar("select public.kompendium_resume_import('staged',2,$1) as value", ['a'.repeat(64)]);
      assert.equal(resumed.documentId, staged);
      assert.equal(resumed.pdfUploaded, false);
      assert.equal(resumed.chunks[0].content, 'Tekst fragmentu w dokumencie testowym.');
      assert.equal(await scalar("select public.kompendium_resume_import('staged',1,$1) as value", ['a'.repeat(64)]), null);
      for (const role of ['anon', 'authenticated']) {
        assert.equal(await scalar("select has_function_privilege($1,'public.kompendium_resume_import(text,integer,text)','execute') as value", [role]), false);
        assert.equal(await scalar("select has_function_privilege($1,'public.kompendium_claim_import(uuid,uuid)','execute') as value", [role]), false);
      }
    });
    await add(doc, 0, 2, 'Postawa obronna zwiększa ochronę bohatera.');
    await db.query("insert into storage.objects(bucket_id,name) values('onejournal-kompendium','first.pdf')");
    await t.test('only a complete staged import replaces the active book', async () => {
      assert.equal(await scalar('select public.kompendium_activate_import($1,1) as value', [doc]), true);
      assert.equal(await scalar('select public.kompendium_activate_import($1,1) as value', [doc]), true);
      assert.equal(await scalar('select public.kompendium_claim_import($1,$2) as value', [doc, randomUUID()]), false);
      const next = await create('next');
      assert.equal(await scalar('select public.kompendium_activate_import($1,1) as value', [next]), false);
      assert.equal(await scalar('select id as value from onejournal_private.kompendium_documents where active'), doc);
      await assert.rejects(add(doc, 1, 2, 'Active document cannot be edited.'));
    });
    await t.test('private functions and bucket stay inaccessible even with a permissive storage policy', async () => {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(await scalar("select has_function_privilege($1,'public.kompendium_usage_summary(uuid)','execute') as value", [role]), false);
        await db.exec(`set role ${role}`);
        try { assert.equal((await db.query("select * from storage.objects where bucket_id='onejournal-kompendium'")).rows.length, 0); }
        finally { await db.exec('reset role'); }
      }
      await assert.rejects(db.query('select public.kompendium_usage_summary($1)', [player]));
      assert.equal(await scalar('select public.kompendium_admit($1) as value', [player]), false);
    });
    await t.test('retrieval is scoped to active book and GM', async () => {
      const found = await db.query('select * from public.kompendium_retrieve($1,$2,$3::extensions.vector,ARRAY[]::uuid[])', [gm, 'postawa obronna', vec]);
      assert.equal(found.rows.length, 1);
      assert.equal(found.rows[0].document_id, doc);
      await assert.rejects(db.query('select * from public.kompendium_retrieve($1,$2,$3::extensions.vector,ARRAY[]::uuid[])', [player, 'postawa', vec]));
    });
    await t.test('tickets are single-use, expire, and do not survive link rotation/re-exchange', async () => {
      const issue = hash => scalar('select public.kompendium_issue_ticket($1,$2,2,$3) as value', [gm, doc, hash]);
      const redeem = hash => scalar('select public.kompendium_redeem_ticket($1) as value', [hash]);
      await issue('1'.repeat(64));
      assert.equal((await redeem('1'.repeat(64))).pdfPage, 2);
      assert.equal(await redeem('1'.repeat(64)), null);
      await issue('2'.repeat(64));
      await db.exec("update onejournal_private.kompendium_tickets set expires_at=now()-interval '1 second'");
      assert.equal(await redeem('2'.repeat(64)), null);
      await issue('3'.repeat(64));
      await db.exec("update onejournal_private.access_links set version=2 where id='gm'; update onejournal_private.grants set version=2 where link_id='gm'");
      assert.equal(await redeem('3'.repeat(64)), null);
    });
    await t.test('usage is deduplicated and completed values survive late incomplete updates', async () => {
      const id = randomUUID();
      const write = (requestId, input, amount, incomplete, entryId = id) => db.query('select public.kompendium_record_usage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [entryId, gm, 'question', id, requestId, 'fixture-model', input, input == null ? null : 10, input == null ? null : 20, amount, incomplete, null, { input: .75, cached: .075, output: 4.5 }]);
      await write(null, null, null, true);
      await write('provider-one', 100, .123, false);
      await write('provider-one', 100, .123, false);
      await write(null, null, null, true);
      await write('provider-one', 100, .123, false, randomUUID());
      const summary = await scalar('select public.kompendium_usage_summary($1) as value', [gm]);
      assert.equal(Number(summary.allTime.costUsd), .123);
      assert.equal(Number(summary.allTime.inputTokens), 100);
      assert.equal(Number(summary.allTime.incompleteRequests), 0);
      const row = (await db.query('select price_snapshot from onejournal_private.kompendium_usage where id=$1', [id])).rows[0];
      assert.equal(row.price_snapshot.input, .75);
    });
    await t.test('monthly reporting uses Warsaw calendar boundaries', async () => {
      const id = randomUUID();
      await db.query("insert into onejournal_private.kompendium_usage(id,operation,model,cost_usd,incomplete,created_at) values($1,'indexing','embedding',2,false,(date_trunc('month',now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw')-interval '1 second')", [id]);
      const summary = await scalar('select public.kompendium_usage_summary($1) as value', [gm]);
      assert.equal(Number(summary.month.indexingCostUsd || 0), 0);
      assert.equal(Number(summary.allTime.indexingCostUsd), 2);
    });
    await t.test('request throttling is enforced by the database', async () => {
      for (let i = 0; i < 6; i++) assert.equal(await scalar('select public.kompendium_admit($1) as value', [gm]), true);
      assert.equal(await scalar('select public.kompendium_admit($1) as value', [gm]), false);
    });
    await t.test('retrieval matches Polish inflection and can return adjacent chunks from one page', async () => {
      const fresh = await create('retrieval');
      for (let i = 0; i < 10; i++) await add(fresh, i, 1, `Ogólne informacje o wyprawie numer ${i}.`);
      await add(fresh, 10, 2, 'CZUJNOŚĆ pozwala wykryć zasadzkę i uniknąć zaskoczenia.');
      await add(fresh, 11, 2, 'Przy zasadzce bohaterowie testują CZUJNOŚĆ przed walką.');
      await db.query("insert into storage.objects(bucket_id,name) values('onejournal-kompendium','retrieval.pdf')");
      assert.equal(await scalar('select public.kompendium_activate_import($1,12) as value', [fresh]), true);
      const found = await db.query('select pdf_page from public.kompendium_retrieve($1,$2,$3::extensions.vector,ARRAY[]::uuid[])',
        [gm, 'Co dzieje się z Czujnością podczas zasadzki?', vec]);
      assert.equal(found.rows.filter(row => row.pdf_page === 2).length, 2);
      const anchor = await scalar('select id as value from onejournal_private.kompendium_chunks where document_id=$1 and ordinal=10', [fresh]);
      const neighbors = await db.query('select * from public.kompendium_neighbors($1,$2::uuid[])', [gm, [anchor]]);
      assert.equal(neighbors.rows.length, 3);
      assert(neighbors.rows.every(row => row.document_id === fresh && row.chunk_id !== anchor));
      await assert.rejects(db.query('select * from public.kompendium_neighbors($1,$2::uuid[])', [player, [anchor]]));
      await assert.rejects(db.query('select * from public.kompendium_neighbors($1,$2::uuid[])', [gm, Array(7).fill(anchor)]));
      const stale = await scalar('select id as value from onejournal_private.kompendium_chunks where document_id=$1 limit 1', [doc]);
      assert.equal((await db.query('select * from public.kompendium_neighbors($1,$2::uuid[])', [gm, [stale]])).rows.length, 0);
      assert.equal(await scalar("select has_function_privilege('anon','public.kompendium_neighbors(uuid,uuid[])','execute') as value"), false);
      assert.equal(await scalar("select has_function_privilege('authenticated','public.kompendium_neighbors(uuid,uuid[])','execute') as value"), false);

    });
    await t.test('context expansion keeps the middle of a relevant chapter ahead of an isolated hit', async () => {
      const fresh = await create('clusters');
      for (let i=0;i<45;i++) await add(fresh,i,i<25?1:2,`Treść fragmentu ${i}.`);
      await db.query("insert into storage.objects(bucket_id,name) values('onejournal-kompendium','clusters.pdf')");
      assert.equal(await scalar('select public.kompendium_activate_import($1,45) as value',[fresh]),true);
      const anchors=(await db.query('select id from onejournal_private.kompendium_chunks where document_id=$1 and ordinal=any($2::int[])',[fresh,[0,30,33,37,41,43]])).rows.map(r=>r.id);
      const neighbors=await db.query('select c.ordinal from public.kompendium_neighbors($1,$2::uuid[]) n join onejournal_private.kompendium_chunks c on c.id=n.chunk_id',[gm,anchors]);
      assert.equal(neighbors.rows.length,12);
      assert(neighbors.rows.some(r=>r.ordinal===35),'central continuation must not be crowded out by the isolated hit');
    });
  } finally { await db.close(); }
});
