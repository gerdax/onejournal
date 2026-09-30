/* Selected enemy dice settings and resource spending against the isolated online fixture. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
    const enemyId = fixture.document.state.battle[0].id;
    await page.evaluate(async id => {
      await OneRingStore.setEnemyWeary(id, true);
      const originalSelect = OneRingStore.selectToken.bind(OneRingStore);
      OneRingStore.selectToken = selectedId => new Promise((resolve, reject) => {
        window.releaseSelect = () => {
          OneRingStore.selectToken = originalSelect;
          return originalSelect(selectedId).then(resolve, reject);
        };
      });
    }, enemyId);
    await page.locator('[data-tab="map"]').click();
    await page.locator(`.map-token[data-id="${enemyId}"]`).click();
    await page.waitForFunction(() => typeof window.releaseSelect === 'function');
    await page.locator('.dice-launch').click();
    assert.equal(await page.locator('[data-choice="actor"] button[data-value="enemy"]').textContent(), 'Ork Sekretny');
    assert.equal(await page.locator('[data-choice="actor"] button[data-value="enemy"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-check="exhausted"]').isChecked(), true);
    assert.equal(await page.locator('[data-check="enemyResource"]').isChecked(), false);
    assert.equal(await page.locator('.dice-spend-text').textContent(), 'Wydaj Nienawiść');
    await page.evaluate(() => releaseSelect());
    await page.locator('[data-check="exhausted"]').uncheck();
    await page.locator('[data-target]').fill('13');
    await page.locator('[data-choice="actor"] button[data-value="hero"]').click();
    assert.equal(await page.locator('[data-check="exhausted"]').isChecked(), false);
    assert.equal(await page.locator('[data-target]').inputValue(), '');
    await page.locator('[data-choice="actor"] button[data-value="enemy"]').click();
    assert.equal(await page.locator('[data-check="exhausted"]').isChecked(), false);
    assert.equal(await page.locator('[data-target]').inputValue(), '13');
    await page.locator('.dice-close').click();
    await page.evaluate(async () => { await OneRingStore.selectToken(null); });
    await page.locator('.dice-launch').click();
    assert.equal(await page.locator('[data-choice="actor"] button[data-value="enemy"]').textContent(), 'Przeciwnik');
    assert.equal(await page.locator('.dice-error').isVisible(), false);
    assert.equal(await page.locator('[data-check="exhausted"]').isChecked(), false);
    await page.locator('.dice-close').click();
    await page.evaluate(async () => { await OneRingStore.selectToken(OneRingStore.getParticipants().find(p => p.type === 'hero').id); });
    await page.locator('.dice-launch').click();
    assert.equal(await page.locator('[data-choice="actor"] button[data-value="enemy"]').textContent(), 'Przeciwnik');
    await page.locator('.dice-close').click();

    await page.evaluate(async id => {
      await OneRingStore.adjustResource(id, 'hate', -3);
      await OneRingStore.selectToken(id);
      window.DiceEngine = { clear() {}, roll: async ({ successCount }) => ({ feat: [7], success: Array(successCount).fill(4) }) };
    }, enemyId);
    await page.locator('.dice-launch').click();
    assert.equal(await page.locator('[data-check="exhausted"]').isChecked(), true);
    await page.locator('[data-check="enemyResource"]').check();
    await page.locator('.dice-roll').click();
    await page.waitForFunction(id => OneRingStore.getParticipants().find(p => p.id === id).hate === 0, enemyId);
    assert.equal(fixture.document.state.battle[0].hate, 0);
    assert.equal(await page.locator('#map-panel .map-resource[data-field="hate"] strong span').textContent(), '0');
    assert.equal(fixture.document.rolls.at(-1).entry.enemyId, enemyId);
    assert.equal(fixture.document.rolls.at(-1).entry.name, 'Ork Sekretny');
    await page.locator('.dice-again').click();
    assert.equal(await page.locator('[data-check="enemyResource"]').isDisabled(), true);
    assert.equal(await page.locator('[data-check="enemyResource"]').isChecked(), false);
    await page.locator('.dice-close').click();

    const secondId = await page.evaluate(async id => {
      await OneRingStore.adjustResource(id, 'hate', 1);
      await OneRingStore.addEnemy({ name: 'Strażnik', kind: 'Człowiek', resourceType: 'determination',
        endurance: 10, maxEndurance: 10, hate: 1, maxHate: 1, might: 1, parry: 1, armour: 1 });
      return OneRingStore.getParticipants().find(person => person.name === 'Strażnik').id;
    }, enemyId);
    await page.locator('.dice-launch').click();
    await page.evaluate(() => {
      window.DiceEngine = { clear() {}, roll: () => new Promise(resolve => { window.finishEnemyRoll = resolve; }) };
    });
    await page.locator('[data-check="enemyResource"]').check();
    await page.locator('.dice-roll').click();
    await page.evaluate(async id => {
      await OneRingStore.selectToken(id);
      finishEnemyRoll({ feat: [7], success: [4] });
    }, secondId);
    await page.waitForFunction(id => OneRingStore.getParticipants().find(p => p.id === id).hate === 0, enemyId);
    assert.equal(fixture.document.rolls.at(-1).entry.enemyId, enemyId, 'selection change during animation cannot redirect cost');
    assert.equal(fixture.document.state.battle.find(person => person.id === secondId).hate, 1);
    await page.locator('.dice-close').click();
    await page.locator('.dice-launch').click();
    assert.equal(await page.locator('[data-choice="actor"] button[data-value="enemy"]').textContent(), 'Strażnik');
    assert.equal(await page.locator('.dice-spend-text').textContent(), 'Wydaj Determinację');
    await page.evaluate(async id => { await OneRingStore.removeParticipant(id); }, secondId);
    await page.locator('.dice-roll').click();
    assert.match(await page.locator('.dice-error').textContent(), /usunięty.*otwórz panel kości ponownie/);
    assert.equal(fixture.document.rolls.length, 2);
    await page.locator('.dice-close').click();
    await page.locator('.dice-launch').click();
    assert.equal(await page.locator('[data-choice="actor"] button[data-value="enemy"]').textContent(), 'Przeciwnik');
    assert.equal(await page.locator('.dice-error').isVisible(), false);
    await page.locator('.dice-close').click();
    await page.close();
    console.log('PASS: selected enemy preset, isolated generic controls, named roll, resource spend and zero gate');
  } finally {
    await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
