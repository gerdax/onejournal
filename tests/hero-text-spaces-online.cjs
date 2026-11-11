/* Autosave must preserve whitespace and caret in both player sheet editors. */
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
    await page.goto(fixture.url + '/#access=' + fixture.secrets.players[0]);
    await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
    for (const [tab, selector] of [['heroes', '#hero-editor'], ['map', '#map-hero-sheet form']]) {
      await page.locator(`[data-tab="${tab}"]`).click();
      const editor = page.locator(selector);
      await editor.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
      for (const [field, text] of [['name', `Ala ${tab} `], ['notes', `Pierwszy wiersz\nDrugi ${tab}  \n`]]) {
        const control = editor.locator(`[name="${field}"]`);
        await control.fill(text);
        await control.press('End');
        const caret = await control.evaluate(node => node.selectionStart);
        await page.waitForFunction(({selector}) => document.querySelector(selector + ' .hero-save-status').textContent === 'Zapisano', {selector});
        assert.equal(await control.inputValue(), text);
        assert.equal(await control.evaluate(node => node.selectionStart), caret);
        assert.equal(await control.evaluate(node => document.activeElement === node), true);
        assert.equal(fixture.document.state.heroes[0][field], text);
        await page.evaluate(() => OneRingStore.refresh());
        assert.equal(await control.inputValue(), text);
        assert.equal(await control.evaluate(node => node.selectionStart), caret);
        await control.press('X');
        const continued = text.slice(0, caret) + 'X' + text.slice(caret);
        await page.waitForFunction(({field, continued}) => OneRingStore.getState().heroes[0][field] === continued, {field, continued});
        assert.equal(await control.inputValue(), continued);
      }
    }
    await page.reload();
    await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
    assert.equal(await page.evaluate(() => OneRingStore.getState().heroes[0].name), 'Ala map X');
    assert.deepEqual(errors, []);
    console.log('PASS: whitespace, caret, continued typing and reload in both hero editors');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
