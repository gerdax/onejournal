/* Map upload, publication and portable restore against isolated cloud storage. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
let browser, fixture;
const errors = [];
async function open(secret) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.url + '/#access=' + secret);
  await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
  await page.locator('[data-tab="map"]').click();
  return page;
}
async function file(page, name, width, height) {
  const data = await page.evaluate(({width,height}) => {
    const c = document.createElement('canvas'); c.width=width; c.height=height;
    const x=c.getContext('2d'); x.fillStyle='#ff0000'; x.fillRect(0,0,width,height);
    x.fillStyle=width===height?'#0040c0':'#008000'; const side=Math.min(width,height); x.fillRect((width-side)/2,(height-side)/2,side,side);
    return c.toDataURL('image/png').split(',')[1];
  }, {width,height});
  return {name,mimeType:'image/png',buffer:Buffer.from(data,'base64')};
}
async function state(page) { return page.evaluate(() => OneRingStore.getState()); }
async function main() {
  fixture=await startFixture();
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
  const gm=await open(fixture.secrets.gm), player=await open(fixture.secrets.players[0]);
  const original=await state(gm);
  assert.equal(await gm.locator('#map-generate').count(),0);
  assert.equal(await player.getByRole('button',{name:'Sceneria',exact:true}).isVisible(),false);
  await gm.getByRole('button',{name:'Sceneria',exact:true}).click();
  const dialog=gm.getByRole('dialog',{name:'Wybierz scenerię',exact:true});
  await dialog.waitFor();
  const input=dialog.locator('input[type=file]');
  await input.setInputFiles([await file(gm,'pozioma.png',600,300),await file(gm,'pionowa.png',300,600)]);
  await gm.waitForFunction(() => OneRingStore.getState().mapLibrary.length===2);
  const uploaded=await state(gm);
  assert.deepEqual(uploaded.map,original.map,'upload does not publish');
  assert.equal(await dialog.isVisible(),true);
  const first=uploaded.mapLibrary.find(x=>x.name==='pozioma.png');
  const second=uploaded.mapLibrary.find(x=>x.name==='pionowa.png');
  for (const record of [first,second]) {
    const result=await gm.evaluate(async record=> {
      const sizes=[];
      for(const id of [record.imageId,record.thumbnailId]) {
        const {dataUrl}=await OneRingStore.getMapImage(id);
        const img=new Image(); img.src=dataUrl; await img.decode();
        const c=document.createElement('canvas'); c.width=img.width;c.height=img.height;
        const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
        sizes.push({size:[img.width,img.height],pixel:[...ctx.getImageData(5,5,1,1).data]});
      }
      return sizes;
    },record);
    assert.deepEqual(result.map(x=>x.size),[[1024,1024],[384,384]]);
    assert.ok(result[0].pixel[1]>110 && result[0].pixel[0]<20,'center crop excludes red margins');
  }
  // Drag/drop follows the same upload path as the picker.
  const dropped=await file(gm,'drop.png',400,400);
  await dialog.locator("#map-library-grid").evaluate((node,data)=>{
    const transfer=new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'drop.png',{type:'image/png'}));
    node.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  },dropped.buffer.toString('base64'));
  await gm.waitForFunction(()=>OneRingStore.getState().mapLibrary.length===3);
  await gm.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(),false);
  assert.equal(await gm.getByRole('button',{name:'Sceneria',exact:true}).evaluate(n=>n===document.activeElement),true);
  await gm.getByRole('button',{name:'Sceneria',exact:true}).click();
  assert.equal(await dialog.locator('h3').count(),0);
  assert.equal(await dialog.getByRole('button',{name:'Wczytaj do potyczki',exact:true}).count(),0);
  await dialog.locator('.map-library-preview').first().click();
  assert.equal(await dialog.isVisible(),true,'single click does not publish');
  assert.deepEqual((await state(gm)).map,original.map);
  await dialog.locator('.map-library-preview').first().dblclick();
  await dialog.waitFor({state:'hidden'});
  const live=await state(gm);
  assert.equal(live.map.kind,'image'); assert.deepEqual([live.map.width,live.map.height],[1200,1200]);
  assert.equal(Object.keys(live.map.positions).length,3);
  for (const [id,point] of Object.entries(live.map.positions)) assert.equal(point.x,id.startsWith('hero:')?64:1136,'participants return to staging');
  assert.deepEqual(live.battle,original.battle); assert.deepEqual(live.heroParticipants,original.heroParticipants);
  await player.evaluate(()=>OneRingStore.refresh());
  assert.deepEqual((await state(player)).mapLibrary || [],[]);
  await player.locator('#map-terrain image').waitFor();
  const active=live.map.imageId;
  assert.equal(await player.evaluate(async id=>(await OneRingStore.getMapImage(id)).imageId,active),active);
  const view = () => gm.locator('#map-stage').evaluate(n => { const m = new DOMMatrix(n.style.transform); return {x:m.e,y:m.f,zoom:m.a}; });
  await gm.locator('#map-terrain image').waitFor();
  await gm.locator('#map-fullscreen').click();
  const beforeZoom = await view();
  await gm.locator('#map-zoom-in').click();
  assert.ok((await view()).zoom > beforeZoom.zoom, 'image map zoom works');
  const box = await gm.locator('#map-viewport').boundingBox();
  const beforePan = await view();
  await gm.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await gm.mouse.down();
  await gm.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, {steps:4});
  await gm.mouse.up();
  const afterPan = await view();
  assert.ok(Math.abs(afterPan.x - beforePan.x - 40) < 2 && Math.abs(afterPan.y - beforePan.y - 30) < 2, 'image background drags like generated terrain');
  await gm.keyboard.press('Escape');
  // Backup restores all uploaded assets, including an active image removed from the library.
  await gm.getByRole('button',{name:'Sceneria',exact:true}).click();
  await dialog.getByRole('button',{name:'Usuń',exact:true}).first().click();
  await gm.waitForFunction(()=>OneRingStore.getState().mapLibrary.length===2);
  assert.equal((await state(gm)).map.imageId,active);
  const backup=await gm.evaluate(()=>OneRingStore.exportBackup());
  assert.ok(backup.maps[active]);
  await gm.keyboard.press('Escape');
  await gm.locator('#map-clear').click();
  await gm.waitForFunction(()=>!OneRingStore.getState().map);
  assert.equal((await state(gm)).mapLibrary.length,2);
  assert.equal(await gm.locator('#map-blank p').textContent(),'Wybierz scenerię, by utworzyć potyczkę.');
  await gm.evaluate(value=>OneRingStore.restoreBackup(value),backup);
  assert.equal((await state(gm)).map.imageId,active);
  await gm.locator('#map-terrain image').waitFor();
  await gm.getByRole('button',{name:'Sceneria',exact:true}).click();
  await gm.setViewportSize({width:390,height:844});
  assert.ok(await dialog.evaluate(n=>n.getBoundingClientRect().width<=innerWidth));
  await gm.screenshot({path:'/tmp/onejournal-map-library-mobile.png'});
  await gm.keyboard.press('Escape');
  await gm.setViewportSize({width:1280,height:900});
  await gm.getByRole('button',{name:'Sceneria',exact:true}).click();
  await gm.screenshot({path:'/tmp/onejournal-map-library-desktop.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: map picker/drop, center crop, publication, role privacy, deletion, portable restore, mobile modal');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();await fixture?.close();});
