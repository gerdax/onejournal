/* Real PostgreSQL in memory. Never connects to Supabase or production data. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('hero history preserves exact snapshots, permissions and atomicity', async t => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  const hero = { id: 'h1', name: 'Żółw', hope: 5, unknownLegacyField: { important: 42 }, injury: 'stara rana', avatarId: 'a'.repeat(64) };
  const other = { id: 'h2', name: 'Drugi', hope: 3 };
  const state = { version: 2, heroes: [hero, other], library: [{ secret: 'unchanged' }], map: { keep: true } };
  const scalar = async (sql, args=[]) => (await db.query(sql,args)).rows[0]?.value;
  const history = id => scalar('select public.onejournal_hero_history($1) as value',[id]);
  const write = s => db.query('update onejournal_private.game set state=$1,revision=revision+1', [JSON.stringify(s)]);
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema onejournal_private;
      create table onejournal_private.game(id integer primary key,revision bigint,public_revision bigint,state jsonb,hero_versions jsonb,notebook jsonb);
      alter table onejournal_private.game enable row level security;`);
    await db.query('insert into onejournal_private.game values(1,17,12,$1,$2,$3)',[JSON.stringify(state),JSON.stringify({h1:7,h2:2}),JSON.stringify({blocks:[{text:'ważne'}]})]);
    const before = await scalar('select to_jsonb(g) as value from onejournal_private.game g');
    await db.exec('begin');
    await db.exec(await fs.readFile(path.join(__dirname,'../supabase/migrations/20261111230134_hero_history.sql'),'utf8'));
    await db.exec('commit');
    await t.test('migration copies every field without touching game or revisions', async () => {
      assert.deepEqual(await scalar('select to_jsonb(g) as value from onejournal_private.game g'),before);
      const entries = await history('h1');
      assert.equal(entries.length,1); assert.equal(entries[0].operation,'baseline');
      assert.deepEqual(entries[0].hero,hero); assert.equal(entries[0].heroVersion,7);
      assert.equal((await history('h2')).length,1);
    });
    await t.test('unchanged cards and reordering produce no duplicate history', async () => {
      await write({...state,heroes:[other,hero],library:[]});
      assert.equal((await history('h1')).length,1);
      assert.equal((await history('h2')).length,1);
    });
    await t.test('resource changes retain exact before and after values', async () => {
      await write({...state,heroes:[{...hero,hope:4},other]});
      const entries=await history('h1');
      assert.equal(entries.length,2); assert.equal(entries[0].operation,'update');
      assert.deepEqual(entries[0].previousHero,hero);
      assert.deepEqual(entries[0].hero,{...hero,hope:4});
      assert.equal((await history('h2')).length,1);
    });
    await t.test('deletion and reintroduction retain every earlier version',async () => {
      await write({...state,heroes:[other]});
      const deleted=(await history('h1'))[0];
      assert.equal(deleted.operation,'delete'); assert.equal(deleted.hero,null);
      assert.deepEqual(deleted.previousHero,{...hero,hope:4});
      await write(state);
      assert.equal((await history('h1'))[0].operation,'insert');
      assert.equal((await history('h1')).length,4);
    });
    await t.test('rollback undoes both the game change and its history',async () => {
      const previous=await history('h1');
      await db.exec('begin');
      await write({...state,heroes:[{...hero,hope:0},other]});
      await db.exec('rollback');
      assert.deepEqual(await history('h1'),previous);
      assert.deepEqual(await scalar("select state->'heroes'->0 as value from onejournal_private.game"),hero);
    });
    await t.test('failed history insertion rejects the game write',async () => {
      const previous=await scalar('select to_jsonb(g) as value from onejournal_private.game g');
      await db.exec("alter table onejournal_private.hero_history add constraint fail_test check(operation='baseline') not valid");
      await assert.rejects(write({...state,heroes:[{...hero,hope:0},other]}));
      assert.deepEqual(await scalar('select to_jsonb(g) as value from onejournal_private.game g'),previous);
      await db.exec('alter table onejournal_private.hero_history drop constraint fail_test');
    });
    await t.test('untrusted roles cannot read or modify history and service role can only read',async () => {
      for(const role of ['anon','authenticated']) {
        assert.equal(await scalar("select has_function_privilege($1,'public.onejournal_hero_history(text)','execute') as value",[role]),false);
        assert.equal(await scalar("select has_table_privilege($1,'onejournal_private.hero_history','select') as value",[role]),false);
      }
      await db.exec('set role service_role');
      assert.equal((await history('h1')).length,4);
      await assert.rejects(db.exec('delete from onejournal_private.hero_history'));
      await assert.rejects(db.exec("update onejournal_private.hero_history set hero='{}'"));
      await db.exec('reset role');
    });
    await t.test('whole-game deletion records cards; truncation cannot bypass history',async () => {
      await assert.rejects(db.exec('truncate onejournal_private.game'));
      await db.exec('begin; delete from onejournal_private.game');
      assert.equal((await history('h1'))[0].operation,'delete');
      assert.equal((await history('h2'))[0].operation,'delete');
      await db.exec('rollback');
    });
    await t.test('100-entry read limit never removes older snapshots',async () => {
      for(let i=0;i<105;i++) await write({...state,heroes:[{...hero,hope:i},other]});
      const entries=await history('h1');
      assert.equal(entries.length,100);
      assert.equal(entries[0].hero.hope,104);
      assert.equal(await scalar("select count(*)::int as value from onejournal_private.hero_history where hero_id='h1'"),109);
      assert.deepEqual(await scalar("select hero as value from onejournal_private.hero_history where hero_id='h1' and operation='baseline'"),hero);
    });
  } finally { await db.close(); }
});
