'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../cloud-store.js');
function snapshot(revision = 1) {
  return { state: {version:2,heroes:[{id:'h',name:'Ala'}],heroParticipants:[],battle:[],library:[],map:null}, participants:[], access:{role:'player',heroId:'h'}, heroVersions:{h:revision}, revision, selection:null, rolls:[] };
}
const deferred = () => { let resolve,reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
test('online refresh uses a conditional read and avoids redundant notifications', async () => {
  const sent=[];
  const store=createStore({request:async body=>{
    sent.push(body);
    return body.knownRevision === 1 ? {unchanged:true,revision:1,access:{role:'player',heroId:'h'}} : snapshot();
  }});
  let notifications=0;store.subscribe(()=>notifications++);
  await store.connect();
  const afterConnect=notifications;
  await store.refresh();
  assert.deepEqual(sent[1],{action:'snapshot',knownRevision:1,knownAccess:{role:'player',heroId:'h'}});
  assert.equal(notifications,afterConnect);
  store.markOffline();
  const afterOffline=notifications;
  await store.refresh();
  assert.deepEqual(sent[2],{action:'snapshot'});
  assert.equal(store.connection,'online');
  assert.equal(notifications,afterOffline+1);
});

test('bad unchanged response retries a full read once', async () => {
  const sent=[];
  const store=createStore({request:async body=>{
    sent.push(body);
    if(sent.length===2)return {unchanged:true,revision:999,access:{role:'player',heroId:'h'}};
    return snapshot(sent.length===3?2:1);
  }});
  await store.connect();await store.refresh();
  assert.deepEqual(sent.map(x=>x.action),['snapshot','snapshot','snapshot']);
  assert.equal(sent[2].knownRevision,undefined);
  assert.equal(store.heroVersions.h,2);
});

test('late unchanged reply after a mutation cannot overwrite or notify', async () => {
  const old=deferred();let calls=0;
  const store=createStore({request:async body=>{
    if(++calls===1)return snapshot();
    if(body.action==='snapshot')return old.promise;
    return {...snapshot(2),result:{id:'h',name:'saved'}};
  }});
  let notifications=0;store.subscribe(()=>notifications++);
  await store.connect();const pending=store.refresh();
  await store.saveHero({id:'h',name:'saved'});
  const afterMutation=notifications;
  old.resolve({unchanged:true,revision:1,access:{role:'player',heroId:'h'}});
  await pending;
  assert.equal(store.heroVersions.h,2);
  assert.equal(notifications,afterMutation);
});

test('late full reply from an older role cannot restore its private view', async () => {
  const old=deferred();let reads=0;
  const gm={...snapshot(8),access:{role:'gm',heroId:null},catalog:[{id:'private'}]};
  const player=snapshot(1);
  const store=createStore({request:async body=>{
    if(body.action==='exchange')return player;
    return ++reads===1?gm:old.promise;
  }});
  await store.connect();const pending=store.refresh();
  await store.connect('player-link');
  old.resolve(gm);
  await assert.rejects(pending,{stale:true});
  assert.equal(store.access.role,'player');
  assert.deepEqual(store.catalog,[]);
});

test('late unchanged reply across connect cannot validate the previous role', async () => {
  const old=deferred();let reads=0;
  const gm={...snapshot(8),access:{role:'gm',heroId:null},catalog:[{id:'private'}]};
  const player=snapshot(1);
  const store=createStore({request:async body=>{
    if(body.action==='exchange')return player;
    return ++reads===1?gm:old.promise;
  }});
  await store.connect();const pending=store.refresh();
  await store.connect('player-link');
  old.resolve({unchanged:true,revision:8,access:gm.access});
  await assert.rejects(pending,{stale:true});
  assert.equal(store.access.role,'player');
  assert.deepEqual(store.catalog,[]);
});

test('repeated invalid unchanged replies fail after one full retry', async () => {
  let calls=0;
  const store=createStore({request:async()=>++calls===1?snapshot():{unchanged:true,revision:99,access:{role:'gm',heroId:null}}});
  await store.connect();
  await assert.rejects(store.refresh(),/Nieprawidłowa odpowiedź serwera/);
  assert.equal(calls,3);
  assert.equal(store.heroVersions.h,1);
});

test('full snapshots compare all projected fields but ignore command results', async () => {
  let current=snapshot();let notifications=0;
  const store=createStore({request:async body=>body.action==='command'?{...current,result:{id:'h'}}:current});
  store.subscribe(()=>notifications++);
  await store.connect();const afterConnect=notifications;
  await store.refresh();assert.equal(notifications,afterConnect);
  await store.saveHero({id:'h',name:'Ala'});assert.equal(notifications,afterConnect);
  current={...current,catalog:[{id:'new'}]};
  await store.refresh();assert.equal(notifications,afterConnect+1);
  current={...current,access:{role:'gm',heroId:null}};
  await store.refresh();assert.equal(store.access.role,'gm');
  assert.equal(notifications,afterConnect+2);
});

test('a result-only newer response still blocks an older equal-revision projection', async () => {
  const old=deferred();let reads=0;
  const current=snapshot();
  const store=createStore({request:async body=>{
    if(body.action==='command')return {...current,result:{id:'h'}};
    return ++reads===1?current:old.promise;
  }});
  await store.connect();const pending=store.refresh();
  await store.saveHero({id:'h',name:'Ala'});
  old.resolve({...snapshot(),state:{...snapshot().state,heroes:[{id:'h',name:'stale'}]}});
  await pending;
  assert.equal(store.getState().heroes[0].name,'Ala');
});
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

test('queued GM upload is dropped when connect switches to a player grant', async () => {
  const gm = { ...snapshot(), access: { role: 'gm', heroId: null } };
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const sent = [];
  const store = createStore({ request: async body => {
    sent.push(body.action);
    if (body.action === 'mapGet') { entered(); return delayed; }
    if (body.action === 'exchange') return snapshot(2);
    if (body.action === 'mapUpload') throw Object.assign(new Error('player cannot upload'), { status: 403 });
    return gm;
  } });
  await store.connect();
  const pendingRead = store.getMapImage('old-image');
  await started;
  const queuedUpload = store.uploadMap({ id: 'map-one', name: 'Moria', dataUrl: 'full', thumbnailDataUrl: 'thumb' });
  await store.connect('player-link');
  release({ imageId: 'old-image', dataUrl: 'old' });
  await assert.rejects(pendingRead, { stale: true });
  await assert.rejects(queuedUpload, { stale: true });
  assert.deepEqual(sent, ['snapshot', 'mapGet', 'exchange']);
  assert.equal(store.access.role, 'player');
  assert.equal(store.connection, 'online');
});

test('backup staging stops when the grant changes mid-restore', async () => {
  const gm = { ...snapshot(), access: { role: 'gm', heroId: null } };
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const sent = [];
  const store = createStore({ request: async body => {
    sent.push(body.action);
    if (body.action === 'mapStage') { entered(); return delayed; }
    if (body.action === 'exchange') return snapshot(2);
    return gm;
  } });
  await store.connect();
  const pending = store.restoreBackup({ format: 'onejournal', version: 2, state: { ...gm.state, mapLibrary: [] }, rolls: [], avatars: {}, maps: { first: 'one', second: 'two' } });
  await started;
  await store.connect('player-link');
  release({ imageId: 'first' });
  await assert.rejects(pending, { stale: true });
  assert.deepEqual(sent, ['snapshot', 'mapStage', 'exchange']);
  assert.equal(store.connection, 'online');
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

test('map facade uploads, fetches, and stages portable backup images', async () => {
  const requests = [];
  const id = 'a'.repeat(64), thumb = 'b'.repeat(64);
  const gm = { ...snapshot(), access: { role: 'gm', heroId: null } };
  const store = createStore({ request: async body => {
    requests.push(body);
    if (body.action === 'mapGet') return { imageId: id, dataUrl: 'full' };
    if (body.action === 'mapStage') return { imageId: body.thumbnail ? thumb : id };
    if (body.action === 'mapUpload') return { ...gm, result: { id: 'map-one', imageId: id, thumbnailId: thumb } };
    if (body.action === 'command') return { ...gm, result: null };
    return gm;
  } });
  await store.connect();
  assert.equal((await store.uploadMap({ id: 'map-one', name: 'Moria', dataUrl: 'full', thumbnailDataUrl: 'thumb' })).imageId, id);
  assert.deepEqual(requests[1], { action: 'mapUpload', id: 'map-one', name: 'Moria', dataUrl: 'full', thumbnailDataUrl: 'thumb' });
  assert.deepEqual(await store.getMapImage(id), { imageId: id, dataUrl: 'full' });
  await store.restoreBackup({ format: 'onejournal', version: 2, state: { ...gm.state, mapLibrary: [{ id: 'map-one', thumbnailId: thumb, imageId: id }] }, rolls: [], avatars: {}, maps: { [id]: 'full', [thumb]: 'thumb' } });
  assert.deepEqual(requests.slice(-3).map(x => x.action), ['mapStage', 'mapStage', 'command']);
  assert.deepEqual(requests.at(-1).args[0].maps, { [id]: null, [thumb]: null });
  assert.equal(requests.at(-2).thumbnail, true);
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


test('network failure invalidates an older conditional poll and recovery reads full state', async () => {
  const old = deferred(), recovery = deferred(), sent = [];
  const store = createStore({ request: async body => {
    sent.push(body);
    if (sent.length === 1) return snapshot();
    if (body.action === 'export') throw Object.assign(new Error('offline'), {status:503});
    if (body.knownRevision !== undefined) return old.promise;
    return recovery.promise;
  }});
  await store.connect();
  const obsolete = store.refresh();
  const rejected = assert.rejects(obsolete, {stale:true});
  await assert.rejects(store.exportBackup(), {status:503});
  assert.equal(store.connection, 'offline');
  const fresh = store.refresh();
  assert.notEqual(fresh, obsolete);
  assert.deepEqual(sent.at(-1), {action:'snapshot'});
  old.resolve({unchanged:true, revision:1, access:{role:'player', heroId:'h'}});
  await rejected;
  assert.equal(store.connection, 'offline', 'old poll cannot claim recovery');
  recovery.resolve({...snapshot(2), catalog:[{id:'updated'}]});
  await fresh;
  assert.equal(store.connection, 'online');
  assert.equal(store.heroVersions.h, 2);
});


test('obsolete poll failure cannot invalidate an in-flight full recovery', async () => {
  const old = deferred(), recovery = deferred(); let calls = 0;
  const store = createStore({request: async body => {
    if (++calls === 1) return snapshot();
    if (body.action === 'export') throw Object.assign(new Error('offline'), {status:503});
    if (body.knownRevision !== undefined) return old.promise;
    return recovery.promise;
  }});
  await store.connect();
  const obsolete = store.refresh();
  const rejected = assert.rejects(obsolete, {status:503});
  await assert.rejects(store.exportBackup(), {status:503});
  const fresh = store.refresh();
  old.reject(Object.assign(new Error('obsolete failure'), {status:503}));
  await rejected;
  recovery.resolve(snapshot(2));
  await fresh;
  assert.equal(store.connection, 'online');
  assert.equal(store.heroVersions.h, 2);
});


test('obsolete conditional denial still revokes the current session and its full recovery', async () => {
  const old = deferred(), recovery = deferred(); let calls = 0;
  const store = createStore({request: async body => {
    if (++calls === 1) return snapshot();
    if (body.action === 'export') throw Object.assign(new Error('offline'), {status:503});
    if (body.knownRevision !== undefined) return old.promise;
    return recovery.promise;
  }});
  await store.connect();
  const obsolete = store.refresh();
  const denied = assert.rejects(obsolete, {status:403});
  await assert.rejects(store.exportBackup(), {status:503});
  const fresh = store.refresh();
  const invalidated = assert.rejects(fresh, {stale:true});
  old.reject(Object.assign(new Error('revoked'), {status:403}));
  await denied;
  assert.equal(store.connection, 'revoked');
  recovery.resolve(snapshot(2));
  await invalidated;
  assert.deepEqual(store.getState().heroes, []);
  assert.equal(store.connection, 'revoked');
});
