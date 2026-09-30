'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../cloud-store.js');
function snapshot(revision = 1) {
  return { state: {version:2,heroes:[{id:'h',name:'Ala'}],heroParticipants:[],battle:[],library:[],map:null}, participants:[], access:{role:'player',heroId:'h'}, heroVersions:{h:revision}, revision, selection:null, rolls:[] };
}
const deferred = () => { let resolve,reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
test('cloud state is detached and never requires browser storage', async () => {
  const store = createStore({request: async()=>snapshot()});
  await store.connect(); store.getState().heroes[0].name='changed';
  assert.equal(store.getState().heroes[0].name,'Ala');
});
test('a late snapshot cannot resurrect a revoked session', async () => {
  const oldRead = deferred(); let calls=0;
  const store = createStore({request: async body=>{
    if (++calls===1) return snapshot();
    if(body.action==='snapshot') return oldRead.promise;
    throw Object.assign(new Error('revoked'),{status:403});
  }});
  await store.connect(); const pending=store.refresh();
  await assert.rejects(store.saveHero({id:'h',name:'B'}));
  oldRead.resolve(snapshot(9)); await assert.rejects(pending);
  assert.equal(store.connection,'revoked'); assert.equal(store.getState().heroes.length,0);
});
test('stale successful responses never overwrite a newer revision',async()=>{
  const old=deferred(); let calls=0;
  const store=createStore({request:async body=>{
    if(++calls===1)return snapshot();
    return body.action==='snapshot'?old.promise:{...snapshot(3),result:{id:'h',name:'saved'}};
  }});
  await store.connect(); const reading=store.refresh(); await store.saveHero({id:'h',name:'saved'});
  old.resolve(snapshot(2)); await reading; assert.equal(store.heroVersions.h,3);
});
test('offline blocks writes; explicit refresh recovers', async()=>{
  let writes=0;
  const store=createStore({request:async body=>{if(body.action==='command')writes++;return snapshot();}});
  await store.connect();store.markOffline();await assert.rejects(store.saveHero({id:'h',name:'B'}));
  assert.equal(writes,0);await store.refresh();assert.equal(store.canWrite,true);
});
test('hero save carries draft version; a conflict refreshes server data and rejects',async()=>{
  let writes=0;
  const store=createStore({request:async body=>{
    if(body.action==='command'){writes++;assert.equal(body.heroVersion,1);assert.deepEqual(body.args,[{id:'h',name:'draft'}]);throw Object.assign(new Error('conflict'),{status:409});}
    return snapshot(writes?2:1);
  }});
  await store.connect();await assert.rejects(store.saveHero({id:'h',name:'draft'},1),/conflict/);
  assert.equal(store.heroVersions.h,2);assert.equal(store.canWrite,true);
});

test('response started before offline cannot re-enable editing',async()=>{
  const old=deferred();let calls=0;
  const store=createStore({request:async()=>++calls===2?old.promise:snapshot()});
  await store.connect();const pending=store.refresh();store.markOffline();
  old.resolve(snapshot(2));await assert.rejects(pending);
  assert.equal(store.canWrite,false);assert.equal(store.heroVersions.h,1);
  await store.refresh();assert.equal(store.canWrite,true);
});

test('avatar facade carries hero version and stages backup images before restore', async () => {
  const requests=[];
  const dataUrl='data:image/jpeg;base64,example';
  const store=createStore({request:async body=>{
    requests.push(body);
    if(body.action==='avatarStage')return {avatarId:'image-id'};
    if(body.action==='avatarGet')return {avatarId:'image-id',dataUrl};
    if(body.action==='avatarSet'||body.action==='command')return {...snapshot(2),result:{id:'h',name:'Ala',avatarId:'image-id'}};
    return snapshot();
  }});
  await store.connect();
  assert.deepEqual(await store.getAvatar('h'),{avatarId:'image-id',dataUrl});
  await store.setAvatar('h',dataUrl);
  assert.deepEqual(requests[2],{action:'avatarSet',heroId:'h',dataUrl,heroVersion:1});
  await store.restoreBackup({format:'onejournal',version:2,state:snapshot().state,rolls:[],avatars:{'image-id':dataUrl}});
  assert.equal(requests.at(-2).action,'avatarStage');
  assert.deepEqual(requests.at(-1).args[0].avatars,{'image-id':null});
});

test('GM notebook getter is detached and save carries version with returned result', async () => {
  const requests = [];
  const document = { blocks: [{ type: 'paragraph', runs: [{ text: 'MG' }] }] };
  const gm = revision => ({ ...snapshot(revision), access: { role: 'gm', heroId: null }, notebook: { document, version: revision } });
  const store = createStore({ request: async body => {
    requests.push(body);
    if (body.action === 'notebookSave') return { ...gm(2), result: { document, version: 2 } };
    return gm(1);
  } });
  await store.connect();
  store.notebook.document.blocks[0].runs[0].text = 'changed';
  assert.equal(store.notebook.document.blocks[0].runs[0].text, 'MG');
  assert.deepEqual(await store.saveNotebook(document), { document, version: 2 });
  assert.deepEqual(requests[1], { action: 'notebookSave', document, version: 1 });
  assert.equal(store.notebook.version, 2);
  const player = createStore({ request: async () => ({ ...snapshot(), notebook: { document, version: 99 } }) });
  await player.connect();
  assert.equal(player.notebook, null);
});

test('enemy weariness and bound roll use the command and roll contracts', async () => {
  const requests = [];
  const gm = { ...snapshot(), access: { role: 'gm', heroId: null } };
  const store = createStore({ request: async body => {
    requests.push(body);
    return body.action === 'command' ? { ...gm, result: null } : gm;
  } });
  await store.connect();
  await store.setEnemyWeary('orc-1', true);
  assert.deepEqual(requests[1], { action: 'command', method: 'setEnemyWeary', args: ['orc-1', true] });
  await store.publishRoll({ id: 'enemy-roll-01', enemyId: 'orc-1', config: { actor: 'enemy' }, raw: {} });
  assert.equal(requests[2].enemyId, 'orc-1');
});
