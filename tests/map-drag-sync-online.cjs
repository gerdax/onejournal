/* Token drag stability and explicit three-client synchronization against isolated storage. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let baselineHits = 0;
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const markerState = (page, id) => page.locator(`.map-token[data-id="${id}"]`).evaluate(node => ({
  node: node.dataset.testIdentity ||= Math.random().toString(36),
  left: Number.parseFloat(node.style.left), top: Number.parseFloat(node.style.top)
}));
const point = async (page, id) => {
  const box = await page.locator(`.map-token[data-id="${id}"] .map-token-symbol`).boundingBox();
  assert.ok(box, `visible token ${id}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const waitRequest = async (fixture, method, after) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const found = fixture.audit.requests.slice(after).find(record => record.method === method);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`No ${method} request after index ${after}`);
};
const waitDone = async record => {
  const deadline = Date.now() + 10000;
  while (!record.completed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(record.completed, 'fixture request completed');
};
const waitHandled = async record => {
  const deadline = Date.now() + 10000;
  while (!record.handled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(record.handled, 'fixture handled request before its response hold');
};
async function isolatedContext(browser, fixture, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', ...options });
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' && url.port === new URL(fixture.url).port ? route.continue() : route.abort();
  });
  // Registered last so Playwright handles this route before the generic loopback guard.
  if (process.env.BASELINE_MAP_PATH) await context.route(/\/map\.js(?:\?.*)?$/, route => {
    baselineHits++;
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(process.env.BASELINE_MAP_PATH) });
  });
  return context;
}

async function runCase(browser, tokenCount, delay, preselected) {
  const fixture = await startFixture({ tokenCount });
  const errors = [];
  const clients = [], contexts = [];
  try {
    for (const secret of [fixture.secrets.gm, ...fixture.secrets.players]) {
      const context = await isolatedContext(browser, fixture); contexts.push(context);
      const page = await context.newPage(); clients.push(page);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${fixture.url}/#access=${secret}`);
      await page.waitForFunction(() => OneRingStore?.connection === 'online');
      await page.locator('[data-tab="map"]').click();
    }
    if (process.env.BASELINE_MAP_PATH) assert.ok(baselineHits >= 3, 'all three clients loaded original map.js');
    const [gm, player1, player2] = clients;
    const id = await gm.evaluate(() => OneRingStore.getParticipants().find(person => person.type === 'hero').id);
    await gm.evaluate(id => OneRingStore.moveToken(id, 450, 450), id);
    for (const page of clients) await page.evaluate(() => OneRingStore.refresh());
    await gm.locator('#map-fit').click();
    await frame(gm);
    if (preselected) await gm.evaluate(id => OneRingStore.selectToken(id), id);
    else await gm.evaluate(() => OneRingStore.selectToken(null));
    const before = await markerState(gm, id);
    const origin = await point(gm, id);
    const moveRequestsBefore = fixture.audit.requests.length;
    fixture.audit.setResponseDelay(delay);
    await gm.mouse.move(origin.x, origin.y);
    await gm.mouse.down();
    const first = { x: origin.x + 24, y: origin.y + 12 };
    await gm.mouse.move(first.x, first.y, { steps: 3 });
    const during = await markerState(gm, id);
    assert.equal(during.node, before.node, 'drag keeps the token DOM node');
    assert.ok(during.left > before.left + 5, 'token moves before a server response');
    await gm.evaluate(() => OneRingStore.refresh());
    const afterSnapshot = await markerState(gm, id);
    assert.deepEqual(afterSnapshot, during, 'snapshot during drag preserves the same node and position');
    await frame(gm);
    const nextFrame = await markerState(gm, id);
    assert.deepEqual(nextFrame, during, 'drag position survives animation frames');
    const last = { x: origin.x + 46, y: origin.y + 23 };
    await gm.mouse.move(last.x, last.y, { steps: 3 });
    const end = await markerState(gm, id);
    assert.ok(end.left >= during.left && end.top >= during.top, 'drag never moves backward');
    await gm.mouse.up();
    const move = await waitRequest(fixture, 'moveToken', moveRequestsBefore);
    if (delay) {
      assert.equal(move.completed, undefined, 'move response is still pending');
      await frame(gm);
      const pending = await markerState(gm, id);
      assert.deepEqual(pending, end, 'released token remains at drop position while pending');
    }
    await waitDone(move);
    await gm.waitForFunction(([id, x]) => OneRingStore.getState().map.positions[id].x === x, [id, fixture.document.state.map.positions[id].x]);
    const persisted = fixture.document.state.map.positions[id];
    assert.ok(Math.abs(persisted.x - end.left) <= 1 && Math.abs(persisted.y - end.top) <= 1, 'saved coordinates match the visible drop point');
    for (const page of clients) {
      await page.evaluate(() => OneRingStore.refresh());
      assert.deepEqual(await page.evaluate(id => OneRingStore.getState().map.positions[id], id), persisted, 'explicit refresh receives persisted coordinates');
    }
    const settled = await markerState(gm, id);
    assert.ok(Math.abs(settled.left - persisted.x) <= 1 && Math.abs(settled.top - persisted.y) <= 1, 'GM marker matches stored coordinates');
    for (const page of [player1, player2]) {
      const visible = await markerState(page, id);
      assert.ok(Math.abs(visible.left - persisted.x) <= 1 && Math.abs(visible.top - persisted.y) <= 1, 'player marker matches stored coordinates');
    }
    assert.deepEqual(errors, [], 'no browser errors or WebSockets');
    return { fixture, gm, id, contexts, clients, errors };
  } catch (error) {
    await Promise.all(contexts.map(context => context.close())); await fixture.close(); throw error;
  }
}

async function extraCases(browser) {
  const fixture = await startFixture({ tokenCount: 10 });
  const context = await isolatedContext(browser, fixture);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${fixture.url}/#access=${fixture.secrets.gm}`);
    await page.waitForFunction(() => OneRingStore?.connection === 'online');
    await page.locator('[data-tab="map"]').click();
    const id = await page.evaluate(() => OneRingStore.getParticipants().find(person => person.type === 'hero').id);
    await page.evaluate(id => OneRingStore.moveToken(id, 450, 450), id);
    await page.locator('#map-fit').click();
    await frame(page);
    await page.evaluate(id => OneRingStore.selectToken(id), id);
    fixture.audit.setResponseDelay(600);
    const initial = await markerState(page, id);
    let cursor = await point(page, id), latest;
    const requestIndex = fixture.audit.requests.length;
    for (let n = 0; n < 3; n++) {
      await page.mouse.move(cursor.x, cursor.y); await page.mouse.down();
      await page.mouse.move(cursor.x + 16, cursor.y + 8, { steps: 2 }); await page.mouse.up();
      const current = await markerState(page, id);
      assert.ok(current.left > initial.left + n * 10, 'successive UI drags advance token while writes are queued');
      latest = current;
      cursor = await point(page, id);
    }
    await page.evaluate(id => {
      window.__dragSamples = [];
      window.__sampleDrag = true;
      const sample = () => {
        if (!window.__sampleDrag) return;
        const node = [...document.querySelectorAll('.map-token')].find(item => item.dataset.id === id);
        window.__dragSamples.push(node ? { x: Number.parseFloat(node.style.left), y: Number.parseFloat(node.style.top) } : null);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, id);
    await waitRequest(fixture, 'moveToken', requestIndex);
    const deadline = Date.now() + 10000;
    while (fixture.audit.requests.slice(requestIndex).filter(record => record.method === 'moveToken').length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const moves = fixture.audit.requests.slice(requestIndex).filter(record => record.method === 'moveToken');
    assert.equal(moves.length, 3, 'all rapid pointer releases issue a move command');
    for (const move of moves) await waitDone(move);
    await page.waitForFunction(([id, x]) => OneRingStore.getState().map.positions[id].x === x, [id, fixture.document.state.map.positions[id].x]);
    await page.evaluate(() => OneRingStore.refresh());
    const saved = fixture.document.state.map.positions[id];
    assert.ok(Math.abs(saved.x - latest.left) <= 1 && Math.abs(saved.y - latest.top) <= 1, 'latest rapid drag wins after all queued responses');
    const samples = await page.evaluate(() => { window.__sampleDrag = false; return window.__dragSamples; });
    assert.ok(samples.length > 5, 'sampled animation frames across pending writes');
    assert.ok(samples.every(sample => sample && Math.abs(sample.x - latest.left) <= 1 && Math.abs(sample.y - latest.top) <= 1), 'older acknowledgements never rewind the visible token');
    fixture.audit.setResponseDelay(0);

    // A cancelled pointer gesture rolls back and sends no move command.
    const cancelBefore = await markerState(page, id);
    const cancelPoint = await point(page, id);
    const beforeCancelRequests = fixture.audit.requests.length;
    await page.mouse.move(cancelPoint.x, cancelPoint.y); await page.mouse.down();
    await page.mouse.move(cancelPoint.x + 25, cancelPoint.y + 12);
    await page.locator('#map-viewport').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', clientX: cancelPoint.x + 25, clientY: cancelPoint.y + 12 });
    await page.mouse.up();
    await frame(page);
    assert.deepEqual(await markerState(page, id), cancelBefore, 'pointercancel restores token');
    assert.equal(fixture.audit.requests.slice(beforeCancelRequests).filter(record => record.method === 'moveToken').length, 0);

    // A failed server command shows an error and restores the authoritative position.
    fixture.audit.failNext('moveToken', 503);
    const failurePoint = await point(page, id);
    const beforeFailure = fixture.audit.requests.length;
    await page.mouse.move(failurePoint.x, failurePoint.y); await page.mouse.down();
    await page.mouse.move(failurePoint.x + 28, failurePoint.y + 14); await page.mouse.up();
    const failed = await waitRequest(fixture, 'moveToken', beforeFailure); await waitDone(failed);
    assert.equal(failed.status, 503);
    await page.waitForFunction(() => !document.querySelector('#map-error').hidden);
    await frame(page);
    assert.deepEqual(fixture.document.state.map.positions[id], saved, 'failed move did not alter storage');
    assert.deepEqual({ x: (await markerState(page, id)).left, y: (await markerState(page, id)).top }, saved, 'failed move rolls back marker before reconnect');
    await page.evaluate(() => OneRingStore.refresh());
    // Keyboard movement remains available after a server error and a successful refresh.
    const keyboardBefore = fixture.audit.requests.length;
    await page.locator(`.map-token[data-id="${id}"]`).focus();
    await page.keyboard.press('ArrowRight');
    const keyMove = await waitRequest(fixture, 'moveToken', keyboardBefore); await waitDone(keyMove);
    assert.equal(fixture.document.state.map.positions[id].x, saved.x + 5, 'keyboard arrow moves the persisted token');
    const maxX = fixture.document.state.map.width - 33;
    await page.evaluate(([id, x]) => OneRingStore.moveToken(id, x, 450), [id, maxX - 1]);
    await page.locator(`.map-token[data-id="${id}"]`).focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(([id, x]) => OneRingStore.getState().map.positions[id].x === x, [id, maxX]);
    assert.equal(fixture.document.state.map.positions[id].x, maxX, 'keyboard move clamps at map boundary');
    await page.evaluate(id => OneRingStore.moveToken(id, 450, 450), id);

    // Touch uses its own browser storage and the same isolated fixture.
    const mobileContext = await isolatedContext(browser, fixture, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mobile = await mobileContext.newPage();
      mobile.on('pageerror', error => errors.push(error.message));
      await mobile.goto(`${fixture.url}/#access=${fixture.secrets.gm}`);
      await mobile.waitForFunction(() => OneRingStore?.connection === 'online');
      await mobile.locator('[data-tab="map"]').tap();
      await mobile.locator('#map-viewport').scrollIntoViewIfNeeded();
      await mobile.locator('#map-fit').tap(); await frame(mobile);
      const touchPoint = await point(mobile, id);
      const cdp = await mobileContext.newCDPSession(mobile);
      const start = { ...touchPoint, id: 7 };
      const moved = { x: touchPoint.x + 22, y: touchPoint.y + 12, id: 7 };
      const touchPositionBefore = fixture.document.state.map.positions[id];
      const touchBefore = fixture.audit.requests.length;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moved] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const touchMove = await waitRequest(fixture, 'moveToken', touchBefore); await waitDone(touchMove);
      assert.equal(touchMove.status, 200, 'touch drag persists successfully');
      const touchPositionAfter = fixture.document.state.map.positions[id];
      assert.ok(touchPositionAfter.x > touchPositionBefore.x && touchPositionAfter.y > touchPositionBefore.y, 'touch drag advances stored coordinates');
      await mobile.waitForFunction(([id, x]) => OneRingStore.getState().map.positions[id].x === x, [id, touchPositionAfter.x]);
      const touchMarker = await markerState(mobile, id);
      assert.ok(Math.abs(touchMarker.left - touchPositionAfter.x) <= 1 && Math.abs(touchMarker.top - touchPositionAfter.y) <= 1, 'touch marker matches persisted position');
    } finally { await mobileContext.close(); }
    assert.deepEqual(errors, []);
  } finally { await context.close(); await fixture.close(); }
}

async function serverChangeDuringPending(browser, change) {
  const fixture = await startFixture({ tokenCount: 10 });
  const context = await isolatedContext(browser, fixture);
  try {
    const page = await context.newPage();
    await page.goto(`${fixture.url}/#access=${fixture.secrets.gm}`);
    await page.waitForFunction(() => OneRingStore?.connection === 'online');
    await page.locator('[data-tab="map"]').click();
    const id = await page.evaluate(() => OneRingStore.getParticipants().find(person => person.type === 'hero').id);
    await page.evaluate(id => OneRingStore.moveToken(id, 450, 450), id);
    await page.locator('#map-fit').click(); await frame(page);
    await page.evaluate(() => {
      const original = OneRingStore.moveToken.bind(OneRingStore);
      OneRingStore.moveToken = (...args) => {
        const request = original(...args);
        window.__moveSettled = request.then(() => ({ ok: true }), error => ({ ok: false, error: error.message }));
        return request;
      };
    });
    fixture.audit.setResponseDelay(1200);
    const origin = await point(page, id), before = fixture.audit.requests.length;
    await page.mouse.move(origin.x, origin.y); await page.mouse.down();
    await page.mouse.move(origin.x + 24, origin.y + 12); await page.mouse.up();
    const pending = await waitRequest(fixture, 'moveToken', before);
    await waitHandled(pending);
    assert.equal(pending.completed, undefined, 'move is awaiting its HTTP response');
    fixture.audit.setResponseDelay(0);
    const uid = fixture.audit.requests.find(record => record.action === 'exchange').uid;
    const priorMap = fixture.document.state.map;
    const method = change === 'remove' ? 'removeParticipant' : 'setMap';
    const args = change === 'remove' ? [id] : [{ ...priorMap, seed: 'pending-map-replacement' }];
    await fixture.core.handle(uid, { action: 'command', method, args });
    await page.evaluate(() => OneRingStore.refresh());
    assert.equal(pending.completed, undefined, 'newer state is visible before the old move response');
    if (change === 'remove') {
      assert.equal(await page.locator(`.map-token[data-id="${id}"]`).count(), 0, 'removed participant disappears during old move response');
    } else {
      assert.equal(await page.evaluate(() => OneRingStore.getState().map.seed), 'pending-map-replacement');
    }
    await waitDone(pending); await frame(page);
    const settled = await page.evaluate(() => window.__moveSettled);
    assert.equal(settled.ok, true, `late move response settles: ${settled.error || ''}`);
    assert.deepEqual(await page.evaluate(() => OneRingStore.getState().map), fixture.document.state.map, 'late move response cannot replace newer map state');
    if (change === 'remove') assert.equal(await page.locator(`.map-token[data-id="${id}"]`).count(), 0, 'old move response cannot resurrect participant');
    else assert.equal(await page.evaluate(() => OneRingStore.getState().map.seed), 'pending-map-replacement');
    await page.evaluate(() => OneRingStore.refresh());
  } finally { await context.close(); await fixture.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });
  try {
    for (const count of [10, 50]) for (const delay of [0, 150, 600]) for (const selected of [false, true]) {
      const result = await runCase(browser, count, delay, selected);
      await Promise.all(result.contexts.map(context => context.close())); await result.fixture.close();
      console.log(`PASS drag: ${count} tokens, ${delay}ms, ${selected ? 'selected' : 'unselected'}`);
      if (process.env.BASELINE_MAP_PATH) return;
    }
    await extraCases(browser);
    console.log('PASS drag: repeated pending writes, cancellation, failed write and recovery');
    for (const change of ['remove', 'replace']) {
      await serverChangeDuringPending(browser, change);
      console.log(`PASS drag: ${change} during pending response`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
