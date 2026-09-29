/* Isolated avatar browser checks against the in-memory Supabase fixture.
   NODE_PATH=<runtime node_modules> node tests/avatar-online.cjs */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser, fixture;
async function open(secret) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(fixture.url + '/#access=' + secret, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
  return { page, context };
}
async function imageFile(page, width, height, name, color = '#ac532d', mimeType = 'image/png') {
  const base64 = await page.evaluate(({ width, height, color, mimeType }) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, width, height);
    return canvas.toDataURL(mimeType).split(',')[1];
  }, { width, height, color, mimeType });
  return { name, mimeType, buffer: Buffer.from(base64, 'base64') };
}
async function avatarId(page, heroId) {
  return page.evaluate(id => window.OneRingStore.getState().heroes.find(hero => hero.id === id)?.avatarId || null, heroId);
}
async function square(page) {
  return page.locator('#hero-editor .sheet-avatar').evaluate(node => {
    const box = node.getBoundingClientRect(); return [box.width, box.height];
  });
}
async function main() {
  fixture = await startFixture();
  browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] });
  const gm = await open(fixture.secrets.gm), player = await open(fixture.secrets.players[0]);
  const [first, second] = fixture.heroes;
  try {
    const errors = [];
    for (const page of [gm.page, player.page]) page.on('pageerror', error => errors.push(error.message));
    await player.page.locator('[data-tab="heroes"]').click();
    assert.deepEqual(await square(player.page), [64, 64]);
    await player.page.setViewportSize({ width: 390, height: 844 });
    assert.deepEqual(await square(player.page), [64, 64]);
    const input = player.page.locator('#hero-editor .sheet-avatar-slot input[type=file]');
    const chooserPromise = player.page.waitForEvent('filechooser');
    await player.page.locator('#hero-editor .sheet-avatar').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(await imageFile(player.page, 80, 80, 'square.png'));
    await player.page.waitForFunction(id => !!OneRingStore.getState().heroes.find(h => h.id === id)?.avatarId, first.id);
    const original = await avatarId(player.page, first.id);
    assert.match(original, /^[a-f0-9]{64}$/);
    await player.page.locator('#hero-editor .sheet-avatar img').waitFor();
    await player.page.screenshot({ path: '/tmp/onejournal-avatar-mobile.png' });
    await gm.page.setViewportSize({ width: 1280, height: 900 });
    await input.setInputFiles(await imageFile(player.page, 80, 60, 'rectangle.png'));
    await player.page.getByText('Awatar musi być kwadratowy.', { exact: false }).waitFor();
    assert.equal(await avatarId(player.page, first.id), original);
    assert.equal(await player.page.locator('#hero-editor .sheet-avatar img').count(), 1);
    await input.setInputFiles(await imageFile(player.page, 96, 96, 'replacement.webp', '#216e8b', 'image/webp'));
    await player.page.waitForFunction(({ id, old }) => {
      const current = OneRingStore.getState().heroes.find(h => h.id === id)?.avatarId;
      return !!current && current !== old;
    }, { id: first.id, old: original });
    const replacement = await avatarId(player.page, first.id);
    assert.notEqual(replacement, original);
    const currentImage = await player.page.locator('#hero-editor .sheet-avatar img').getAttribute('src');
    assert.match(currentImage, /^data:image\/jpeg;base64,/);
    await player.page.route('**/functions/v1/onejournal', async route => {
      if (route.request().postDataJSON()?.action === 'avatarSet') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture upload failure' }) });
      else await route.continue();
    });
    await input.setInputFiles(await imageFile(player.page, 64, 64, 'failed.jpg', '#ddbb00', 'image/jpeg'));
    await player.page.waitForFunction(() => OneRingStore.connection === 'offline');
    assert.equal(await avatarId(player.page, first.id), replacement);
    assert.equal(await player.page.locator('#hero-editor .sheet-avatar img').getAttribute('src'), currentImage);
    await player.page.unroute('**/functions/v1/onejournal');
    await player.page.evaluate(() => OneRingStore.refresh());

    let reads = 0;
    gm.page.on('request', request => {
      if (request.url().endsWith('/functions/v1/onejournal') && request.postDataJSON()?.action === 'avatarGet') reads++;
    });
    await gm.page.evaluate(() => OneRingStore.refresh());
    await gm.page.locator('#hero-editor .sheet-avatar img').waitFor();
    await gm.page.screenshot({ path: '/tmp/onejournal-avatar-desktop.png' });
    const initialReads = reads;
    await gm.page.evaluate(async () => { await OneRingStore.refresh(); await OneRingStore.refresh(); });
    assert.equal(reads, initialReads);

    await player.page.getByRole('button', { name: 'Ustawienia', exact: true }).click();
    await player.page.locator('.connection-settings button').filter({ hasText: 'Usuń awatar' }).click();
    await player.page.waitForFunction(id => !OneRingStore.getState().heroes.find(h => h.id === id)?.avatarId, first.id);
    assert.equal(await player.page.locator('.connection-settings button').filter({ hasText: 'Usuń awatar' }).isVisible(), false);
    await gm.page.evaluate(() => OneRingStore.refresh());
    assert.equal(await gm.page.locator('#hero-editor .sheet-avatar img').count(), 0);

    await gm.page.locator('[data-tab="heroes"]').click();
    await gm.page.locator('#hero-list [data-id="' + second.id + '"]').click();
    await gm.page.locator('#hero-editor .sheet-avatar-slot input[type=file]').setInputFiles(await imageFile(gm.page, 90, 90, 'second.png'));
    await gm.page.waitForFunction(id => !!OneRingStore.getState().heroes.find(h => h.id === id)?.avatarId, second.id);
    await gm.page.getByRole('button', { name: 'Ustawienia', exact: true }).click();
    await gm.page.screenshot({ path: '/tmp/onejournal-avatar-settings.png' });
    await gm.page.locator('[data-avatar-remove="' + second.id + '"]').click();
    await gm.page.waitForFunction(id => !OneRingStore.getState().heroes.find(h => h.id === id)?.avatarId, second.id);
    assert.equal(await gm.page.locator('[data-avatar-remove="' + second.id + '"]').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: square upload, rectangle rejection, cache, mobile size and settings removal');
  } finally {
    await gm.context.close(); await player.context.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await fixture?.close(); });
