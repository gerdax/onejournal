/* Private notebook integration; never connects to the live game. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const doc = text => ({ blocks: [{ type: 'paragraph', runs: [{ text }] }] });
const errors = [];
let fixture, browser;
async function open(secret) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  // Exercise ClipboardItem payloads without replacing the user's system clipboard.
  await page.addInitScript(() => {
    let clipboard = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async write(items) { clipboard = items; }, async read() { return clipboard; },
      async writeText(text) { clipboard = [new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }) })]; }
    } });
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(fixture.url + '/#access=' + secret);
  await page.locator('main').waitFor({ state: 'visible' });
  return { page, context };
}
async function fill(page, text) {
  await page.locator('#notebook-editor').fill(text);
}
async function saved(page, text, timeout = 15000) {
  await page.waitForFunction(value => {
    const note = OneRingStore.notebook;
    return note && JSON.stringify(note.document).includes(value) && document.querySelector('#notebook-status').textContent.includes('Zapisano');
  }, text, { timeout });
}
async function token(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k => k.startsWith('onejournal:auth:')))).access_token);
}
async function selectContents(page) {
  await page.locator('#notebook-editor').evaluate(node => {
    node.focus(); const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
}
(async () => {
  fixture = await startFixture();
  browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] });
  try {
    const gm = await open(fixture.secrets.gm), other = await open(fixture.secrets.gm), player = await open(fixture.secrets.players[0]);
    const page = gm.page, uid = await token(page);
    assert.equal(await player.page.locator('#notebook-open').isVisible(), false);
    assert.equal(await player.page.locator('.notebook-dialog').count(), 0);
    assert.equal(await player.page.evaluate(() => OneRingStore.notebook), null);
    assert.equal(await page.locator('#notebook-open + #journal-open').count(), 1);
    await page.locator('#notebook-open').click();
    assert.equal(await page.locator('#notebook-heading').innerText(), 'Zapiski');
    assert.equal(await page.locator('.notebook-foot #notebook-copy').count(), 1);
    assert.equal(await page.locator('.notebook-foot #notebook-clear').count(), 1);
    assert.equal(await page.locator('#notebook-copy').isDisabled(), true);
    assert.equal(await page.locator('#notebook-clear').isDisabled(), true);
    let box = await page.locator('.notebook-dialog').boundingBox();
    assert(Math.abs(box.width - 1280 * .70) < 2);
    assert(Math.abs(box.height - 900 * .85) < 2);

    await page.locator('[data-command=insertUnorderedList]').click();
    assert.equal(await page.locator('#notebook-copy').isDisabled(), true);
    assert.equal(await page.locator('#notebook-clear').isDisabled(), true);
    await page.locator('[data-command=insertUnorderedList]').click();
    await fill(page, 'Sekret wyprawy');
    await selectContents(page);
    await page.locator('[data-command=bold]').click();
    await saved(page, 'Sekret wyprawy');
    assert.equal(fixture.document.notebook.blocks[0].runs[0].bold, true);
    if (process.env.NOTEBOOK_SCREENSHOT_DIR) await page.screenshot({ path: require('node:path').join(process.env.NOTEBOOK_SCREENSHOT_DIR, 'notebook-desktop.png') });
    await page.locator('#notebook-copy').click();
    await page.waitForFunction(() => document.querySelector('#notebook-status').textContent.includes('Skopiowano'));
    const copied = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      return { text: await (await items[0].getType('text/plain')).text(), html: await (await items[0].getType('text/html')).text() };
    });
    assert.match(copied.text, /Sekret wyprawy/);
    assert.match(copied.html, /<(strong|b)>/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#notebook-open').evaluate(node => node === document.activeElement), true);
    await page.locator('#notebook-open').click();
    assert.match(await page.locator('#notebook-editor').innerText(), /Sekret wyprawy/);
    await player.page.evaluate(() => OneRingStore.refresh());
    assert.equal(await player.page.evaluate(() => JSON.stringify(OneRingStore.getState()).includes('Sekret wyprawy')), false);
    console.log('PASS: private GM notebook, dimensions, formatting, clipboard and focus');

    // Paste formatted content via the real paste handler, including hostile/unsupported nodes.
    await selectContents(page);
    await page.locator('#notebook-editor').evaluate(node => {
      const data = new DataTransfer();
      data.setData('text/html', '<p><b>Wklejone</b> <i>pismo</i> <u>podkreślone</u><script>window.notebookInjected=true</script><img src=x onerror="window.notebookInjected=true"><a href="javascript:alert(1)"> link</a></p><ul><li>Punkt</li></ul>');
      data.setData('text/plain', 'Wklejone pismo podkreślone link\nPunkt');
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await saved(page, 'Wklejone');
    assert.equal(await page.locator('#notebook-editor script, #notebook-editor img, #notebook-editor a').count(), 0);
    assert.equal(await page.evaluate(() => !!window.notebookInjected), false);
    assert(fixture.document.notebook.blocks.some(block => block.type === 'bulletList'));
    await page.locator('#notebook-editor').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await saved(page, 'Sekret wyprawy');
    await selectContents(page);
    await page.keyboard.press('ControlOrMeta+i');
    await page.keyboard.press('ControlOrMeta+u');
    await saved(page, 'Sekret wyprawy');
    const marked = fixture.document.notebook.blocks[0].runs[0];
    assert.equal(marked.italic, true); assert.equal(marked.underline, true);
    await page.locator('[data-command=insertOrderedList]').click();
    await page.waitForFunction(() => OneRingStore.notebook.document.blocks.some(b => b.type === 'orderedList'));
    console.log('PASS: safe rich paste, native undo, keyboard shortcuts and numbered lists');

    // Invalid-sized input keeps the full draft available for editing/copying.
    const prior = await page.evaluate(() => OneRingStore.notebook);
    await fill(page, 'x'.repeat(10001));
    await page.waitForFunction(() => document.querySelector('#notebook-status').textContent.includes('Nie zapisano'));
    assert.deepEqual(await page.evaluate(() => OneRingStore.notebook), prior);
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    }), true);
    await page.getByRole('button', { name: 'Zamknij zapiski', exact: true }).click();
    await page.locator('#notebook-open').click();
    assert.equal((await page.locator('#notebook-editor').innerText()).length, 10001);
    await page.locator('#notebook-copy').click();
    assert.equal(await page.evaluate(async () => ((await (await (await navigator.clipboard.read())[0].getType('text/plain')).text()).match(/x/g) || []).length), 10001);
    await fill(page, 'Poprawiony szkic');
    await saved(page, 'Poprawiony szkic');
    await selectContents(page);
    await page.locator('#notebook-editor').evaluate(node => {
      const data = new DataTransfer();
      data.setData('text/html', '<div><p>Pierwszy</p><p>Drugi<br>Trzeci</p><ul><li>Rodzic<ul><li>Dziecko</li></ul></li></ul></div>');
      node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await saved(page, 'Dziecko');
    await page.locator('#notebook-copy').click();
    const nested = await page.evaluate(async () => (await (await navigator.clipboard.read())[0].getType('text/plain')).text());
    assert.match(nested.replace(/^\d+\. /gm, ''), /Pierwszy\n+Drugi\n+Trzeci/);
    assert.match(nested, /Rodzic\n+Dziecko/);
    console.log('PASS: oversized draft recovery and nested paste preserve content');

    // Delay one save response while the user continues typing.
    let release, arrived;
    const arrivedPromise = new Promise(resolve => { arrived = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let delayed = false;
    const delaySave = async route => {
      const request = route.request().postDataJSON();
      if (request.action === 'notebookSave' && !delayed) {
        delayed = true; const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response });
      } else await route.continue();
    };
    await page.route('**/functions/v1/onejournal', delaySave);
    await fill(page, 'Pierwszy zapis');
    await arrivedPromise;
    await fill(page, 'Nowszy szkic podczas zapisu');
    release();
    await saved(page, 'Nowszy szkic podczas zapisu');
    await page.unroute('**/functions/v1/onejournal', delaySave);
    assert.match(await page.locator('#notebook-editor').innerText(), /Nowszy szkic/);
    console.log('PASS: typing during an in-flight save is retained');

    // Busy gameplay snapshots must not restart the one-second typing debounce.
    await page.evaluate(() => { window.notebookRefreshTimer = setInterval(() => OneRingStore.refresh().catch(() => {}), 150); });
    try {
      await fill(page, 'Zapis podczas aktualizacji gry');
      await saved(page, 'Zapis podczas aktualizacji gry', 3000);
    } finally { await page.evaluate(() => clearInterval(window.notebookRefreshTimer)); }
    console.log('PASS: unrelated snapshots do not postpone autosave');

    // Fail an autosave, close/reopen without losing the draft, then reconnect and retry.
    fixture.setOffline(uid, true);
    await fill(page, 'Szkic bez sieci');
    await page.waitForFunction(() => OneRingStore.connection === 'offline');
    assert.equal(await page.locator('#notebook-editor').getAttribute('contenteditable'), 'false');
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    }), true);
    await page.getByRole('button', { name: 'Zamknij zapiski', exact: true }).click();
    await page.locator('#notebook-open').click();
    assert.match(await page.locator('#notebook-editor').innerText(), /Szkic bez sieci/);
    fixture.setOffline(uid, false);
    await page.evaluate(() => OneRingStore.refresh());
    const retry = page.getByRole('button', { name: /Ponów/ });
    if (await retry.isVisible()) await retry.click();
    await saved(page, 'Szkic bez sieci');
    console.log('PASS: offline draft retained with beforeunload protection and retry');

    // Two independent GM sessions create a genuine optimistic-concurrency conflict.
    await other.page.evaluate(() => OneRingStore.refresh());
    await other.page.locator('#notebook-open').click();
    await fill(page, 'Mój konfliktowy szkic');
    await other.page.evaluate(document => OneRingStore.saveNotebook(document, OneRingStore.notebook.version), doc('Zmiana z drugiej karty'));
    await page.locator('#notebook-replace').waitFor({ state: 'visible' });
    assert.match(await page.locator('#notebook-editor').innerText(), /Mój konfliktowy szkic/);
    await page.locator('#notebook-replace').click();
    await saved(page, 'Mój konfliktowy szkic');
    await fill(page, 'Szkic do odrzucenia');
    await other.page.evaluate(async document => { await OneRingStore.refresh(); await OneRingStore.saveNotebook(document, OneRingStore.notebook.version); }, doc('Wersja serwera'));
    await page.locator('#notebook-reload').waitFor({ state: 'visible' });
    await page.locator('#notebook-reload').click();
    await page.waitForFunction(() => document.querySelector('#notebook-editor').textContent.includes('Wersja serwera'));
    console.log('PASS: two-card conflicts preserve draft and support explicit replace/reload');

    await page.locator('#notebook-clear').click();
    await page.locator('#notebook-clear-confirm').getByRole('button', { name: 'Anuluj', exact: true }).click();
    assert.match(await page.locator('#notebook-editor').innerText(), /Wersja serwera/);
    fixture.setOffline(uid, true);
    await page.locator('#notebook-clear').click();
    await page.locator('#notebook-clear-confirm').getByRole('button', { name: 'Wyczyść', exact: true }).click();
    await page.waitForFunction(() => OneRingStore.connection === 'offline');
    assert.match(await page.locator('#notebook-editor').innerText(), /Wersja serwera/);
    fixture.setOffline(uid, false);
    await page.evaluate(() => OneRingStore.refresh());
    // A failed destructive action is not silently retried on reconnect.
    assert(fixture.document.notebook.blocks.length > 0);
    if (await page.locator('#notebook-clear-confirm').isVisible()) await page.locator('#notebook-clear-confirm').getByRole('button', { name: 'Anuluj', exact: true }).click();
    await page.locator('#notebook-clear').click();
    await page.locator('#notebook-clear-confirm').getByRole('button', { name: 'Wyczyść', exact: true }).click();
    await page.waitForFunction(() => OneRingStore.notebook.document.blocks.length === 0);
    assert.equal(await page.locator('#notebook-copy').isDisabled(), true);
    console.log('PASS: confirmed clear, cancellation and failed clear preserve data');

    await fill(page, 'Zapis po zamknięciu');
    await page.getByRole('button', { name: 'Zamknij zapiski', exact: true }).click();
    await saved(page, 'Zapis po zamknięciu');
    await page.locator('#notebook-open').click();
    // Clipboard errors leave the document intact and report failure.
    await page.evaluate(() => {
      window.originalClipboardWrite = navigator.clipboard.write.bind(navigator.clipboard);
      navigator.clipboard.write = async () => { throw new Error('Fixture clipboard denied'); };
    });
    await page.locator('#notebook-copy').click();
    await page.waitForFunction(() => /Nie .*kop|schow/i.test(document.querySelector('#notebook-status').textContent));
    assert.match(await page.locator('#notebook-editor').innerText(), /Zapis po zamknięciu/);
    await page.evaluate(() => { navigator.clipboard.write = window.originalClipboardWrite; });

    // Long content scrolls within the editor; toolbar and header stay visible on phones.
    await page.evaluate(document => OneRingStore.saveNotebook(document, OneRingStore.notebook.version), { blocks: Array.from({ length: 80 }, (_, i) => ({ type: 'paragraph', runs: [{ text: 'Akapit ' + i }] })) });
    await page.setViewportSize({ width: 390, height: 844 });
    box = await page.locator('.notebook-dialog').boundingBox();
    assert(Math.abs(box.width - 390 * .94) < 2);
    if (process.env.NOTEBOOK_SCREENSHOT_DIR) await page.screenshot({ path: require('node:path').join(process.env.NOTEBOOK_SCREENSHOT_DIR, 'notebook-mobile.png') });
    const before = await page.locator('#notebook-toolbar').boundingBox();
    await page.locator('#notebook-editor').evaluate(node => { node.scrollTop = node.scrollHeight; node.parentElement.scrollTop = node.parentElement.scrollHeight; });
    const after = await page.locator('#notebook-toolbar').boundingBox();
    assert(Math.abs(before.y - after.y) < 1);
    assert(after.x >= box.x && after.x + after.width <= box.x + box.width + 1);
    await page.keyboard.press('Escape');
    const actions = await page.locator('.nav-actions').boundingBox();
    assert(actions.x >= 0 && actions.x + actions.width <= 390);
    await page.locator('#notebook-open').click();
    await page.mouse.click(1, 1);
    assert.equal(await page.locator('.notebook-dialog').isVisible(), false);
    // Revocation removes already rendered private data and unload guards.
    await page.locator('#notebook-open').click();
    await fill(page, 'Prywatny szkic przed cofnięciem dostępu');
    await page.route('**/functions/v1/onejournal', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Dostęp cofnięty' }) }));
    await page.evaluate(() => OneRingStore.refresh().catch(() => {}));
    assert.equal(await page.locator('.notebook-dialog').count(), 0);
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    }), false);
    assert.deepEqual(errors, []);
    console.log('PASS: mobile layout, fixed toolbar, backdrop close, no browser errors');
  } finally {
    await browser.close(); await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
