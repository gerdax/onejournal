/* Gear zero display and clearing against isolated in-memory Supabase storage. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

const names = [
  ...Array.from({ length: 4 }, (_, i) => [`weapon${i}Damage`, `weapon${i}Load`]).flat(),
  'armour', 'armourLoad', 'helmProtection', 'helmLoad', 'shieldParry', 'shieldLoad'
];
const numeric = name => !name.startsWith('weapon');

(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await page.waitForFunction(() => OneRingStore?.connection === 'online');
    await page.locator('[data-tab="heroes"]').click();
    const id = fixture.heroes[0].id;
    const main = page.locator('#hero-editor');
    await page.evaluate(id => OneRingStore.saveHero({ id, weapon0Damage: '0.0', weapon1Load: '00' }, 0), id);
    assert.equal(fixture.document.state.heroes.find(h => h.id === id).weapon0Damage, '0.0');
    assert.equal(fixture.document.state.heroes.find(h => h.id === id).weapon1Load, '00');
    for (const name of names) {
      const control = main.locator(`[name="${name}"]`);
      assert.equal(await control.inputValue(), '', `default ${name}`);
      assert.equal(await control.getAttribute('type'), 'number', `${name} type`);
      assert.equal(await control.getAttribute('min'), '0', `${name} min`);
      await control.fill('2');
      await control.blur();
      await page.waitForFunction(({ id, name }) => OneRingStore.getState().heroes.find(h => h.id === id)?.[name] == 2, { id, name });
      await control.fill('');
      await control.blur();
      await page.waitForFunction(({ id, name, numeric }) => {
        const value = OneRingStore.getState().heroes.find(h => h.id === id)?.[name];
        return numeric ? value === 0 : value === '' || value === '0';
      }, { id, name, numeric: numeric(name) });
      assert.equal(await control.inputValue(), '', `cleared ${name}`);
      assert.equal(await main.locator('.hero-save-status').textContent(), 'Zapisano', `${name} status`);
    }
    assert.equal(await main.locator('[name="treasure"]').inputValue(), '0');
    assert.equal(await main.locator('[name="strength"]').inputValue(), '0');
    await main.locator('[name="armour"]').fill('-1');
    await main.locator('[name="armour"]').blur();
    await page.waitForTimeout(600);
    assert.equal(await main.locator('.hero-save-status').textContent(), 'Popraw zaznaczone pole.');
    assert.equal(fixture.document.state.heroes.find(h => h.id === id).armour, 0);
    await main.locator('[name="armour"]').fill('');
    await main.locator('[name="armour"]').blur();
    await page.waitForFunction(() => document.querySelector('#hero-editor .hero-save-status')?.textContent === 'Zapisano');
    await page.evaluate(() => OneRingStore.refresh());
    for (const name of names) assert.equal(await main.locator(`[name="${name}"]`).inputValue(), '', `refresh ${name}`);
    await page.reload();
    await page.waitForFunction(() => OneRingStore?.connection === 'online');
    await page.locator('[data-tab="heroes"]').click();
    for (const name of names) assert.equal(await main.locator(`[name="${name}"]`).inputValue(), '', `reload ${name}`);

    await page.locator('[data-tab="map"]').click();
    await page.locator('.map-token').evaluateAll((nodes, id) => nodes.find(node => node.dataset.id === 'hero:' + id).click(), id);
    const embedded = page.locator('#map-hero-sheet');
    await embedded.locator('[data-sheet-section="gear"]').evaluate(node => { node.open = true; });
    for (const name of names) assert.equal(await embedded.locator(`[name="${name}"]`).inputValue(), '', `embedded ${name}`);
    for (const name of ['weapon0Damage', 'helmLoad']) {
      const control = embedded.locator(`[name="${name}"]`);
      await control.fill('3');
      await control.blur();
      await page.waitForFunction(({ id, name }) => OneRingStore.getState().heroes.find(h => h.id === id)?.[name] == 3, { id, name });
      await control.fill('');
      await control.blur();
      await page.waitForFunction(({ id, name, numeric }) => {
        const value = OneRingStore.getState().heroes.find(h => h.id === id)?.[name];
        return numeric ? value === 0 : value === '' || value === '0';
      }, { id, name, numeric: numeric(name) });
      assert.equal(await control.inputValue(), '', `embedded clear ${name}`);
    }
    await page.evaluate(() => OneRingStore.refresh());
    for (const name of names) assert.equal(await embedded.locator(`[name="${name}"]`).inputValue(), '', `embedded refresh ${name}`);
    assert.deepEqual(errors, []);
    console.log('PASS: gear zero display, clear and restore in both hero sheets');
  } finally {
    await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
