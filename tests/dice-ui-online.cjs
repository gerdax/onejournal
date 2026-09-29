/* Isolated player and GM dice controls against the in-memory online fixture. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    const player = await browser.newPage();
    await player.goto(fixture.url + '/#access=' + fixture.secrets.players[0]);
    await player.waitForFunction(() => window.OneRingStore?.connection === 'online');
    await player.evaluate(async () => {
      const store = window.OneRingStore;
      await store.saveHero({ id: store.access.heroId, weary: true, miserable: true });
    });
    await player.locator('.dice-launch').click();
    const toggle = player.locator('.dice-collapse');
    assert.equal(await player.locator('#dice-heading').textContent(), fixture.heroes[0].name);
    assert.equal(await player.locator('.dice-launch').isVisible(), false);
    assert.equal(await player.locator('[data-check="exhausted"]').isChecked(), true);
    assert.equal(await player.locator('[data-check="miserable"]').isChecked(), true);
    await player.locator('[data-check="exhausted"]').uncheck();
    await toggle.click();
    assert.equal(await player.locator('#dice-settings').isVisible(), false);
    assert.equal(await player.locator('.dice-setup').isVisible(), false);
    assert.equal(await player.locator('.dice-roll').isVisible(), false);
    assert.equal(await toggle.isVisible(), true);
    assert.equal(await player.locator('.dice-close').isVisible(), true);
    await player.screenshot({ path: '/tmp/onejournal-dice-header-setup.png' });
    await player.locator('#dice-heading').click();
    assert.equal(await player.locator('#dice-settings').isVisible(), true);
    await player.evaluate(() => { window.DiceEngine = { clear() {}, roll: async ({ successCount }) => ({ feat: [7], success: Array(successCount).fill(4) }) }; });
    await player.locator('.dice-roll').click();
    await player.locator('.dice-result:not([hidden])').waitFor();
    assert.equal(await player.locator('#dice-heading').textContent(), 'Wynik');
    await toggle.click();
    assert.equal(await player.locator('.dice-result-groups').isVisible(), false);
    assert.equal(await player.locator('.dice-result').isVisible(), false);
    assert.equal(await player.locator('.dice-again').isVisible(), false);
    await player.screenshot({ path: '/tmp/onejournal-dice-header-result.png' });
    await toggle.click();
    assert.equal(await player.locator('.dice-result-groups').isVisible(), true);
    await player.locator('.dice-close').click();
    assert.equal(await player.locator('.dice-launch').isVisible(), true);
    await player.locator('.dice-launch').click();
    assert.equal(await player.locator('#dice-settings').isVisible(), true);
    assert.equal(await player.locator('[data-check="exhausted"]').isChecked(), true);
    await player.locator('[data-check="hope"]').check();
    await player.locator('.dice-roll').click();
    await player.waitForFunction(() => window.OneRingStore.getState().heroes[0].hope === 7);
    assert.equal(fixture.document.state.heroes[0].hope, 7);
    await player.locator('.dice-again').click();
    await player.locator('[data-check="hope"]').check();
    const rollsBeforeDismissedThrow = await player.evaluate(() => window.OneRingStore.rolls.length);
    await player.evaluate(() => {
      window.diceRollCalls = 0;
      window.DiceEngine = {
        clear() {},
        roll: () => {
          window.diceRollCalls++;
          return new Promise(resolve => { window.finishDismissedThrow = resolve; });
        }
      };
    });
    await player.locator('.dice-roll').click();
    await player.locator('.dice-close').click();
    await player.locator('.dice-launch').click();
    assert.equal(await player.locator('.dice-roll').isDisabled(), true);
    await player.evaluate(() => finishDismissedThrow({ feat: [7], success: [4] }));
    await player.waitForFunction(count => window.OneRingStore.rolls.length === count + 1 && window.OneRingStore.getState().heroes[0].hope === 6, rollsBeforeDismissedThrow);
    assert.equal(await player.evaluate(() => window.diceRollCalls), 1);
    assert.equal(await player.locator('.dice-result').isVisible(), false);
    await player.waitForFunction(() => !document.querySelector('.dice-roll').disabled);
    await player.locator('[data-check="hope"]').check();
    await player.evaluate(() => {
      const store = window.OneRingStore;
      window.originalDiceGetState = store.getState;
      store.getState = () => {
        const state = window.originalDiceGetState();
        state.heroes.find(hero => hero.id === store.access.heroId).hope = 0;
        return state;
      };
    });
    await player.locator('.dice-roll').click();
    assert.match(await player.locator('.dice-error').textContent(), /Brak Nadziei/);
    assert.equal(await player.locator('.dice-result').isVisible(), false);
    await player.evaluate(async () => {
      const store = window.OneRingStore;
      store.getState = window.originalDiceGetState;
      await store.saveHero({ id: store.access.heroId, hope: 0 });
    });
    assert.equal(await player.locator('[data-check="hope"]').isDisabled(), true);
    assert.equal(await player.locator('[data-check="hope"]').isChecked(), false);
    await player.locator('.dice-close').click();
    await player.locator('.dice-launch').click();
    assert.equal(await player.locator('[data-check="hope"]').isDisabled(), true);
    assert.equal(await player.locator('[data-check="hope"]').isChecked(), false);
    await player.close();

    const gm = await browser.newPage();
    await gm.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await gm.waitForFunction(() => window.OneRingStore?.connection === 'online');
    await gm.locator('.dice-launch').click();
    assert.equal(await gm.locator('#dice-heading').textContent(), 'Rzut');
    assert.equal(await gm.locator('[data-check="hope"]').isDisabled(), false);
    await gm.close();
    console.log('PASS: two dice dialog states, player defaults, Hope gate, GM setup heading');
  } finally {
    await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
