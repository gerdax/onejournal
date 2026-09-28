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
