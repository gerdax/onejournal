/* Disposable local server only; explicit refreshes are not Supabase Realtime. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = process.env.AUDIT_ROOT || path.resolve(__dirname, '..');
const { startFixture } = require(path.join(root, 'tests/fixture-server.cjs'));
const repetitions = Number(process.env.AUDIT_REPETITIONS || 20);
const out = path.join(__dirname, 'artifacts'); fs.mkdirSync(out, { recursive: true });
const stats = values => { const a = values.slice().sort((a,b) => a-b); return { n:a.length, median:a[Math.floor(a.length/2)], p95:a[Math.ceil(a.length*.95)-1] }; };
(async () => {
 const browser = await chromium.launch({ headless:true, executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--no-sandbox'] });
 const report = { environment:{ node:process.version, chrome:browser.version(), platform:process.platform, arch:process.arch, repetitions, root, journalEntries:80 }, runs:[] };
 try {
  for (const tokenCount of [10,50]) {
   const fixture = await startFixture({tokenCount}), contexts=[], pages=[], errors=[];
   try {
    for (const secret of [fixture.secrets.gm,...fixture.secrets.players]) {
     const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'}); contexts.push(context);
     await context.route('**/*',r=>new URL(r.request().url()).origin===fixture.url?r.continue():r.abort());
     await context.routeWebSocket('**/*',s=>s.close());
     const page=await context.newPage(); pages.push(page); page.on('pageerror',e=>errors.push(e.message));
     await page.goto(fixture.url+'/#access='+secret); await page.waitForFunction(()=>window.OneRingStore?.connection==='online');
    }
    const gm=pages[0], uid=fixture.audit.requests.find(r=>r.action==='exchange').uid;
    for(let i=0;i<80;i++) await fixture.core.handle(uid,{action:'roll',id:'snapshot-benchmark-'+i,config:{actor:'enemy',baseDice:1,bonus:0,featMode:'normal',target:10,hope:false,inspired:false,enemyResource:false,miserable:false,exhausted:false,privateRoll:false},raw:{feat:[7],success:[4]}});
    await Promise.all(pages.map(p=>p.evaluate(()=>OneRingStore.refresh())));
    await gm.locator('[data-tab="heroes"]').click();
    await gm.evaluate(()=>{
     const counts={}, observer=new MutationObserver(records=>{
      for(const record of records){const el=record.target.nodeType===1?record.target:record.target.parentElement; for(const [name,selector] of Object.entries({map:'#map',heroes:'#heroes',library:'#library',battle:'#battle',journal:'.journal-dialog'})) if(el?.closest(selector))counts[name]=(counts[name]||0)+1;}
     }); observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
     let emits=0; OneRingStore.subscribe(()=>emits++);
     window.snapshotProbe={reset(){observer.takeRecords();for(const k in counts)delete counts[k];emits=0;},read(){return {mutations:{...counts},emits};}};
    });
    const id=await gm.evaluate(()=>OneRingStore.getParticipants()[0].id);
    for(const delay of [0,150,600]) {
     fixture.audit.setResponseDelay(delay);
     for(let i=0;i<3;i++)await Promise.all(pages.map(p=>p.evaluate(()=>OneRingStore.refresh())));
     for(const phase of ['unchanged','hidden-map-moves']) {
      await gm.evaluate(()=>snapshotProbe.reset()); const requestStart=fixture.audit.requests.length, samples=[];
      for(let i=0;i<repetitions;i++) {
       const start=performance.now();
       if(phase==='hidden-map-moves')await gm.evaluate(({id,i})=>OneRingStore.moveToken(id,350+i*5,420),{id,i});
       await Promise.all(pages.map(p=>p.evaluate(()=>OneRingStore.refresh())));
       samples.push(performance.now()-start);
      }
      await gm.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      const requests=fixture.audit.requests.slice(requestStart), reads=requests.filter(r=>r.action==='snapshot');
      const result={tokenCount,delay,phase,roundTrip:stats(samples),readRequests:reads.length,readBytes:reads.reduce((n,r)=>n+r.responseBytes,0),readPayload:stats(reads.map(r=>r.responseBytes)),...await gm.evaluate(()=>snapshotProbe.read())};
      report.runs.push(result); console.log(JSON.stringify(result));
      const expected=fixture.document.state.map.positions[id];
      for(const page of pages)assert.deepEqual(await page.evaluate(id=>OneRingStore.getState().map.positions[id],id),expected);
     }
    }
    fixture.audit.setResponseDelay(0);
    await gm.locator('[data-tab="map"]').click();
    const final=fixture.document.state.map.positions[id];
    await gm.waitForFunction(({id,final})=>{const n=document.querySelector(`.map-token[data-id="${id}"]`);return n&&parseFloat(n.style.left)===final.x&&parseFloat(n.style.top)===final.y;},{id,final});
    assert.deepEqual(errors,[]);
   } finally {for(const context of contexts)await context.close();await fixture.close();}
  }
 } finally {fs.writeFileSync(path.join(out,process.env.AUDIT_OUTPUT || 'snapshot-after.json'),JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
