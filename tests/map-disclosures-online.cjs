/* Map disclosures share their open pattern across participants in an isolated online fixture. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await page.waitForFunction(() => OneRingStore?.connection === 'online');
    await page.locator('[data-tab="map"]').click();
    const firstEnemy = await page.evaluate(() => OneRingStore.getState().battle[0].id);
    const secondEnemy = await page.evaluate(async () => (await OneRingStore.addEnemy({ name: 'Drugi ork', kind: 'Ork', notes: 'Drugie notatki', attack: 'Topór', traits: 'Silny' })).id);
    const select = id => page.evaluate(id => OneRingMap.selectParticipant(id), id);
    const hero = page.locator('#map-hero-sheet');
    const sections = hero.locator('details.sheet-disclosure');
    const heroPattern = () => sections.evaluateAll(nodes => nodes.map(node => node.open));
    const setHeroPattern = pattern => sections.evaluateAll((nodes, pattern) => nodes.forEach((node, index) => { node.open = pattern[index]; }), pattern);
    const enemyPattern = () => page.evaluate(() => [document.querySelector('#map-enemy-details').open, document.querySelector('#map-enemy-notes').open]);

    await select('hero:' + fixture.heroes[0].id);
    assert.deepEqual(await heroPattern(), [false, false, false, false, false]);
    await setHeroPattern([true, false, true, false, true]);
    await hero.locator('[name="hope"]').fill('-1');
    await hero.locator('[name="hope"]').blur();
    await select('hero:' + fixture.heroes[1].id);
    assert.deepEqual(await heroPattern(), [true, false, true, false, true], 'fresh hero inherits all five disclosure states');
    assert.equal(await hero.locator('[name="hope"]').inputValue(), '7', 'draft stays with its original hero');
    await setHeroPattern([false, true, false, true, false]);
    await select('hero:' + fixture.heroes[0].id);
    assert.deepEqual(await heroPattern(), [false, true, false, true, false], 'cached hero follows the latest pattern');
    assert.equal(await hero.locator('[name="hope"]').inputValue(), '-1', 'cached invalid draft survives selection');

    await select(firstEnemy);
    assert.deepEqual(await enemyPattern(), [false, false]);
    await page.locator('#map-enemy-details').evaluate(node => { node.open = true; });
    await select(secondEnemy);
    assert.deepEqual(await enemyPattern(), [true, false], 'enemy detail and notes states are separate');
    await page.locator('#map-enemy-details').evaluate(node => { node.open = false; });
    await page.locator('#map-enemy-notes').evaluate(node => { node.open = true; });
    await select('hero:' + fixture.heroes[1].id);
    assert.deepEqual(await heroPattern(), [false, true, false, true, false], 'hero pattern survives enemy selection');
    await select(firstEnemy);
    assert.deepEqual(await enemyPattern(), [false, true], 'enemy pattern survives a hero selection');
    assert.equal(await page.locator('#map-enemy-notes').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: shared map disclosure patterns and hero drafts across participant switches');
  } finally {
    await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
