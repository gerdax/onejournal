'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
(async () => {
 const fixture = await startFixture();
 const browser = await chromium.launch({headless:true, executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
 try {
  const page = await browser.newPage(); const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.goto(fixture.url+'/#access='+fixture.secrets.gm);
  await page.waitForFunction(()=>OneRingStore?.connection==='online');
  await page.locator('[data-tab="map"]').click();
  await page.evaluate(async()=>{const enemy=OneRingStore.getParticipants().find(p=>p.type==='enemy');await OneRingStore.addEnemy({...enemy,id:undefined});window.DiceEngine={clear(){},async roll({featCount,successCount}){return {feat:Array(featCount).fill(7),success:Array(successCount).fill(4)};}};});
  const people=await page.evaluate(()=>OneRingStore.getParticipants());
  const heroes=people.filter(p=>p.type==='hero'), enemies=people.filter(p=>p.type==='enemy');
  assert.equal(heroes.length,2);assert.equal(enemies.length,2);
  async function open(id){await page.evaluate(id=>OneRingStore.selectToken(id),id);await page.locator('.dice-launch').click();}
  const close=()=>page.locator('.dice-close').click();
  const choice=(field,value)=>page.locator(`[data-choice="${field}"] [data-value="${value}"]`).click();
  async function settings(n,mode,target){await choice('baseDice',n);await choice('featMode',mode);await page.locator('[data-target]').fill(target);}
  async function check(n,mode,target,bonus){assert.equal(await page.locator(`[data-choice="baseDice"] [aria-pressed="true"]`).getAttribute('data-value'),String(n));assert.equal(await page.locator('[data-choice="featMode"] [aria-pressed="true"]').getAttribute('data-value'),mode);assert.equal(await page.locator('[data-target]').inputValue(),target);assert.equal(await page.locator('.dice-bonus-value').innerText(),bonus);}
  await open(null);await settings(5,'favoured','19');await page.locator('[data-step="1"]').click();await close();
  for(let i=0;i<people.length;i++) {const p=people[i];await open(p.id);await check(0,'normal','','0k');await settings(i+1,i%2?'weary':'favoured',String(12+i));if(p.type==='enemy')await page.locator('[data-step="-1"]').click();await close();}
  for(let i=0;i<people.length;i++){const p=people[i];await open(p.id);await check(i+1,i%2?'weary':'favoured',String(12+i),p.type==='enemy'?'-1k':'0k');await close();}
  await open(null);await check(5,'favoured','19','+1k');await close();
  const hero=heroes[0];await page.evaluate(id=>OneRingStore.saveHero({id,stance:'Zapalczywa',weary:true,miserable:true},OneRingStore.heroVersions[id] ?? 0),hero.heroId);
  await open(hero.id);assert.equal(await page.locator('.dice-bonus-value').innerText(),'+1k');assert(await page.locator('[data-check="exhausted"]').isChecked());assert(await page.locator('[data-check="miserable"]').isChecked());
  await page.locator('[data-check="hope"]').check();await page.locator('[data-check="inspired"]').check();await page.locator('[data-step="1"]').click();
  await page.locator('.dice-roll').click();await page.locator('.dice-again').click();assert(await page.locator('[data-check="hope"]').isChecked());assert.equal(await page.locator('.dice-bonus-value').innerText(),'+2k');assert.equal(fixture.document.rolls.at(-1).entry.heroId,hero.heroId);await close();
  await page.evaluate(id=>OneRingStore.saveHero({id,stance:'Defensywna',weary:false,miserable:false},OneRingStore.heroVersions[id] ?? 0),hero.heroId);
  await open(hero.id);assert.equal(await page.locator('.dice-bonus-value').innerText(),'-1k');assert(!await page.locator('[data-check="hope"]').isChecked());assert(!await page.locator('[data-check="inspired"]').isChecked());assert(!await page.locator('[data-check="exhausted"]').isChecked());assert(!await page.locator('[data-check="miserable"]').isChecked());await close();
  await page.evaluate(id=>OneRingStore.setEnemyWeary(id,true),enemies[0].id);await open(enemies[0].id);assert(await page.locator('[data-check="exhausted"]').isChecked());await page.locator('[data-check="enemyResource"]').check();await close();await open(enemies[0].id);assert(!await page.locator('[data-check="enemyResource"]').isChecked());await close();
  // Removing and recreating a hero with the same ID cannot resurrect old settings.
  const saved=await page.evaluate(()=>OneRingStore.getState());
  await page.evaluate(async ({id,state})=>{await OneRingStore.deleteHero(id);await OneRingStore.restoreBackup(state);},{id:heroes[1].heroId,state:saved});
  await open(heroes[1].id);await check(0,'normal','','0k');await close();
  await page.reload();await page.waitForFunction(()=>OneRingStore?.connection==='online');await page.locator('[data-tab="map"]').click();await open(enemies[0].id);await check(0,'normal','','0k');await close();await open(null);await check(0,'normal','','0k');await close();
  await open(enemies[0].id);fixture.revokeGM();await page.evaluate(()=>OneRingStore.refresh().catch(()=>{}));
  assert.equal(await page.locator('.dice-dialog[open]').count(),0,'revocation closes or removes the panel');
  assert.deepEqual(errors,[]);console.log('PASS: isolated GM settings, drafts, identity, states, resources, deletion and reload');
 } finally {await browser.close();await fixture.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
