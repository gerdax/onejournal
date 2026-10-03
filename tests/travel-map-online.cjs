'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let release, requests = [], hold = true, failNext = false;
    await page.route('**/functions/v1/onejournal', async route => {
      const body = route.request().postDataJSON();
      if (body.action === 'travelMapGet') {
        requests.push(body);
        if (failNext) { failNext = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture unavailable' }) }); }
        if (hold) await new Promise(resolve => { release = resolve; });
      }
      await route.continue();
    });
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    const launch = page.locator('.travel-map-launch'), dialog = page.locator('.travel-map-dialog');
    await launch.waitFor({ state: 'visible' });
    assert(Math.abs((await launch.boundingBox()).width - 46.2) < 0.02);
    await launch.click();
    await page.waitForFunction(() => document.querySelector('.travel-map-dialog').open);
    assert.equal(await dialog.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
    assert.equal(await page.locator('.travel-map-message').textContent(), 'Wczytywanie mapy…');
    assert.equal(await launch.isVisible(), false);
    await page.waitForTimeout(100);
    assert(release, 'image request started after placeholder'); hold = false; release();
    const image = page.locator('.travel-map-image'); await image.waitFor({ state: 'visible' });
    assert.equal(await image.getAttribute('alt'), 'Mapa podróży');
    assert.equal(await dialog.locator('button:visible').count(), 0);
    const original = await image.boundingBox();
    assert(original.width >= 1200 && original.height >= 700);
    await page.mouse.move(600, 350); await page.mouse.down(); await page.mouse.move(600, 200, { steps: 8 }); await page.mouse.up();
    assert(await dialog.evaluate(el => el.open), 'drag must not close');
    assert((await image.boundingBox()).y < original.y);
    await page.mouse.click(600, 350); await dialog.waitFor({ state: 'hidden' });
    await launch.click(); await image.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !!OneRingStore.getCachedTravelMap());
    await page.waitForTimeout(100);
    assert(requests[1].knownVersion, 'reopen sends cache validator');
    await page.keyboard.press('Escape');
    assert.equal(await launch.evaluate(el => document.activeElement === el), true);
    // Modal blocking: normal clicks cannot reach the launcher; synthetic activation is guarded too.
    for (const selector of ['#journal-open', '.dice-launch', '#settings-open']) {
      await page.locator(selector).click();
      await page.evaluate(() => document.querySelector('.travel-map-launch').click());
      assert.equal(await dialog.evaluate(el => el.open), false, selector);
      await page.keyboard.press('Escape');
    }
    await page.locator('[data-tab="map"]').click(); await page.locator('#map-fullscreen').click();
    assert.equal(await launch.isVisible(), false);
    await page.evaluate(() => document.querySelector('.travel-map-launch').click());
    assert.equal(await dialog.evaluate(el => el.open), false);
    assert.equal(await page.locator('.dice-launch').isVisible(), true);
    await page.locator('#map-fullscreen').click(); assert.equal(await launch.isVisible(), true);
    // Narrow viewport scrolls horizontally, and stays inside bounds after a long drag.
    await page.setViewportSize({ width: 390, height: 844 }); await launch.click(); await image.waitFor({ state: 'visible' });
    await page.mouse.move(195, 400); await page.mouse.down(); await page.mouse.move(1000, 400, { steps: 5 }); await page.mouse.up();
    const moved = await image.boundingBox(); assert.equal(moved.x, 0); assert(moved.width >= 390 && moved.height >= 844);
    await page.keyboard.press('Escape');
    // Closing a slow load never reopens the overlay when the response arrives.
    await page.reload(); await launch.waitFor({ state: 'visible' }); hold = true; release = null;
    await launch.click(); await page.waitForTimeout(100); await page.mouse.click(195, 400);
    assert.equal(await dialog.evaluate(el => el.open), false); hold = false; release();
    await page.waitForTimeout(200); assert.equal(await dialog.evaluate(el => el.open), false);
    // Failed first load remains black and Retry works without waiting for background polling.
    await page.reload(); await launch.waitFor({ state: 'visible' }); failNext = true;
    await launch.click(); await page.locator('.travel-map-status button').waitFor({ state: 'visible' });
    assert.equal(await dialog.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
    await page.locator('.travel-map-status button').click(); await image.waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('button:visible').count(), 0);
    fixture.revokeGM(); await page.evaluate(() => OneRingStore.refresh().catch(() => {}));
    assert.equal(await page.locator('.travel-map-dialog[open]').count(), 0);
    assert.equal(await page.evaluate(() => OneRingStore.getCachedTravelMap()), null);
    assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    const player = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await player.goto(fixture.url + '/#access=' + fixture.secrets.players[0]);
    await player.locator('.travel-map-launch').tap(); await player.locator('.travel-map-image').waitFor({ state: 'visible' });
    assert.equal(await player.locator('.travel-map-image').getAttribute('alt'), 'Mapa Eriadoru');
    const touch = await player.context().newCDPSession(player);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 400 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80, y: 400 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await player.locator('.travel-map-dialog').evaluate(el => el.open), true);
    await player.touchscreen.tap(195, 400); assert.equal(await player.locator('.travel-map-dialog').evaluate(el => el.open), false);
    assert.deepEqual(errors, []);
    console.log('PASS: travel atlas placeholder, roles, cache, dragging, touch, modals, scenery and stale loads');
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
