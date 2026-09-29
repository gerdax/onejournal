/* Isolated browser coverage for the two dice sheet states and backdrop dismissal. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    for (const width of [1200, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
      await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
      await page.evaluate(() => { window.DiceEngine = { roll: async () => ({ feat: [7], success: [3, 6] }), clear() {} }; });
      await page.locator('.dice-launch').click();
      const toggle = page.locator('.dice-collapse');
      const expanded = await page.locator('.dice-sheet').evaluate(node => node.offsetHeight);
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.dice-setup').isVisible(), false);
      assert.ok(await page.locator('.dice-sheet').evaluate(node => node.offsetHeight) < expanded - 150);
      assert.equal(await toggle.isVisible(), true);
      assert.equal(await page.locator('.dice-close').isVisible(), true);
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('.dice-settings').isVisible(), true);

      // A gesture beginning on the sheet may end over the transparent backdrop.
      const head = await toggle.boundingBox();
      const x = head.x + head.width / 2;
      await page.mouse.move(x, head.y + head.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, 12);
      await page.mouse.up();
      assert.equal(await page.locator('.dice-dialog').evaluate(node => node.open), true);
      await page.mouse.click(x, 12);
      assert.equal(await page.locator('.dice-dialog').evaluate(node => node.open), false);

      await page.locator('.dice-launch').click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await page.locator('[data-choice="baseDice"] [data-value="2"]').click();
      await page.locator('.dice-roll').click();
      await page.locator('.dice-result:not([hidden])').waitFor();
      assert.equal(await page.locator('.dice-result-groups').isVisible(), true);
      await toggle.click();
      assert.equal(await page.locator('.dice-result').isVisible(), false);
      assert.equal(await toggle.getAttribute('aria-controls'), 'dice-result-details');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await toggle.click();
      assert.equal(await page.locator('.dice-result-groups').isVisible(), true);
      await page.locator('.dice-close').click();
      await page.locator('.dice-launch').click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('[data-choice="baseDice"] [data-value="2"]').getAttribute('aria-pressed'), 'true');
      await page.close();
    }
    console.log('PASS: two dice sheet states and safe backdrop dismissal at desktop and mobile widths');
  } finally {
    await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
