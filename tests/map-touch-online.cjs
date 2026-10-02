/* Embedded and fullscreen touch gestures against isolated online storage. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await page.waitForFunction(() => OneRingStore?.connection === 'online');
    await page.locator('[data-tab="map"]').tap();
    await page.locator('#map-viewport').scrollIntoViewIfNeeded();
    const cdp = await context.newCDPSession(page);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const touch = async (type, points) => { await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points }); await settle(); };
    const view = () => page.evaluate(() => {
      const matrix = new DOMMatrix(document.querySelector('#map-stage').style.transform);
      return { x: matrix.e, y: matrix.f, zoom: matrix.a, scroll: scrollY };
    });
    const background = () => page.locator('#map-viewport').evaluate(node => {
      const box = node.getBoundingClientRect();
      const stage = document.querySelector('#map-stage'), terrain = document.querySelector('#map-terrain');
      for (let y = box.top + 85; y < box.bottom - 80; y += 25) for (let x = box.left + 70; x < box.right - 60; x += 25) {
        const hit = document.elementFromPoint(x, y);
        if (hit === node || hit === stage || hit === terrain || terrain.contains(hit)) return { x, y };
      }
      throw new Error('No map background in viewport');
    });
    const p = (point, id, dx = 0, dy = 0) => ({ x: point.x + dx, y: point.y + dy, id });
    await settle();
    const bg = await background();
    const beforeScroll = await view();
    await touch('touchStart', [p(bg, 1)]);
    for (const dy of [-25, -50, -75, -100]) await touch('touchMove', [p(bg, 1, 0, dy)]);
    await touch('touchEnd', []);
    const scrolled = await view();
    assert.ok(scrolled.scroll > beforeScroll.scroll + 20, `one-finger background scrolls page: ${JSON.stringify({ beforeScroll, scrolled })}`);
    assert.deepEqual([scrolled.x, scrolled.y, scrolled.zoom], [beforeScroll.x, beforeScroll.y, beforeScroll.zoom]);

    await page.locator('#map-viewport').scrollIntoViewIfNeeded();
    const bg2 = await background();
    const twoBefore = await view();
    await touch('touchStart', [p(bg2, 2)]);
    await touch('touchStart', [p(bg2, 2), p(bg2, 3, 110)]);
    await touch('touchMove', [p(bg2, 2, 20, 15), p(bg2, 3, 130, 15)]);
    const panned = await view();
    assert.ok(Math.abs(panned.x - twoBefore.x - 20) < 2 && Math.abs(panned.y - twoBefore.y - 15) < 2, 'two fingers pan map');
    assert.equal(panned.scroll, twoBefore.scroll, 'two fingers do not scroll page');
    await touch('touchMove', [p(bg2, 2, -20, 15), p(bg2, 3, 170, 15)]);
    const pinched = await view();
    assert.ok(pinched.zoom > panned.zoom * 1.5, 'two fingers pinch map');
    assert.equal(pinched.scroll, twoBefore.scroll, 'pinch does not scroll page');
    await touch('touchEnd', []);

    const heroId = await page.evaluate(() => OneRingStore.getParticipants().find(person => person.type === 'hero').id);
    await page.evaluate(id => OneRingStore.moveToken(id, 450, 450), heroId);
    await page.locator('#map-fit').tap();
    const marker = page.locator(`.map-token[data-id="${heroId}"]`);
    await marker.scrollIntoViewIfNeeded();
    const box = await marker.locator('.map-token-symbol').boundingBox();
    const tokenPoint = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    assert.equal(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('.map-token')?.dataset.id, tokenPoint), heroId);
    await touch('touchStart', [p(tokenPoint, 4)]);
    await touch('touchEnd', []);
    await page.waitForFunction(id => OneRingStore.selection === id, heroId);
    await touch('touchStart', [p(tokenPoint, 5)]);
    await touch('touchEnd', []);
    await page.waitForFunction(() => OneRingStore.selection === null);

    await touch('touchStart', [p(tokenPoint, 6)]);
    await touch('touchMove', [p(tokenPoint, 6, 25, 20)]);
    const dragged = await marker.evaluate(node => ({ left: node.style.left, top: node.style.top }));
    await touch('touchStart', [p(tokenPoint, 6, 25, 20), p(tokenPoint, 7, 100)]);
    const restored = await marker.evaluate(node => ({ left: node.style.left, top: node.style.top }));
    assert.notDeepEqual(dragged, restored, 'second finger cancels pending token drag');
    await touch('touchEnd', [p(tokenPoint, 6, 25, 20)]);
    await touch('touchMove', [p(tokenPoint, 6, 55, 30)]);
    await touch('touchEnd', []);
    assert.deepEqual(await marker.evaluate(node => ({ left: node.style.left, top: node.style.top })), restored, 'remaining finger cannot restart token drag');

    await page.locator('#map-fullscreen').tap();
    assert.equal(await page.locator('#map-fullscreen').getAttribute('aria-pressed'), 'true', 'fullscreen control opens map');
    const fullBefore = await view();
    const fullBg = await background();
    await touch('touchStart', [p(fullBg, 8)]);
    await touch('touchMove', [p(fullBg, 8, 0, -70)]);
    await touch('touchEnd', []);
    assert.equal((await view()).scroll, fullBefore.scroll, 'fullscreen locks page scrolling');
    const fullTwo = await view();
    await touch('touchStart', [p(fullBg, 9)]);
    await touch('touchStart', [p(fullBg, 9), p(fullBg, 10, 100)]);
    await touch('touchMove', [p(fullBg, 9, 15, 10), p(fullBg, 10, 115, 10)]);
    assert.ok(Math.abs((await view()).x - fullTwo.x - 15) < 2, 'fullscreen two-finger pan still works');
    await touch('touchEnd', []);
    await page.locator('#map-fullscreen').tap();

    const playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const player = await playerContext.newPage();
    player.on('pageerror', error => errors.push(error.message));
    await player.goto(fixture.url + '/#access=' + fixture.secrets.players[0]);
    await player.waitForFunction(() => OneRingStore?.connection === 'online');
    await player.locator('[data-tab="map"]').tap();
    const playerToken = player.locator('.map-token.is-player-token').first();
    await playerToken.scrollIntoViewIfNeeded();
    const playerBox = await playerToken.boundingBox();
    const playerPoint = { x: playerBox.x + playerBox.width / 2, y: playerBox.y + playerBox.height / 2 };
    const playerCdp = await playerContext.newCDPSession(player);
    const playerBefore = await player.evaluate(() => scrollY);
    const playerTouch = async (type, points) => { await playerCdp.send('Input.dispatchTouchEvent', { type, touchPoints: points }); await player.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
    await playerTouch('touchStart', [p(playerPoint, 11)]);
    for (const dy of [-25, -50, -75, -100]) await playerTouch('touchMove', [p(playerPoint, 11, 0, dy)]);
    await playerTouch('touchEnd', []);
    assert.ok(await player.evaluate(() => scrollY) > playerBefore + 20, 'player token swipes scroll page');
    assert.deepEqual(errors, []);
    console.log('Map touch passed: embedded scroll, map pan/pinch, token tap/drag/cancel, fullscreen and player scroll.');
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
