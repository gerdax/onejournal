/* Desktop map navigation against isolated online storage. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await page.waitForFunction(() => OneRingStore?.connection === 'online');
    await page.locator('[data-tab="map"]').click();
    const viewport = page.locator('#map-viewport');
    const button = page.locator('#map-fullscreen');
    const view = () => page.locator('#map-stage').evaluate(node => {
      const matrix = new DOMMatrix(node.style.transform);
      return { x: matrix.e, y: matrix.f, zoom: matrix.a };
    });
    const backgroundPoint = () => viewport.evaluate(node => {
      const box = node.getBoundingClientRect();
      const stage = document.querySelector('#map-stage'), svg = document.querySelector('#map-terrain');
      for (let y = box.top + 80; y < box.bottom - 50; y += 25) for (let x = box.left + 80; x < box.right - 50; x += 25) {
        const hit = document.elementFromPoint(x, y);
        if (hit === node || hit === stage || hit === svg || svg.contains(hit)) return { x, y };
      }
      throw new Error('No visible map background');
    });
    await viewport.scrollIntoViewIfNeeded();
    const point = await backgroundPoint();
    const embedded = await view();
    const beforeScroll = await page.evaluate(() => window.scrollY);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -360);
    await page.waitForFunction(before => window.scrollY < before, beforeScroll);
    assert.deepEqual(await view(), embedded, 'embedded desktop wheel scrolls without zooming');

    const scrollPoint = await backgroundPoint();
    await page.mouse.dblclick(scrollPoint.x, scrollPoint.y, { delay: 60 });
    assert.equal(await button.getAttribute('aria-pressed'), 'true', 'background double click expands');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const fullPoint = await backgroundPoint();
    const fullBefore = await view();
    await page.mouse.move(fullPoint.x, fullPoint.y);
    await page.mouse.wheel(0, -100);
    assert.ok((await view()).zoom > fullBefore.zoom, 'fullscreen wheel zooms');
    await page.mouse.dblclick(fullPoint.x, fullPoint.y, { delay: 60 });
    assert.equal(await button.getAttribute('aria-pressed'), 'false', 'background double click restores embedded view');

    const token = page.locator('.map-token').first();
    await token.scrollIntoViewIfNeeded();
    const tokenBox = await token.boundingBox();
    await page.mouse.dblclick(tokenBox.x + tokenBox.width / 2, tokenBox.y + tokenBox.height / 2, { delay: 60 });
    assert.equal(await button.getAttribute('aria-pressed'), 'false', 'token double click is excluded after pointer capture');
    await page.locator('#map-fit').dblclick({ delay: 60 });
    assert.equal(await button.getAttribute('aria-pressed'), 'false', 'zoom control double click is excluded');

    const panPoint = await backgroundPoint();
    const panBefore = await view();
    await page.mouse.move(panPoint.x, panPoint.y);
    await page.mouse.down();
    await page.mouse.move(panPoint.x + 35, panPoint.y + 20, { steps: 3 });
    await page.mouse.up();
    const panned = await view();
    assert.ok(Math.abs(panned.x - panBefore.x - 35) < 1 && Math.abs(panned.y - panBefore.y - 20) < 1, 'desktop drag still pans');
    await page.mouse.click(panPoint.x + 35, panPoint.y + 20);
    assert.equal(await button.getAttribute('aria-pressed'), 'false', 'drag plus a click cannot expand through pointer capture');
    const freshPoint = await backgroundPoint();
    await page.mouse.dblclick(freshPoint.x, freshPoint.y, { delay: 60 });
    assert.equal(await button.getAttribute('aria-pressed'), 'true', 'a fresh double click works after a drag');
    await page.keyboard.press('Escape');
    assert.equal(await button.getAttribute('aria-pressed'), 'false', 'Escape exits');
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true', 'button enters');
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'false', 'button exits');

    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', error => errors.push(error.message));
    await touchPage.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await touchPage.waitForFunction(() => OneRingStore?.connection === 'online');
    await touchPage.locator('[data-tab="map"]').tap();
    await touchPage.locator('#map-viewport').scrollIntoViewIfNeeded();
    const mobileButton = touchPage.locator('#map-fullscreen');
    const mobileView = () => touchPage.locator('#map-stage').evaluate(node => {
      const matrix = new DOMMatrix(node.style.transform);
      return { x: matrix.e, y: matrix.f, zoom: matrix.a };
    });
    const mobileBox = await touchPage.locator('#map-viewport').boundingBox();
    const cdp = await touchContext.newCDPSession(touchPage);
    const touch = async (type, points) => {
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
      await touchPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const at = (x, y, id) => ({ x: mobileBox.x + x, y: mobileBox.y + y, id });
    await touch('touchStart', [at(80, 130, 1)]);
    await touch('touchEnd', []);
    await touch('touchStart', [at(80, 130, 2)]);
    await touch('touchEnd', []);
    assert.equal(await mobileButton.getAttribute('aria-pressed'), 'false', 'touch double tap does not expand');
    const mobileBefore = await mobileView();
    await touch('touchStart', [at(80, 130, 3)]);
    await touch('touchStart', [at(80, 130, 3), at(220, 130, 4)]);
    await touch('touchMove', [at(100, 150, 3), at(240, 150, 4)]);
    const moved = await mobileView();
    assert.ok(Math.abs(moved.x - mobileBefore.x - 20) < 1 && Math.abs(moved.y - mobileBefore.y - 20) < 1, 'touch pan remains active');
    await touch('touchMove', [at(60, 150, 3), at(280, 150, 4)]);
    assert.ok((await mobileView()).zoom > moved.zoom, 'touch pinch remains active');
    await touch('touchEnd', []);
    assert.equal(await mobileButton.getAttribute('aria-pressed'), 'false');
    await touchContext.close();

    const hybridContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    const hybridPage = await hybridContext.newPage();
    hybridPage.on('pageerror', error => errors.push(error.message));
    await hybridPage.goto(fixture.url + '/#access=' + fixture.secrets.gm);
    await hybridPage.waitForFunction(() => OneRingStore?.connection === 'online');
    await hybridPage.locator('[data-tab="map"]').click();
    const hybridStage = hybridPage.locator('#map-stage');
    const hybridZoom = () => hybridStage.evaluate(node => new DOMMatrix(node.style.transform).a);
    const hybridBefore = await hybridZoom();
    await hybridPage.locator('#map-viewport').dispatchEvent('wheel', { deltaY: -100, deltaMode: 0, clientX: 300, clientY: 300 });
    assert.ok(await hybridZoom() > hybridBefore, 'touch laptop retains embedded wheel zoom');
    const hybridPoint = await hybridPage.locator('#map-viewport').evaluate(node => {
      const box = node.getBoundingClientRect();
      const stage = document.querySelector('#map-stage'), svg = document.querySelector('#map-terrain');
      for (let y = box.top + 80; y < box.bottom - 50; y += 25) for (let x = box.left + 80; x < box.right - 50; x += 25) {
        const hit = document.elementFromPoint(x, y);
        if (hit === node || hit === stage || hit === svg || svg.contains(hit)) return { x, y };
      }
      throw new Error('No visible hybrid map background');
    });
    await hybridPage.mouse.dblclick(hybridPoint.x, hybridPoint.y, { delay: 60 });
    assert.equal(await hybridPage.locator('#map-fullscreen').getAttribute('aria-pressed'), 'false', 'touch laptop has no double click toggle');
    await hybridContext.close();
    assert.deepEqual(errors, []);
    console.log('PASS: desktop embedded scroll, fullscreen wheel and double click, exclusions, pan, button/Escape, touch gestures');
  } finally {
    await browser.close();
    await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
