/* Real dice UI with deterministic transport failure and an actual WebGL roll. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
(async () => {
  const fixture=await startFixture();
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
  try {
    const page=await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(fixture.url+'/#access='+fixture.secrets.players[0]);
    await page.locator('main').waitFor({state:'visible'});
    await page.locator('.dice-launch').click();
    assert.equal(await page.locator('[data-choice="actor"]').isVisible(),false);
    assert.equal(await page.locator('.dice-hero-picker').count(),0);
    // Use the real vendored physics engine once, then deterministic values to
    // reproduce a successful simulation whose network publication fails.
    await page.locator('.dice-roll').click();
    await page.waitForFunction(()=>window.OneRingStore.rolls.length===1,{timeout:45000});
    assert.equal(fixture.document.rolls[0].entry.heroId,fixture.heroes[0].id);
    await page.locator('.dice-again').click();
    await page.evaluate(()=>{
      window.testRollCalls=0;
      window.DiceEngine={clear(){},async roll(){window.testRollCalls++;return {feat:[8],success:[]};}};
    });
    const uid=await page.evaluate(()=>JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k=>k.startsWith('onejournal:auth:')))).access_token);
    fixture.setOffline(uid,true);
    await page.locator('.dice-roll').click();
    await page.locator('.journal-toast').filter({hasText:'nieopublikowany'}).waitFor();
    assert.equal(await page.locator('.roll-publication').count(),0);
    assert.equal(await page.locator('.journal-toast').evaluate(e=>e.matches(':popover-open')),true);
    assert.equal(fixture.document.rolls.length,1);
    await page.locator('.dice-close').click();
    fixture.setOffline(uid,false);await page.evaluate(()=>window.OneRingStore.refresh());
    await page.locator('#journal-open').click();await page.getByRole('button',{name:'Ponów publikację'}).click();
    await page.waitForFunction(()=>window.OneRingStore.rolls.length===2);
    assert.equal(await page.evaluate(()=>window.testRollCalls),1);
    assert.equal(fixture.document.rolls[1].entry.result.sum,8);
    assert.deepEqual(errors,[]);
    console.log('PASS: real WebGL roll, forced hero identity, failed publication retained, retry without reroll');
  } finally {await browser.close();await fixture.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
