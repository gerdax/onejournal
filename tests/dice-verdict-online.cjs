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
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
    await page.locator('.dice-launch').click();
    const cases = [
      { target: '8', feat: 7, text: 'PORAŻKA', failure: true },
      { target: '7', feat: 7, text: 'SUKCES' },
      { target: '6', feat: 7, text: 'SUKCES' },
      { target: '', feat: 7, text: null },
      { target: '0', feat: 7, text: 'SUKCES' },
      { target: '19', feat: 12, text: 'AUTOMATYCZNY SUKCES' },
      { target: '', feat: 12, text: 'AUTOMATYCZNY SUKCES' },
      { target: '0', feat: 11, miserable: true, text: 'PORAŻKA', failure: true }
    ];
    for (const [index, test] of cases.entries()) {
      if (index) await page.locator('.dice-again').click();
      await page.locator('[data-target]').fill(test.target);
      await page.locator('[data-check="miserable"]').setChecked(!!test.miserable);
      await page.evaluate(feat => { window.DiceEngine = { roll: async () => ({ feat: [feat], success: [] }), clear() {} }; }, test.feat);
      await page.locator('.dice-roll').click();
      await page.locator('.dice-result:not([hidden])').waitFor();
      const verdict = page.locator('.dice-result-summary .dice-verdict');
      assert.equal(await verdict.count(), test.text ? 1 : 0);
      if (test.text) {
        assert.ok((await verdict.textContent()).includes(test.text));
        assert.equal(await verdict.evaluate(node => getComputedStyle(node).color), test.failure ? 'rgb(90, 68, 53)' : 'rgb(168, 70, 55)');
      }
    }
    console.log('PASS: target failure/success/equality/zero, no target, automatic success and miserable failure');
  } finally { if (browser) await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
