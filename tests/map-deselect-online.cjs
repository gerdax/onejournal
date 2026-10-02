/* GM map deselection against isolated online storage. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await page.waitForFunction(() => OneRingStore?.connection === 'online');
    await page.locator('[data-tab="map"]').click();
    const ids = await page.evaluate(() => OneRingStore.getParticipants().map(person => person.id));
    const marker = id => page.locator(`.map-token[data-id="${id}"]`);
    const selected = () => page.evaluate(() => OneRingStore.selection);
    const waitSelection = id => page.waitForFunction(id => OneRingStore.selection === id, id);
    const center = page.locator('#map-center');

    await marker(ids[0]).click();
    await waitSelection(ids[0]);
    assert.equal(await center.isDisabled(), false);
    assert.equal(await page.locator('.map-token.is-selected').count(), 1);
    const firstBox = await marker(ids[0]).boundingBox();
    const firstPoint = { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height / 2 };
    await page.mouse.move(firstPoint.x, firstPoint.y);
    await page.mouse.down();
    await page.mouse.move(firstPoint.x + 2, firstPoint.y + 2);
    await page.mouse.up();
    assert.equal(await center.isDisabled(), true, 'pending deselection disables centering immediately');
    await waitSelection(null);
    assert.equal(await center.isDisabled(), true);
    assert.equal(await page.locator('.map-token.is-selected').count(), 0);
    assert.equal(await page.locator('#map-panel .map-panel-help').count(), 1);
    assert.equal(await page.evaluate(() => OneRingMap.getSelectedParticipant()), null);

    await marker(ids[1]).focus();
    await page.keyboard.press('Enter');
    await waitSelection(ids[1]);
    await marker(ids[1]).focus();
    await page.keyboard.press('Space');
    await waitSelection(null);
    await marker(ids[0]).click();
    await waitSelection(ids[0]);
    const deselect = page.getByRole('button', { name: 'Odznacz postać' });
    assert.equal(await deselect.getAttribute('title'), 'Odznacz postać');
    assert.deepEqual(await page.locator('.map-panel-navigation button').evaluateAll(nodes => nodes.map(n => n.className)), ['map-deselect', 'map-cycle-prev', 'map-cycle-next']);
    assert.equal(await deselect.evaluate(node => { const next = node.nextElementSibling; const a = node.getBoundingClientRect(), b = next.getBoundingClientRect(); return a.width === a.height && a.width === b.width && getComputedStyle(node).borderRadius === getComputedStyle(next).borderRadius; }), true);
    await deselect.click();
    await waitSelection(null);

    await marker(ids[0]).click();
    await waitSelection(ids[0]);
    const box = await marker(ids[0]).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 + 14, { steps: 3 });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
    await page.mouse.up();
    assert.equal(await selected(), ids[0], 'dragging out and back preserves selection');

    // A pending null is a real operation. Newer choices stay visible during earlier writes.
    await page.evaluate(() => {
      const original = OneRingStore.selectToken.bind(OneRingStore);
      OneRingStore.selectToken = id => new Promise(resolve => setTimeout(resolve, 80)).then(() => original(id));
    });
    await page.evaluate(([first, second]) => {
      OneRingMap.selectParticipant(null);
      OneRingMap.selectParticipant(second);
      OneRingMap.selectParticipant(null);
      OneRingMap.selectParticipant(first);
    }, [ids[0], ids[1]]);
    assert.equal(await page.locator('.map-token.is-selected').getAttribute('data-id'), ids[0]);
    await waitSelection(ids[0]);
    await page.waitForTimeout(120);
    assert.equal(await selected(), ids[0]);
    await page.evaluate(() => {
      OneRingStore.selectToken = () => Promise.reject(new Error('Odmowa testowa'));
      OneRingMap.selectParticipant(null);
    });
    await page.waitForFunction(() => document.querySelector('#map-error').textContent === 'Odmowa testowa');
    assert.equal(await selected(), ids[0], 'failed write preserves server selection');
    assert.equal(await page.locator('.map-token.is-selected').getAttribute('data-id'), ids[0], 'failed write restores visual selection');

    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', error => errors.push(error.message));
    await touchPage.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await touchPage.waitForFunction(() => OneRingStore?.connection === 'online');
    await touchPage.locator('[data-tab="map"]').tap();
    await touchPage.locator('#map-viewport').scrollIntoViewIfNeeded();
    await touchPage.locator(`.map-token[data-id="${ids[0]}"]`).tap();
    await touchPage.waitForFunction(id => OneRingStore.selection === null, ids[0]);
    await touchPage.locator(`.map-token[data-id="${ids[0]}"]`).tap();
    await touchPage.waitForFunction(id => OneRingStore.selection === id, ids[0]);
    const mobile = touchPage.locator(`.map-token[data-id="${ids[0]}"]`);
    const mobileBox = await mobile.boundingBox();
    const point = { x: mobileBox.x + mobileBox.width / 2, y: mobileBox.y + mobileBox.height / 2, id: 1 };
    const cdp = await touchContext.newCDPSession(touchPage);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.equal(await touchPage.evaluate(() => OneRingStore.selection), ids[0], 'pointercancel preserves selection');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 2 }, { x: point.x + 80, y: point.y, id: 3 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await touchPage.evaluate(() => OneRingStore.selection), ids[0], 'multitouch preserves selection');

    const player = await browser.newPage();
    await player.goto(fixture.url + '/#access=' + fixture.secrets.players[0]);
    await player.waitForFunction(() => OneRingStore?.connection === 'online');
    await player.locator('[data-tab="map"]').click();
    assert.equal(await player.locator('.map-deselect').count(), 0, 'player cannot deselect');
    assert.deepEqual(errors, []);
    console.log('Map deselection passed: pointer, keyboard, button, drag, races, failure, touch and player view.');
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
