/* Fixture-only diagnostic benchmark. No production credentials or state. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('../tests/fixture-server.cjs');
const out = path.join(__dirname, 'artifacts');
fs.mkdirSync(out, { recursive: true });
const repetitions = Number(process.env.AUDIT_REPETITIONS || 20);
const summary = values => { const a = values.filter(Number.isFinite).sort((a,b)=>a-b); return { n:a.length, median:a[Math.floor(a.length/2)] ?? null, p95:a[Math.max(0,Math.ceil(a.length*.95)-1)] ?? null }; };
async function instrumentation(page) {
  await page.evaluate(() => {
    const events = [], frames = [], longTasks = [], render = [];
    let tracking = null, previous = performance.now();
    window.auditProbe = { events, frames, longTasks, render, start(id) { tracking = { id, node: document.querySelector(`.map-token[data-id="${id}"]`) }; }, stop() { tracking = null; } };
    new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e=>({at:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
    const frame = now => { if (tracking) { const node = document.querySelector(`.map-token[data-id="${tracking.id}"]`); frames.push({at:now,interval:now-previous,x:parseFloat(node?.style.left),y:parseFloat(node?.style.top),originalConnected:tracking.node.isConnected}); } previous=now; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    const fetchOriginal = window.fetch;
    window.fetch = async (...args) => { const body = args[1]?.body; let request; try {request=JSON.parse(body);} catch {} const event={type:'fetch',at:performance.now(),action:request?.action,method:request?.method}; events.push(event); try { const result=await fetchOriginal(...args); event.done=performance.now(); event.status=result.status; return result; } catch(e) {event.error=e.message;throw e;} };
    for (const name of ['moveToken','selectToken','refresh']) { const original=OneRingStore[name]; OneRingStore[name]=(...args)=>{const e={type:'call',method:name,at:performance.now(),args};events.push(e);return original(...args).then(value=>{e.done=performance.now();return value;},error=>{e.done=performance.now();e.error=error.message;throw error;});}; }
    OneRingStore.subscribe(state=>events.push({type:'snapshot',at:performance.now(),positions:state.map?.positions}));
    const originalReplace=Element.prototype.replaceChildren;
    Element.prototype.replaceChildren=function(...args) { const start=performance.now(); const result=originalReplace.apply(this,args); render.push({at:start,duration:performance.now()-start,id:this.id,className:this.className,children:args.length});return result; };
  });
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
  const report={environment:{node:process.version,chrome:browser.version(),platform:process.platform,arch:process.arch,repetitions,viewport:'1280x900',delay:'additional response hold after core.handle; not network RTT'},runs:[],edgeCases:[]};
  try {
    for (const tokenCount of [10,50]) {
      const fixture=await startFixture({tokenCount}); const contexts=[],pages=[];
      try {
        for (const secret of [fixture.secrets.gm,...fixture.secrets.players]) {
          const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});contexts.push(context);
          await context.route('**/*', route=>new URL(route.request().url()).origin===fixture.url ? route.continue() : route.abort());
          await context.routeWebSocket('**/*', socket=>socket.close());
          const page=await context.newPage();pages.push(page);
          await page.goto(fixture.url+'/#access='+secret);await page.waitForFunction(()=>window.OneRingStore?.connection==='online');
          await page.locator('[data-tab="map"]').click();await instrumentation(page);
        }
        const [gm,...players]=pages;
        await gm.context().tracing.start({screenshots:true,snapshots:true});
        const id=await gm.evaluate(()=>OneRingStore.getParticipants()[0].id);
        fixture.audit.subscribeSnapshots(()=>Promise.all(pages.map(page=>page.evaluate(()=>OneRingStore.refresh()))));
        async function reset(selected=true) {
          fixture.audit.setResponseDelay(0);
          await gm.evaluate(async ({id,selected})=>{await OneRingStore.refresh();await OneRingStore.moveToken(id,420,420);await OneRingStore.selectToken(selected?id:null);},{id,selected});
          await fixture.audit.notifySnapshots();
        }
        async function begin() {
          const marker=gm.locator(`.map-token[data-id="${id}"]`);await marker.scrollIntoViewIfNeeded();const box=await marker.boundingBox();
          await gm.mouse.move(box.x+box.width/2,box.y+box.height/2);await gm.mouse.down();
          await gm.evaluate(id=>auditProbe.start(id),id);
          await gm.mouse.move(box.x+box.width/2+65,box.y+box.height/2+25,{steps:5});
          return box;
        }
        // One unrecorded warm-up through the same path.
        await reset();await begin();await gm.mouse.up();await gm.waitForTimeout(80);
        for (const delay of [0,150,600]) for (const selected of [true,false]) {
          const samples=[];
          for(let iteration=0;iteration<repetitions;iteration++) {
            await reset(selected);fixture.audit.setResponseDelay(delay);
            const from=await gm.evaluate(()=>({time:performance.now(),events:auditProbe.events.length,frames:auditProbe.frames.length,render:auditProbe.render.length}));
            const box=await begin();
            // Force a same-revision snapshot while the pointer is held down.
            await gm.evaluate(()=>OneRingStore.refresh());
            await gm.mouse.move(box.x+box.width/2+100,box.y+box.height/2+35,{steps:3});
            const drop=await gm.evaluate(()=>performance.now());await gm.mouse.up();
            await gm.waitForFunction(({from})=>auditProbe.events.some(e=>e.type==='call'&&e.method==='moveToken'&&e.at>=from&&e.done),{from:from.time});
            const confirmed=await gm.evaluate(({from,id})=>({event:auditProbe.events.find(e=>e.type==='call'&&e.method==='moveToken'&&e.at>=from),position:OneRingStore.getState().map.positions[id]}),{from:from.time,id});
            assert.equal(confirmed.event.error, undefined, 'movement must succeed');
            assert.deepEqual(confirmed.position, { x: confirmed.event.args[1], y: confirmed.event.args[2] }, 'final server position must equal submitted in-bounds coordinates');
            const observerStart=performance.now();await fixture.audit.notifySnapshots();const observerMs=performance.now()-observerStart;
            for(const player of players) assert.deepEqual(await player.evaluate(id=>OneRingStore.getState().map.positions[id],id),confirmed.position);
            const data=await gm.evaluate(from=>{auditProbe.stop();return {events:auditProbe.events.slice(from.events),frames:auditProbe.frames.slice(from.frames),render:auditProbe.render.slice(from.render)};},from);
            const moveFetch=data.events.find(e=>e.type==='fetch'&&e.method==='moveToken');
            const xs=data.frames.map(f=>f.x);let regressions=0;for(let i=1;i<xs.length;i++)if(xs[i]<xs[i-1]-1)regressions++;
            samples.push({iteration,dropToConfirmation:confirmed.event.done-drop,queueDelay:moveFetch.at-confirmed.event.at,observerRefreshMs:observerMs,detached:data.frames.some(f=>f.at<drop&&!f.originalConnected),backwardFrames:regressions,frameIntervals:data.frames.map(f=>f.interval),...data});
            if(iteration===0&&delay===600) await gm.screenshot({path:path.join(out,`map-${tokenCount}-${selected?'selected':'unselected'}.png`)});
          }
          const run={tokenCount,delay,selected,dropToConfirmation:summary(samples.map(s=>s.dropToConfirmation)),queueDelay:summary(samples.map(s=>s.queueDelay)),observerRefresh:summary(samples.map(s=>s.observerRefreshMs)),frameIntervals:summary(samples.flatMap(s=>s.frameIntervals)),detachedRuns:samples.filter(s=>s.detached).length,backwardRuns:samples.filter(s=>s.backwardFrames>0).length};
          report.runs.push(run);fs.writeFileSync(path.join(out,`map-${tokenCount}-${delay}-${selected}.json`),JSON.stringify(samples));console.log(JSON.stringify(run));
        }
        for (const delay of [0,150,600]) {
          const samples=[];
          for(let i=0;i<repetitions;i++) {
            await reset(false);fixture.audit.setResponseDelay(delay);
            const from=await gm.evaluate(()=>({time:performance.now(),events:auditProbe.events.length,frames:auditProbe.frames.length}));
            await begin();const drop=await gm.evaluate(()=>performance.now());await gm.mouse.up();
            await gm.waitForFunction(from=>auditProbe.events.some(e=>e.type==='call'&&e.method==='moveToken'&&e.at>=from&&e.done),from.time);
            const data=await gm.evaluate(from=>{auditProbe.stop();return {events:auditProbe.events.slice(from.events),frames:auditProbe.frames.slice(from.frames)};},from);
            const call=data.events.find(e=>e.type==='call'&&e.method==='moveToken'), fetch=data.events.find(e=>e.type==='fetch'&&e.method==='moveToken');
            assert.equal(call.error, undefined, 'fast-drop movement must succeed');
            samples.push({...data,queueDelay:fetch.at-call.at,dropToConfirmation:call.done-drop,backwardFrames:data.frames.filter((f,i,a)=>i&&f.x<a[i-1].x-1).length});
          }
          report.edgeCases.push({tokenCount,delay,name:'unselected fast drop, natural selection response',queueDelay:summary(samples.map(s=>s.queueDelay)),dropToConfirmation:summary(samples.map(s=>s.dropToConfirmation)),backwardRuns:samples.filter(s=>s.backwardFrames).length});
          fs.writeFileSync(path.join(out,`fast-drop-${tokenCount}-${delay}.json`),JSON.stringify(samples));
        }
        await reset();fixture.audit.setResponseDelay(150);fixture.audit.failNext('moveToken');await begin();await gm.mouse.up();await gm.waitForTimeout(400);
        report.edgeCases.push({tokenCount,name:'failed movement',state:await gm.evaluate(id=>({connection:OneRingStore.connection,serverPosition:OneRingStore.getState().map.positions[id],visibleX:parseFloat(document.querySelector(`.map-token[data-id="${id}"]`).style.left)}),id)});
        await gm.evaluate(()=>OneRingStore.refresh());await reset();fixture.audit.setResponseDelay(150);
        const rapid=await gm.evaluate(async id=>{const start=performance.now();await Promise.all([450,480,510].map(x=>OneRingStore.moveToken(id,x,420)));return {elapsed:performance.now()-start,position:OneRingStore.getState().map.positions[id]};},id);
        report.edgeCases.push({tokenCount,name:'three rapid queued movement commands',...rapid});
        fixture.audit.setResponseDelay(0);await gm.evaluate(()=>{OneRingStore.markOffline();});await fixture.audit.notifySnapshots();report.edgeCases.push({tokenCount,name:'offline then snapshot recovery',connection:await gm.evaluate(()=>OneRingStore.connection)});
        const before=fixture.audit.requests.length;const renderBefore=await gm.evaluate(()=>auditProbe.render.length);await gm.waitForTimeout(10500);
        report.edgeCases.push({tokenCount,name:'10.5 second idle polling',requests:fixture.audit.requests.slice(before),domReplacements:await gm.evaluate(n=>auditProbe.render.length-n,renderBefore)});
        const hidden=await gm.evaluate(async()=>{document.querySelector('[data-tab="heroes"]').click();const n=auditProbe.render.length;for(let i=0;i<20;i++)await OneRingStore.refresh();return auditProbe.render.slice(n);});
        report.edgeCases.push({tokenCount,name:'20 unchanged snapshots with map tab hidden',domReplacements:hidden.length,mapTokenReplacements:hidden.filter(e=>e.id==='map-tokens').length,replacements:hidden});
        fs.writeFileSync(path.join(out,`requests-${tokenCount}.json`),JSON.stringify(fixture.audit.requests));
        await gm.context().tracing.stop({path:path.join(out,`map-${tokenCount}.zip`)});
      } finally { for(const context of contexts)await context.close();await fixture.close(); }
    }
  } finally { fs.writeFileSync(path.join(out,'map-summary.json'),JSON.stringify(report,null,2));await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
