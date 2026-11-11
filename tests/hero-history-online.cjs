/* Isolated character-history browser workflow; never opens live browser data. */
'use strict';
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {startFixture} = require('./fixture-server.cjs');
(async () => {
  let fixture, browser;
  const errors = [];
  try {
    fixture = await startFixture();
    browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--no-sandbox']});
    const open = async secret => {
      const context = await browser.newContext(), page = await context.newPage();
      page.on('pageerror',error => errors.push(error.message));
      page.on('dialog',dialog => dialog.accept());
      await page.goto(fixture.url + '/#access=' + secret);
      await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
      await page.locator('[data-tab=heroes]').click();
      return page;
    };
    const gm = await open(fixture.secrets.gm), player = await open(fixture.secrets.players[0]), id = fixture.heroes[0].id;
    assert.equal(await player.locator('[data-hero-action=history]').count(),0);
    await gm.evaluate(id => OneRingStore.saveHero({id,name:'Changed',notes:'New notes',load:23},0),id);
    await gm.locator('[data-hero-action=history]').click();
    const dialog = gm.locator('.hero-history-dialog');
    await dialog.locator('select[aria-label="Zapis historii"] option').nth(1).waitFor({state:'attached'});
    await dialog.locator('select[aria-label="Zapis historii"]').selectOption('1');
    assert.equal(await dialog.locator('input[name=name]').inputValue(),'Ala');
    assert.equal(await dialog.locator('input[name=name]').isDisabled(),true);
    assert.match(await dialog.locator('pre').textContent(),/"avatarId"/);
    await gm.screenshot({path:'/tmp/onejournal-hero-history-preview.png',fullPage:true});
    await dialog.getByRole('button',{name:'Przywróć tę wersję',exact:true}).click();
    await dialog.waitFor({state:'detached'});
    assert.equal(await gm.locator('#hero-editor input[name=name]').inputValue(),'Ala');
    assert.equal((await gm.evaluate(() => OneRingStore.getState())).heroes.find(h => h.id === id).load,0);
    await player.evaluate(() => OneRingStore.refresh());
    assert.equal(await player.locator('#hero-editor input[name=name]').inputValue(),'Ala');
    await gm.locator('[data-hero-action=history]').click();
    const conflict = gm.locator('.hero-history-dialog');
    await conflict.locator('select[aria-label="Zapis historii"] option').nth(2).waitFor({state:'attached'});
    await conflict.locator('select[aria-label="Zapis historii"]').selectOption('1');
    await player.evaluate(id => OneRingStore.saveHero({id,name:'Concurrent'},OneRingStore.heroVersions[id]),id);
    await conflict.getByRole('button',{name:'Przywróć tę wersję',exact:true}).click();
    await conflict.getByRole('status').filter({hasText:'ponownie'}).waitFor();
    assert.equal(fixture.document.state.heroes.find(h => h.id === id).name,'Concurrent');
    assert.deepEqual(errors,[]);
    console.log('PASS: GM historical sheet preview, full restore, player synchronization, conflict protection and hidden player controls');
  } finally { await browser?.close(); await fixture?.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
