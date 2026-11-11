/* Legacy-view removal regression using disposable cloud data and browser storage. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    for (const secret of [fixture.secrets.gm, fixture.secrets.players[0]]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.text().includes('State observer failed')) errors.push(message.text()); });
      await page.goto(fixture.url + '/#access=' + secret);
      await page.waitForFunction(() => window.OneRingStore?.connection === 'online' && window.OneRingMap);
      assert.equal(await page.locator('#battle, [data-tab="battle"], #battle-list, #hero-battle-list, #battle-card-template').count(), 0);
      assert.equal(await page.locator('#hero-editor [name="name"]').inputValue(), 'Ala');
      const before = await page.evaluate(() => OneRingStore.getState());
      await page.evaluate(() => { location.hash = 'battle'; });
      await page.waitForFunction(() => document.querySelector('#map').classList.contains('active') && location.hash !== '#battle');
      assert.equal(await page.locator('.map-token').count(), 3);
      assert.equal(await page.locator('#map-count').textContent(), '3');
      assert.deepEqual(await page.evaluate(() => OneRingStore.getState()), before);
      // An old bookmarked URL must also work during startup after authentication.
      await page.goto(fixture.url + '/#battle');
      await page.waitForFunction(() => window.OneRingStore?.connection === 'online' && document.querySelector('#map').classList.contains('active'));
      assert.deepEqual(await page.evaluate(() => OneRingStore.getState()), before);
      if (secret === fixture.secrets.gm) {
        const backup = await page.evaluate(() => OneRingStore.exportBackup());
        await page.evaluate(async () => {
          const enemy = OneRingStore.getParticipants().find(p => p.type === 'enemy');
          await OneRingStore.adjustResource(enemy.id, 'endurance', -1);
        });
        assert.equal(await page.locator('#map-count').textContent(), '3');
        await page.evaluate(data => OneRingStore.restoreBackup(data), backup);
        assert.deepEqual(await page.evaluate(() => OneRingStore.getState()), before);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS: legacy UI absent; GM/player hero initialization, old URLs, map participants, state updates and backup restore preserved');
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
