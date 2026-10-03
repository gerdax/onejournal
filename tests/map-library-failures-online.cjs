/* Upload notices and stale-image checks against isolated browser storage. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
let browser, fixture;
async function png(page, name) {
  const base64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 300;
    c.getContext('2d').fillRect(0, 0, 400, 300);
    return c.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}
async function main() {
  fixture = await startFixture();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
  await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
  await page.locator('[data-tab="map"]').click();
  await page.locator('#map-library-open').click();
  const input = page.locator('#map-library-files');
  let failUpload = true;
  await page.route('**/functions/v1/onejournal', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'mapUpload' && failUpload) { failUpload = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Próba nieudana' }) }); }
    else await route.continue();
  });
  await input.setInputFiles(await png(page, 'failed.png'));
  await page.locator('.map-library-upload-status').getByText(/Próba nieudana/).waitFor();
  assert.match(await page.locator('.map-library-upload-status').first().textContent(), /Próba nieudana/);
  assert.equal(await page.locator('.map-library-upload [data-retry]').count(), 0, 'failure has no retry control');
  await page.evaluate(() => OneRingStore.refresh());
  await page.locator('.map-library-upload').waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await page.locator('#map-library-uploads').textContent(), '', 'failure notice expires');
  let releaseUpload;
  const uploadHeld = new Promise(resolve => { releaseUpload = resolve; });
  await page.route('**/functions/v1/onejournal', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'mapUpload' && body.name === 'newer.png') await uploadHeld;
    await route.continue();
  });
  await input.setInputFiles([await png(page, 'quick.png'), await png(page, 'newer.png')]);
  await page.locator('.map-library-upload-status').getByText('Wysyłanie…').first().waitFor();
  await page.waitForFunction(() => OneRingStore.getState().mapLibrary.some(item => item.name === 'quick.png'));
  await page.locator('.map-library-upload-status').getByText('Dodano do biblioteki').waitFor();
  await page.locator('.map-library-upload').first().waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await page.locator('.map-library-upload').count(), 0, 'notices expire independently for concurrent files');
  assert.equal((await page.evaluate(() => OneRingStore.getState().mapLibrary)).length, 1, 'hidden notice does not cancel second upload');
  releaseUpload();
  await page.waitForFunction(() => OneRingStore.getState().mapLibrary.length === 2);
  await page.locator('.map-library-upload-status').getByText('Dodano do biblioteki').waitFor();
  await page.locator('.map-library-upload').waitFor({ state: 'detached', timeout: 5000 });
  const newestId = await page.evaluate(() => OneRingStore.getState().mapLibrary.find(m => m.name === 'newer.png').id);
  assert.equal(await page.locator('.map-library-card').first().getAttribute('data-id'), newestId, 'latest server timestamp first');
  await page.locator('.map-library-card [data-action=load]').first().focus();
  await page.evaluate(() => OneRingStore.refresh());
  assert.equal(await page.locator('.map-library-card [data-action=load]').first().evaluate(n => n === document.activeElement), true, 'snapshot refresh preserves keyboard focus');
  let releaseAfterClose;
  const afterCloseHeld = new Promise(resolve => { releaseAfterClose = resolve; });
  await page.route('**/functions/v1/onejournal', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'mapUpload' && body.name === 'after-close.png') await afterCloseHeld;
    await route.continue();
  });
  await input.setInputFiles(await png(page, 'after-close.png'));
  await page.locator('.map-library-upload-status').getByText('Wysyłanie…').waitFor();
  await page.locator('#map-library-close').click();
  await page.locator('#map-library-open').click();
  assert.equal(await page.locator('.map-library-upload').count(), 0, 'close clears upload notices');
  const afterCloseResponse = page.waitForResponse(response => {
    const request = response.request();
    return request.url().includes('/functions/v1/onejournal') && request.postDataJSON()?.action === 'mapUpload' && request.postDataJSON()?.name === 'after-close.png';
  });
  releaseAfterClose();
  await afterCloseResponse;
  await page.waitForFunction(() => OneRingStore.getState().mapLibrary.some(item => item.name === 'after-close.png'));
  await page.waitForFunction(() => document.querySelectorAll('.map-library-card').length === 3);
  assert.equal(await page.locator('.map-library-upload').count(), 0, 'late upload does not restore old notice after reopen');
  let failImage = true;
  await page.route('**/functions/v1/onejournal', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'mapGet' && failImage) { failImage = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Obraz chwilowo niedostępny' }) }); }
    else await route.continue();
  });
  await page.locator('.map-library-preview').first().press('Enter');
  await page.locator('#map-error').getByText(/Obraz chwilowo niedostępny/).waitFor();
  await page.evaluate(() => OneRingStore.refresh());
  await page.locator('#map-terrain image').waitFor();
  assert.equal(await page.locator('#map-error').isVisible(), false, 'successful retry clears image error');
  const stale = await page.evaluate(async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const waiting = {};
    let current = { kind: 'image', imageId: 'B', width: 1200, height: 1200 };
    const store = { getState: () => ({ map: current }), getMapImage: id => new Promise(resolve => { waiting[id] = resolve; }) };
    const a = { ...current, imageId: 'A' };
    OneRingMapLibrary.showActiveImage(a, svg, store);
    await Promise.resolve();
    OneRingMapLibrary.showActiveImage(current, svg, store);
    await Promise.resolve();
    waiting.B({ dataUrl: 'data:image/jpeg;base64,BBB' });
    await new Promise(resolve => setTimeout(resolve, 0));
    waiting.A({ dataUrl: 'data:image/jpeg;base64,AAA' });
    await new Promise(resolve => setTimeout(resolve, 0));
    return svg.querySelector('image')?.dataset.imageId;
  });
  assert.equal(stale, 'B', 'stale image response cannot overwrite current map');
  const switched = await browser.newPage();
  let uploadsAfterSwitch = 0;
  await switched.route('**/functions/v1/onejournal', async route => {
    if (route.request().postDataJSON().action === 'mapUpload') uploadsAfterSwitch++;
    await route.continue();
  });
  await switched.goto(fixture.url + '/#access=' + fixture.secrets.gm);
  await switched.waitForFunction(() => window.OneRingStore?.connection === 'online');
  await switched.locator('[data-tab="map"]').click();
  await switched.locator('#map-library-open').click();
  await switched.evaluate(() => {
    const original = window.createImageBitmap;
    window.createImageBitmap = (...args) => new Promise((resolve, reject) => {
      window.releaseMapBitmap = () => original(...args).then(resolve, reject);
    });
  });
  await switched.locator('#map-library-files').setInputFiles(await png(switched, 'role-change.png'));
  await switched.waitForFunction(() => typeof window.releaseMapBitmap === 'function');
  await switched.evaluate(secret => OneRingStore.connect(secret), fixture.secrets.players[0]);
  await switched.waitForFunction(() => OneRingStore.access.role === 'player');
  await switched.evaluate(() => window.releaseMapBitmap());
  await switched.waitForTimeout(100);
  assert.equal(uploadsAfterSwitch, 0, 'role switch during image preparation cancels upload');
  assert.equal(await switched.locator('#map-library-dialog').isVisible(), false, 'role switch closes private library');
  console.log('PASS: expiring upload notices, close/reopen, upload sorting, image retry, stale fetch guard, role-switch cancellation');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await fixture?.close(); });
