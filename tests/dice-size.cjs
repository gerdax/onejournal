const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    // Observe configuration without replacing the real rendering or physics.
    const adapter = fs.readFileSync(path.join(__dirname, '../dice-engine.js'), 'utf8').replace('new DiceBox({', `new (class extends DiceBox {
      constructor(config) { super(config); window.testDiceScale = config.scale; }
      updateConfig(config) { window.testDiceScale = config.scale; return super.updateConfig(config); }
    })({`);
    const cases = [[1200, 800, 1, false], [1200, 1000, 2, true], [658, 839, 2, false], [390, 844, 3, true]];
    for (const [width, height, dpr, compact] of cases) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/dice-engine.js?*', route => route.fulfill({ contentType: 'text/javascript', body: adapter }));
      await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
      await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
      await page.locator('.dice-launch').click();
      await page.locator('[data-choice="baseDice"] [data-value="3"]').click();
      await page.locator('.dice-roll').click();
      await page.locator('.dice-result:not([hidden])').waitFor({ timeout: 30000 });
      if (compact) await page.locator('.dice-collapse').click();
      const measurement = await page.evaluate(() => {
        const c = document.querySelector('#dice-stage canvas');
        return { projectionScale: testDiceScale * c.clientHeight, bufferWidth: c.width, cssWidth: c.clientWidth };
      });
      assert.ok(Math.abs(measurement.projectionScale - 4400 / 1.5) < .001);
      assert.equal(measurement.bufferWidth, Math.floor(width * Math.min(dpr, 1.5)));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/tmp/dice-size-${width}-${height}.png` });
      console.log({ width, height, dpr, compact, ...measurement });
      if (width === 390) {
        await page.locator('.dice-collapse').click();
        await page.locator('.dice-again').click();
        await page.locator('[data-choice="baseDice"] [data-value="6"]').click();
        await page.locator('[data-choice="featMode"] [data-value="favoured"]').click();
        await page.locator('[data-check="hope"]').check();
        await page.locator('[data-check="inspired"]').check();
        for (let i = 0; i < 6; i++) await page.locator('[data-step="1"]').click();
        await page.locator('.dice-roll').click();
        await page.locator('.dice-result:not([hidden])').waitFor({ timeout: 30000 });
        assert.equal(await page.locator('.dice-result-die').count(), 16);
        await page.screenshot({ path: '/tmp/dice-size-mobile-full-pool.png' });
      }
      await context.close();
    }
    console.log('Constant on-screen scale, header-only/full result, Retina and full mobile pool passed.');
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
