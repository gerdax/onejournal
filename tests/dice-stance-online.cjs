/* Stance defaults and manual overrides on isolated GM/player sessions. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox'] });
  try {
    for (const role of ['gm', 'player']) {
      const page = await browser.newPage();
      await page.goto(fixture.url + '/#access=' + (role === 'gm' ? fixture.secrets.gm : fixture.secrets.players[0]));
      await page.waitForFunction(() => OneRingStore?.connection === 'online');
      if (role === 'gm') await page.locator('[data-tab="map"]').click();
      const heroId = fixture.heroes[0].id;
      await page.evaluate(async ({ role, heroId }) => {
        if (role === 'gm') await OneRingStore.selectToken('hero:' + heroId);
        window.DiceEngine = { clear() {}, async roll({ featCount, successCount }) {
          return { feat: Array(featCount).fill(7), success: Array(successCount).fill(4) };
        } };
      }, { role, heroId });
      for (const [stance, expected] of [['Zapalczywa', 1], ['Wyważona', 0], ['Defensywna', -1], ['Ostrożna', -1], ['Bezpieczna', 0], ['', 0], ['Nieznana', 0]]) {
        await page.evaluate(async ({ heroId, stance }) => {
          await OneRingStore.refresh();
          await OneRingStore.saveHero({ id: heroId, stance }, OneRingStore.heroVersions[heroId] ?? 0);
        }, { heroId, stance });
        await page.locator('.dice-launch').click();
        assert.equal(await page.locator('.dice-bonus-value').textContent(), `${expected > 0 ? '+' : ''}${expected}k`, `${role}: ${stance}`);
        await page.locator('[data-choice="baseDice"] [data-value="2"]').click();
        assert.match(await page.locator('.dice-pool').textContent(), new RegExp(`${2 + expected} × kość sukcesu`));
        const before = await page.evaluate(() => OneRingStore.rolls.length);
        await page.locator('.dice-roll').click();
        await page.waitForFunction(n => OneRingStore.rolls.length === n + 1, before);
        const entry = fixture.document.rolls.at(-1).entry;
        assert.equal(entry.config.bonus, expected);
        assert.equal(entry.raw.success.length, 2 + expected);
        await page.locator('.dice-close').click();
      }
      await page.evaluate(id => OneRingStore.saveHero({ id, stance: 'Zapalczywa' }), heroId);
      await page.locator('.dice-launch').click();
      await page.locator('[data-step="1"]').click();
      await page.evaluate(async id => {
        await OneRingStore.saveHero({ id, stance: 'Defensywna' });
        await OneRingStore.refresh();
      }, heroId);
      assert.equal(await page.locator('.dice-bonus-value').textContent(), '+2k', 'refresh does not overwrite manual bonus');
      await page.locator('.dice-roll').click();
      await page.locator('.dice-again').click();
      assert.equal(await page.locator('.dice-bonus-value').textContent(), '+2k', 'next roll keeps manual bonus');
      await page.locator('.dice-close').click();
      await page.locator('.dice-launch').click();
      assert.equal(await page.locator('.dice-bonus-value').textContent(), '-1k', 'reopening uses current stance');
      await page.locator('[data-choice="baseDice"] [data-value="0"]').click();
      assert.match(await page.locator('.dice-pool').textContent(), /0 × kość sukcesu/, 'negative modifier cannot create a negative pool');
      await page.locator('.dice-close').click();
      if (role === 'gm') {
        await page.evaluate(() => OneRingStore.selectToken(null));
        await page.locator('.dice-launch').click();
        assert.equal(await page.locator('.dice-bonus-value').textContent(), '0k', 'bound hero bonus never leaks into generic rolls');
        await page.locator('[data-step="1"]').click();
        await page.locator('[data-step="1"]').click();
        await page.locator('.dice-close').click();
        await page.evaluate(() => OneRingStore.selectToken(OneRingStore.getParticipants().find(p => p.type === 'enemy').id));
        await page.locator('.dice-launch').click();
        assert.equal(await page.locator('.dice-bonus-value').textContent(), '+2k', 'enemy opening preserves existing bonus behavior');
        await page.locator('.dice-close').click();
        await page.evaluate(() => OneRingStore.selectToken(null));
        await page.locator('.dice-launch').click();
        assert.equal(await page.locator('.dice-bonus-value').textContent(), '+2k', 'generic opening preserves manual bonus');
        await page.locator('.dice-close').click();
      }
      await page.close();
    }
    console.log('PASS: GM/player stance defaults, legacy/fallback values, actual pools, manual override and generic/enemy isolation');
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
