/* Encounter-only exhaustion and resource warnings, using isolated cloud data. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
(async () => {
  const fixture = await startFixture();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await page.locator('main').waitFor({ state: 'visible' });
    const ids = await page.evaluate(async () => {
      const s = OneRingStore;
      const template = await s.addLibrary({ name: 'Ork testowy', might: 1, maxEndurance: 10, maxHate: 1 });
      const first = await s.addEnemy(template), second = await s.addEnemy(template);
      await s.setMap(OneRingMap.generateTerrain('clearing', 'small', 'weary'));
      await s.selectToken(first.id);
      return [first.id, second.id];
    });
    await page.locator('[data-tab="map"]').click();
    const weary = page.locator('#map-panel [name="weary"]');
    const resource = page.locator('#map-panel [data-field="hate"] strong span');
    const label = page.locator('#map-panel [name="weary"] + span');
    const check = async (value, expectedWeary, numberWarning, labelWarning) => {
      await page.waitForFunction(({ value, expectedWeary, numberWarning, labelWarning }) => {
        const input = document.querySelector('#map-panel [name="weary"]');
        const number = document.querySelector('#map-panel [data-field="hate"] strong span');
        return input && !input.disabled && input.checked === expectedWeary && number.textContent === String(value)
          && number.classList.contains('is-resource-warning') === numberWarning
          && input.nextElementSibling.classList.contains('is-resource-warning') === labelWarning;
      }, { value, expectedWeary, numberWarning, labelWarning });
    };
    await check(1, false, false, false);
    await weary.check();
    await check(1, true, false, true);
    await page.getByRole('button', { name: 'Zmniejsz nienawiść', exact: true }).click();
    await check(0, true, false, false);
    await weary.uncheck();
    await check(0, false, true, false);
    await weary.check();
    await check(0, true, false, false);
    await page.getByRole('button', { name: 'Zwiększ nienawiść', exact: true }).click();
    await check(1, true, false, true);
    assert.equal(await label.textContent(), 'Wyczerpany');
    assert.equal(await resource.textContent(), '1');
    await page.reload();
    await page.locator('main').waitFor({ state: 'visible' });
    await page.locator('[data-tab="map"]').click();
    await check(1, true, false, true);
    await page.evaluate(id => OneRingStore.selectToken(id), ids[1]);
    await check(1, false, false, false);
    await page.locator('[data-tab="opponents"]').click();
    assert.equal(await page.locator('#library [name="weary"], #generator [name="weary"]').count(), 0);
    assert.equal(await page.evaluate(() => Object.hasOwn(OneRingStore.getState().library[0], 'weary')), false);
    assert.deepEqual(errors, []);
    console.log('PASS: enemy exhaustion warnings, resource edits, reload, independent copies and library isolation');
  } finally {
    await browser?.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
