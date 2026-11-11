/* Scenery favorites against the isolated cloud fixture. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

let browser, fixture;
const errors = [];
async function open(viewport = { width: 1280, height: 900 }, hasTouch = false) {
  const context = await browser.newContext({ viewport, hasTouch, isMobile: hasTouch });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
  await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
  await page.locator('[data-tab="map"]').click();
  await page.locator('#map-library-open').click();
  return page;
}
async function png(page, name) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 400;
    canvas.getContext('2d').fillRect(0, 0, 400, 400);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

async function main() {
  fixture = await startFixture();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  const gm = await open();
  const dialog = gm.locator('#map-library-dialog');
  const filter = dialog.locator('#map-library-filter');
  assert.equal(await filter.getAttribute('aria-pressed'), 'false');
  await filter.click();
  assert.equal(await dialog.locator('#map-library-empty').textContent(), 'Brak ulubionych scenerii.');
  assert.equal(await filter.getAttribute('aria-pressed'), 'true');
  await filter.click();
  await dialog.locator('#map-library-files').setInputFiles([await png(gm, 'Las.png'), await png(gm, 'Wzgórza.png')]);
  await gm.waitForFunction(() => OneRingStore.getState().mapLibrary.length === 2);
  await gm.waitForFunction(() => document.querySelectorAll('.map-library-card').length === 2);
  const beforeMap = await gm.evaluate(() => OneRingStore.getState().map);
  const forestId = await gm.getByRole('button', { name: 'Dodaj do ulubionych: Las.png' }).locator('xpath=ancestor::*[contains(@class,"map-library-card")]').getAttribute('data-id');
  const forest = dialog.locator(`.map-library-card[data-id="${forestId}"]`);
  const heart = forest.locator('.map-library-favorite');
  assert.equal(await heart.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(await heart.locator('svg').evaluate(svg => {
    const style = getComputedStyle(svg); return { stroke: style.stroke, fill: style.fill };
  }), { stroke: 'rgb(255, 255, 255)', fill: 'none' }, 'outline heart uses white stroke');

  let releaseFavorite;
  const heldFavorite = new Promise(resolve => { releaseFavorite = resolve; });
  await gm.route('**/functions/v1/onejournal', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'command' && body.method === 'setMapFavorite') await heldFavorite;
    await route.continue();
  });
  await heart.click();
  await forest.getByRole('button', { name: 'Usuń z ulubionych: Las.png' }).waitFor();
  assert.equal(await forest.locator('.map-library-favorite').getAttribute('aria-pressed'), 'true', 'heart changes before server responds');
  assert.equal(await forest.locator('.map-library-favorite svg').evaluate(svg => getComputedStyle(svg).fill), 'rgb(255, 255, 255)', 'filled heart is white');
  assert.equal(await dialog.locator('.map-library-card.is-selected').count(), 0, 'heart does not select a scenery');
  assert.deepEqual(await gm.evaluate(() => OneRingStore.getState().map), beforeMap, 'heart does not load a scenery');
  releaseFavorite();
  await gm.waitForFunction(() => OneRingStore.getState().mapLibrary.some(item => item.name === 'Las.png' && item.favorite));
  await gm.unroute('**/functions/v1/onejournal');

  const second = await open();
  await second.evaluate(() => OneRingStore.refresh());
  await second.getByRole('button', { name: 'Usuń z ulubionych: Las.png' }).waitFor();
  await second.locator('#map-library-filter').click();
  assert.equal(await second.locator('.map-library-card').count(), 1, 'favorite syncs to another GM session');
  const keyboardHeart = gm.getByRole('button', { name: 'Dodaj do ulubionych: Wzgórza.png' });
  await keyboardHeart.focus();
  await keyboardHeart.press('Enter');
  await gm.waitForFunction(() => OneRingStore.getState().mapLibrary.find(item => item.name === 'Wzgórza.png')?.favorite === true);
  await gm.getByRole('button', { name: 'Usuń z ulubionych: Wzgórza.png' }).press('Space');
  await gm.waitForFunction(() => OneRingStore.getState().mapLibrary.find(item => item.name === 'Wzgórza.png')?.favorite === false);
  await gm.getByRole('button', { name: 'Dodaj do ulubionych: Wzgórza.png' }).dblclick();
  assert.equal(await dialog.isVisible(), true, 'double-clicking heart does not close dialog');
  assert.deepEqual(await gm.evaluate(() => OneRingStore.getState().map), beforeMap, 'keyboard and double-click on heart do not load scenery');
  await gm.waitForFunction(() => !document.querySelector('.map-library-favorite[aria-disabled="true"]'));
  if ((await gm.evaluate(() => OneRingStore.getState().mapLibrary.find(item => item.name === 'Wzgórza.png'))).favorite) {
    await gm.getByRole('button', { name: 'Usuń z ulubionych: Wzgórza.png' }).click();
    await gm.waitForFunction(() => OneRingStore.getState().mapLibrary.find(item => item.name === 'Wzgórza.png')?.favorite === false);
  }
  await filter.click();
  assert.equal(await dialog.locator('.map-library-card').count(), 1);
  assert.equal(await dialog.locator('.map-library-card').first().locator('.map-library-favorite').getAttribute('aria-pressed'), 'true');
  await dialog.locator('#map-library-close').click();
  await gm.locator('#map-library-open').click();
  assert.equal(await filter.getAttribute('aria-pressed'), 'false', 'filter resets when dialog reopens');
  assert.equal(await dialog.locator('.map-library-card').count(), 2);

  let failed = false;
  await gm.route('**/functions/v1/onejournal', async route => {
    const body = route.request().postDataJSON();
    if (!failed && body.action === 'command' && body.method === 'setMapFavorite') {
      failed = true;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Ulubione niedostępne' }) });
    }
    await route.continue();
  });
  await gm.getByRole('button', { name: 'Dodaj do ulubionych: Wzgórza.png' }).click();
  await dialog.locator('#map-library-error').getByText('Ulubione niedostępne').waitFor();
  assert.equal(await gm.getByRole('button', { name: 'Dodaj do ulubionych: Wzgórza.png' }).getAttribute('aria-pressed'), 'false', 'failed favorite rolls back');
  assert.equal((await gm.evaluate(() => OneRingStore.getState().mapLibrary.find(item => item.name === 'Wzgórza.png'))).favorite, false);
  await dialog.locator('#map-library-error').waitFor({ state: 'hidden', timeout: 5000 });
  await gm.unroute('**/functions/v1/onejournal');

  const reopened = await open();
  let rejectAfterClose;
  const favoriteHeld = new Promise(resolve => { rejectAfterClose = resolve; });
  await reopened.route('**/functions/v1/onejournal', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'command' && body.method === 'setMapFavorite') {
      await favoriteHeld;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Stary błąd ulubionych' }) });
    }
    await route.continue();
  });
  await reopened.getByRole('button', { name: 'Dodaj do ulubionych: Wzgórza.png' }).click();
  await reopened.getByRole('button', { name: 'Usuń z ulubionych: Wzgórza.png' }).waitFor();
  await reopened.locator('#map-library-close').click();
  await reopened.locator('#map-library-open').click();
  const lateFavoriteResponse = reopened.waitForResponse(response => {
    const request = response.request();
    return request.url().includes('/functions/v1/onejournal') && request.postDataJSON()?.method === 'setMapFavorite';
  });
  rejectAfterClose();
  await lateFavoriteResponse;
  await reopened.getByRole('button', { name: 'Dodaj do ulubionych: Wzgórza.png' }).waitFor();
  assert.equal(await reopened.locator('#map-library-error').isVisible(), false, 'late error does not return after close/reopen');

  await gm.screenshot({ path: '/tmp/onejournal-map-favorites-desktop.png' });
  const mobile = await open({ width: 390, height: 844 }, true);
  await mobile.locator('#map-library-filter').click();
  assert.equal(await mobile.locator('.map-library-card').count(), 1);
  const mobileHeart = mobile.getByRole('button', { name: 'Usuń z ulubionych: Las.png' });
  await mobileHeart.tap();
  await mobile.waitForFunction(() => OneRingStore.getState().mapLibrary.find(item => item.name === 'Las.png')?.favorite === false);
  assert.equal(await mobile.locator('.map-library-card.is-selected').count(), 0, 'touch on heart does not select scenery');
  assert.deepEqual(await mobile.evaluate(() => OneRingStore.getState().map), beforeMap, 'touch on heart does not load scenery');
  assert.equal(await mobile.locator('.map-library-card').count(), 0, 'unfavorited card leaves favorites filter');
  assert.equal(await mobile.locator('#map-library-empty').textContent(), 'Brak ulubionych scenerii.');
  await mobile.locator('#map-library-filter').click();
  assert.equal(await mobile.locator('.map-library-card').count(), 2, 'unfavorited card remains in all sceneries');
  await mobile.screenshot({ path: '/tmp/onejournal-map-favorites-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: favorite heart, optimistic save, cloud sync, filter, rollback, expiry, touch separation');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await fixture?.close(); });
