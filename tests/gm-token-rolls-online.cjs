/* GM dice context against isolated in-memory game state. */
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
    const page = await browser.newPage();
    const player = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await player.goto(fixture.url + '/#access=' + fixture.secrets.players[0]);
    await page.waitForFunction(() => window.OneRingStore?.connection === 'online' && !!window.OneJournalRolls?.prepare);
    await player.waitForFunction(() => window.OneRingStore?.connection === 'online');
    await page.evaluate(() => { DiceEngine = { clear() {}, async roll({ featCount, successCount }) {
      return { feat: Array(featCount).fill(7), success: Array(successCount).fill(4) };
    } }; });
    const heroId = fixture.heroes[0].id;
    const enemyId = fixture.document.state.battle[0].id;
    const dialog = page.locator('.dice-dialog');
    const open = async () => page.locator('.dice-launch').click();
    const close = async () => page.locator('.dice-close').click();
    const select = async id => page.evaluate(value => OneRingStore.selectToken(value), id);
    const roll = async count => {
      await page.locator('.dice-roll').click();
      await page.waitForFunction(n => OneRingStore.rolls.length === n, count);
    };

    await select(null); await open();
    assert.equal(await page.locator('#dice-heading').textContent(), 'Rzut');
    assert.equal(await dialog.locator('[data-choice="actor"]').isVisible(), true);
    assert.deepEqual(await dialog.locator('[data-choice="actor"] button').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))),
      ['Runa Gandalfa', 'Oko Saurona']);
    assert.equal(await dialog.locator('[data-choice="actor"] .dice-feat-symbol').count(), 2);
    assert.equal(await dialog.locator('[data-check="privateRoll"]').isChecked(), true);
    assert.equal(await dialog.locator('.dice-private').evaluate(label => {
      const preview = document.querySelector('.dice-preview'), exhausted = document.querySelector('[data-check="exhausted"]');
      const checkbox = label.querySelector('input');
      return label.parentElement === preview.parentElement && getComputedStyle(label).fontSize === getComputedStyle(exhausted.parentElement).fontSize && getComputedStyle(checkbox).width === getComputedStyle(exhausted).width && getComputedStyle(checkbox).height === getComputedStyle(exhausted).height;
    }), true);
    assert.equal(await dialog.locator('.dice-hero-resource').isVisible(), true);
    assert.equal(await dialog.locator('.dice-enemy-resource').isVisible(), false);
    await dialog.locator('[data-check="hope"]').check();
    await dialog.locator('[data-check="inspired"]').check();
    assert.equal(await dialog.locator('[data-check="inspired"]').isChecked(), true);
    await dialog.locator('[data-check="privateRoll"]').uncheck();
    await dialog.locator('[data-choice="actor"] [data-value="enemy"]').click();
    assert.equal(await dialog.locator('[data-check="privateRoll"]').isChecked(), false);
    assert.equal(await dialog.locator('.dice-enemy-resource').isVisible(), true);
    const genericPool = await dialog.locator('.dice-pool').textContent();
    await dialog.locator('[data-check="enemyResource"]').check();
    assert.equal(await dialog.locator('[data-check="enemyResource"]').isChecked(), true);
    assert.notEqual(await dialog.locator('.dice-pool').textContent(), genericPool);
    await roll(1);
    assert.equal(fixture.document.rolls.at(-1).entry.enemyId, undefined);
    assert.equal(fixture.document.state.battle.find(e => e.id === enemyId).hate, 4);
    await close();
    await open();
    assert.equal(await dialog.locator('[data-check="privateRoll"]').isChecked(), true);
    await close();

    await page.evaluate(async id => { await OneRingStore.saveHero({ id, hope: 1, weary: true, miserable: true }, 0); }, heroId);
    await select('hero:' + heroId); await open();
    assert.equal(await page.locator('#dice-heading').textContent(), fixture.heroes[0].name);
    assert.equal(await dialog.locator('[data-choice="actor"]').isVisible(), false);
    assert.equal(await dialog.locator('[data-check="privateRoll"]').isChecked(), false);
    assert.equal(await dialog.locator('[data-check="exhausted"]').isChecked(), true);
    assert.equal(await dialog.locator('[data-check="miserable"]').isChecked(), true);
    assert.equal(await dialog.locator('[data-check="hope"]').isChecked(), false);
    await dialog.locator('[data-check="hope"]').check();
    await dialog.locator('[data-check="inspired"]').check();
    await dialog.locator('[data-check="privateRoll"]').check();
    assert.equal(await page.locator('#dice-heading').textContent(), fixture.heroes[0].name + ' (Priv)');
    await roll(2);
    assert.equal(fixture.document.rolls.at(-1).entry.heroId, heroId);
    assert.equal(fixture.document.rolls.at(-1).entry.name, fixture.heroes[0].name);
    assert.match(await page.locator('.journal-toast').textContent(), /^Ala \(Priv\):/);
    assert.equal(fixture.document.rolls.at(-1).entry.actor, 'hero');
    assert.equal(fixture.document.rolls.at(-1).visibility, 'private');
    assert.equal(fixture.document.state.heroes.find(h => h.id === heroId).hope, 0);
    await player.evaluate(() => OneRingStore.refresh());
    assert.equal(await player.evaluate(id => OneRingStore.getState().heroes.find(h => h.id === id).hope, heroId), 0);
    assert.equal(await player.evaluate(() => OneRingStore.rolls.length), 1);
    await dialog.locator('.dice-again').click();
    assert.equal(await dialog.locator('[data-check="privateRoll"]').isChecked(), true);
    assert.equal(await dialog.locator('[data-check="hope"]').isDisabled(), true);
    assert.equal(await dialog.locator('[data-check="hope"]').isChecked(), false);
    assert.equal(await dialog.locator('[data-check="inspired"]').isVisible(), false);
    await close();
    await open();
    assert.equal(await dialog.locator('[data-check="privateRoll"]').isChecked(), false);
    await close();

    await select(enemyId); await open();
    assert.equal(await page.locator('#dice-heading').textContent(), 'Ork Sekretny');
    assert.equal(await dialog.locator('[data-choice="actor"]').isVisible(), false);
    assert.equal(await dialog.locator('[data-check="privateRoll"]').isChecked(), false);
    assert.equal(await dialog.locator('.dice-enemy-resource').isVisible(), true);
    assert.equal(await dialog.locator('.dice-hero-resource').isVisible(), false);
    await dialog.locator('[data-check="enemyResource"]').check();
    await page.evaluate(() => { DiceEngine.roll = () => new Promise(resolve => { window.resolveRoll = resolve; }); });
    await dialog.locator('.dice-roll').click();
    await select('hero:' + heroId);
    await page.evaluate(() => resolveRoll({ feat: [7], success: [4] }));
    await page.waitForFunction(() => OneRingStore.rolls.length === 3);
    assert.equal(fixture.document.rolls.at(-1).entry.enemyId, enemyId);
    assert.equal(fixture.document.state.battle.find(e => e.id === enemyId).hate, 3);
    await close();

    await select('hero:' + heroId); await open();
    await page.evaluate(id => OneRingStore.deleteHero(id), heroId);
    await dialog.locator('.dice-roll').click();
    assert.match(await dialog.locator('.dice-error').textContent(), /bohater.*usunięty/);
    assert.equal(fixture.document.rolls.length, 3);
    await close();

    await page.setViewportSize({ width: 360, height: 740 });
    await select(null); await open();
    assert.equal(await dialog.locator('[data-choice="actor"]').isVisible(), true);
    assert.equal(await dialog.locator('.dice-pool-row').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await dialog.locator('.dice-sheet').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await close();
    assert.deepEqual(errors, []);
    console.log('PASS: GM generic, hero, enemy, resource, identity, deletion and mobile dice contexts');
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
