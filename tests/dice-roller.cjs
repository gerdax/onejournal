/* Isolated contexts only; exercises real 3D, offline, and controllable lifecycle failures. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8765';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseURL);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    const before = await page.evaluate(() => JSON.stringify(localStorage));
    async function assertDiceVisible(actor) {
      const png = await page.locator('#dice-stage').screenshot({path: path.join(process.env.SCREENSHOT_DIR || '/tmp', `dice-${actor}-tray.png`)});
      // The canvas now covers the result panel too: compare against the same UI
      // with only the transparent rendering layer hidden, rather than counting cream pixels.
      await page.locator('#dice-stage canvas').evaluate(n => { n.style.visibility = 'hidden'; });
      const background = await page.locator('#dice-stage').screenshot();
      await page.locator('#dice-stage canvas').evaluate(n => { n.style.visibility = ''; });
      const pixels = await page.evaluate(async ({ data, background }) => {
        async function decode(data) {
          const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
          const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        }
        const [rgba, base] = await Promise.all([decode(data), decode(background)]);
        let count = 0;
        for (let i = 0; i < rgba.length; i += 4) {
          if (Math.abs(rgba[i] - base[i]) + Math.abs(rgba[i+1] - base[i+1]) + Math.abs(rgba[i+2] - base[i+2]) > 45) count++;
        }
        return count;
      }, { data: png.toString('base64'), background: background.toString('base64') });
      assert.ok(pixels > 100, `${actor} dice must remain visible after settling (${pixels} pixels)`);
    }

    for (const tab of ['heroes', 'opponents', 'map']) {
      await page.locator(`[data-tab="${tab}"]`).click();
      await page.locator('.dice-launch').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.dice-dialog').evaluate(n => n.open), false);
      assert.equal(await page.locator('.dice-launch').evaluate(n => n === document.activeElement), true);
    }
    await page.locator('.dice-launch').click();
    const layer = await page.locator('#dice-stage').evaluate(n => ({
      height: n.getBoundingClientRect().height,
      viewport: window.innerHeight,
      z: Number(getComputedStyle(n).zIndex),
      sheetZ: Number(getComputedStyle(document.querySelector('.dice-sheet')).zIndex),
      pointerEvents: getComputedStyle(n).pointerEvents
    }));
    assert.equal(layer.height, layer.viewport);
    assert.ok(layer.z > layer.sheetZ);
    assert.equal(layer.pointerEvents, 'none');
    await page.locator('[data-choice="baseDice"] [data-value="3"]').click();
    await page.locator('[data-choice="featMode"] [data-value="favoured"]').click();
    await page.locator('[data-check="hope"]').check();
    await page.locator('[data-check="inspired"]').check();
    await page.locator('[data-step="1"]').click();
    await page.locator('[data-target]').fill('16');
    await page.locator('.dice-roll').click();
    assert.equal(await page.locator('[data-choice="actor"] button').first().isDisabled(), true);
    await page.locator('.dice-result:not([hidden])').waitFor({ timeout: 40000 });
    assert.equal(await page.locator('.dice-result-row').nth(0).locator('.dice-result-die').count(), 2);
    assert.equal(await page.locator('.dice-result-row').nth(1).locator('.dice-result-die').count(), 6);
    assert.match(await page.locator('.dice-total').innerText(), /\/16$/);
    assert.equal(await page.locator('#dice-stage canvas').count(), 1);
    await page.waitForTimeout(400); // let the tray resize finish before the visual snapshot
    await assertDiceVisible('hero');
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR || '/tmp', 'dice-hero.png') });
    await page.locator('.dice-again').click();
    assert.equal(await page.locator('[data-check="inspired"]').isChecked(), true);
    await page.locator('[data-choice="actor"] [data-value="enemy"]').click();
    assert.equal(await page.locator('.dice-enemy-resource').isVisible(), true);
    assert.match(await page.locator('.dice-enemy-resource').innerText(), /Wydaj Nienawiść\/Determinację/);
    assert.equal(await page.locator('.dice-hero-resource').isVisible(), false);
    assert.equal(await page.locator('.dice-inspired').isVisible(), false);
    assert.equal(await page.locator('[data-check="enemyResource"]').isChecked(), false);
    assert.match(await page.locator('.dice-pool').innerText(), /4 × kość sukcesu/);
    await page.locator('[data-check="enemyResource"]').check();
    assert.match(await page.locator('.dice-pool').innerText(), /5 × kość sukcesu/);
    await page.locator('[data-check="enemyResource"]').uncheck();
    assert.match(await page.locator('.dice-pool').innerText(), /4 × kość sukcesu/);
    await page.locator('[data-choice="actor"] [data-value="hero"]').click();
    assert.equal(await page.locator('[data-check="hope"]').isChecked(), true);
    assert.equal(await page.locator('[data-check="inspired"]').isChecked(), true);
    assert.match(await page.locator('.dice-pool').innerText(), /6 × kość sukcesu/);
    await page.locator('[data-choice="actor"] [data-value="enemy"]').click();
    assert.equal(await page.locator('[data-check="enemyResource"]').isChecked(), false);
    await page.locator('[data-check="enemyResource"]').check();
    await page.locator('[data-target]').fill('');
    await page.locator('.dice-roll').click();
    await page.locator('.dice-result:not([hidden])').waitFor({ timeout: 40000 });
    const autoSuccess = (await page.locator('.dice-result-row').first().locator('.dice-result-die:not(.is-unused)').getAttribute('aria-label')).includes('Oko Saurona');
    assert.equal(await page.locator('.dice-verdict').count(), autoSuccess ? 1 : 0);
    assert.equal(await page.locator('.dice-result-row').nth(1).locator('.dice-result-die').count(), 5);
    await page.waitForTimeout(400);
    await assertDiceVisible('enemy');
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR || '/tmp', 'dice-enemy.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), before);

    // Reload offline before any new roll: every lazy asset must be precached.
    await context.setOffline(true);
    await page.reload();
    await page.locator('.dice-launch').click();
    await page.locator('[data-choice="actor"] [data-value="enemy"]').click();
    await page.locator('.dice-roll').click();
    await page.locator('.dice-result:not([hidden])').waitFor({ timeout: 40000 });
    assert.equal(await page.locator('.dice-result-row').nth(1).locator('.dice-result-die').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const mobile = await phone.newPage();
    await mobile.goto(baseURL);
    // Preserve production adapter while intercepting its contract for deterministic UI cases.
    await mobile.evaluate(() => { window.DiceEngine = { roll: () => new Promise(resolve => { window.finishDice = resolve; }), clear() {} }; });
    await mobile.locator('.dice-launch').click();
    await mobile.locator('[data-choice="actor"] [data-value="enemy"]').click();
    assert.equal(await mobile.locator('.dice-sheet').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    assert.equal(await mobile.locator('.dice-enemy-resource').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    await mobile.locator('.dice-enemy-resource').scrollIntoViewIfNeeded();
    await mobile.screenshot({ path: path.join(process.env.SCREENSHOT_DIR || '/tmp', 'dice-mobile-enemy-setup.png') });
    await mobile.locator('[data-choice="actor"] [data-value="hero"]').click();
    await mobile.screenshot({ path: path.join(process.env.SCREENSHOT_DIR || '/tmp', 'dice-mobile-setup.png') });
    assert.equal(await mobile.locator('.dice-sheet').evaluate(n => n.scrollWidth <= n.clientWidth), true);
    await mobile.locator('.dice-roll').click();
    await mobile.keyboard.press('Escape');
    await mobile.locator('.dice-launch').click();
    assert.equal(await mobile.locator('.dice-roll').isDisabled(), true);
    await mobile.evaluate(() => finishDice({ feat: [12], success: [] }));
    await mobile.waitForFunction(() => !document.querySelector('.dice-roll').disabled);
    assert.equal(await mobile.locator('.dice-result').isVisible(), false);
    await mobile.evaluate(() => { window.DiceEngine.roll = () => Promise.reject(new Error('Test WebGL')); });
    await mobile.locator('.dice-roll').click();
    await mobile.locator('.dice-error:not([hidden])').waitFor();
    assert.match(await mobile.locator('.dice-error').innerText(), /Test WebGL/);
    await mobile.keyboard.press('Escape');
    await mobile.locator('[data-tab="map"]').click();
    await mobile.locator('.map-viewport').evaluate(n => n.classList.add('is-fullscreen'));
    assert.equal(await mobile.locator('.dice-launch').isVisible(), true);
    await phone.close();
    console.log('Dice roller: real hero/enemy/zero-dice rolls, offline, lifecycle, errors, mobile and storage isolation passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
