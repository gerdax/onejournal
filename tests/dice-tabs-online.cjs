/* Tab-scoped GM identity, using disposable fixture storage. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await page.waitForFunction(() => OneRingStore?.connection === 'online');
    await page.evaluate(() => { window.DiceEngine = { clear() {}, async roll({featCount,successCount}) { return {feat:Array(featCount).fill(7),success:Array(successCount).fill(4)}; } }; });
    const participants = await page.evaluate(() => ['hero','enemy'].map(type => OneRingStore.getParticipants().find(p => p.type === type)));
    const open = () => page.locator('.dice-launch').click();
    const close = () => page.locator('.dice-close').click();
    async function rollEntry() {
      const before = fixture.document.rolls.length;
      await page.locator('.dice-roll').click();
      await page.waitForFunction(n => OneRingStore.rolls.length === n + 1, before);
      return fixture.document.rolls.at(-1).entry;
    }
    await open();
    await page.locator('[data-choice="actor"] [data-value="enemy"]').click();
    await page.locator('[data-step="1"]').click();
    await close();
    for (const participant of participants) {
      await page.locator('[data-tab="map"]').click();
      await page.evaluate(id => OneRingStore.selectToken(id), participant.id);
      for (const tab of ['heroes','opponents','battle']) {
        if (tab === 'battle') {
          await page.evaluate(() => { location.hash = 'battle'; });
          await page.waitForFunction(() => document.querySelector('#battle').classList.contains('active'));
        } else await page.locator(`[data-tab="${tab}"]`).click();
        await open();
        assert.equal(await page.locator('[data-choice="actor"]').isVisible(), true, tab);
        assert.equal(await page.locator('[data-choice="actor"] [data-value="enemy"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('.dice-bonus-value').textContent(), '+1k');
        const entry = await rollEntry();
        assert(!entry.heroId && !entry.enemyId, 'generic roll must not inherit participant identity');
        await close();
        assert.equal(await page.evaluate(() => OneRingStore.selection), participant.id, 'tab switch retains selection');
      }
      await page.locator('[data-tab="map"]').click();
      await open();
      assert.equal(await page.locator('[data-choice="actor"]').isVisible(), false);
      const entry = await rollEntry();
      assert.equal(participant.type === 'hero' ? entry.heroId : entry.enemyId, participant.type === 'hero' ? participant.heroId : participant.id);
      await close();
    }
    await page.evaluate(() => OneRingStore.selectToken(null));
    await open();
    assert.equal(await page.locator('[data-choice="actor"]').isVisible(), true);
    assert.equal(await page.locator('.dice-bonus-value').textContent(), '+1k');
    await close();
    assert.deepEqual(errors, []);
    console.log('PASS: GM generic outside map, selected hero/enemy on return, identity, settings and no selection');
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
