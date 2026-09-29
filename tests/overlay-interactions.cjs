const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
(async () => {
  const f = await startFixture();
  const browser = await chromium.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    for (const role of ['gm','player']) {
      const ctx = await browser.newContext({ viewport:{width:390,height:844}, hasTouch:true });
      const page = await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
      await page.goto(f.url+'/#access='+(role==='gm'?f.secrets.gm:f.secrets.players[0]));
      await page.waitForFunction(()=>!!window.OneJournalRolls);
      for (const [button,dialog] of [['#settings-open','#settings'],['#journal-open','.journal-dialog']]) {
        await page.locator(button).click();
        await page.locator(dialog+' h2').click();
        assert(await page.locator(dialog).evaluate(e=>e.open));
        await page.mouse.click(1,1);
        assert.equal(await page.locator(dialog).evaluate(e=>e.open),false);
      }
      await page.locator('[data-tab="map"]').click();
      await page.locator('#map-fullscreen').click();
      assert(await page.locator('.dice-launch').isVisible());
      const fit=await page.locator('#map-fit').boundingBox();assert(fit.x<50 && fit.y<60);
      await page.locator('.dice-launch').tap();
      assert(await page.locator('.dice-dialog').evaluate(e=>e.open));
      assert.equal(await page.locator('.dice-launch').isVisible(),false);
      const transform=await page.locator('#map-stage').getAttribute('style');
      await page.locator('.dice-collapse').click();
      assert(await page.locator('.dice-sheet').evaluate(e=>e.classList.contains('is-header-only')));
      assert.equal(await page.locator('.dice-roll').isVisible(),false);
      await page.locator('.dice-collapse').click();
      assert(await page.locator('#dice-settings').isVisible());
      await page.mouse.click(10,10);
      assert.equal(await page.locator('.dice-dialog').evaluate(e=>e.open),false);
      assert(await page.locator('.dice-launch').isVisible());
      assert.equal(await page.locator('#map-stage').getAttribute('style'),transform);
      assert(await page.locator('#map-viewport').evaluate(e=>e.classList.contains('is-fullscreen')));
      await page.locator('.dice-launch').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.dice-dialog').evaluate(e=>e.open),false);
      assert(await page.locator('#map-viewport').evaluate(e=>e.classList.contains('is-fullscreen')));
      await page.locator('#map-fullscreen').click();
      assert(await page.locator('.dice-launch').evaluate(e=>e.parentElement===document.body));
      // Also exercise the browser's native fullscreen layer.
      await page.locator('#map-viewport').evaluate(e => e.requestFullscreen());
      await page.waitForFunction(() => !!document.fullscreenElement);
      await page.locator('.dice-launch').click();
      await page.evaluate(() => { window.DiceEngine.roll = async ({ featCount, successCount }) => ({ feat: Array(featCount).fill(7), success: Array(successCount).fill(4) }); });
      const count = await page.evaluate(() => OneRingStore.rolls.length);
      await page.locator('.dice-roll').click();
      await page.waitForFunction(n => OneRingStore.rolls.length === n+1, count);
      assert.equal(await page.locator('#dice-heading').textContent(), 'Wynik');
      await page.locator('.dice-close').click();
      await page.evaluate(() => document.exitFullscreen());
      await page.waitForFunction(() => !document.fullscreenElement && document.querySelector('.dice-launch').parentElement === document.body);
      assert.deepEqual(errors,[]);
      await ctx.close(); console.log('PASS:',role,'popup dismissal and fullscreen dice without map gestures');
    }
  } finally { await browser.close(); await f.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
