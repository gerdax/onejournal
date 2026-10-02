/* Isolated Kompendium browser integration. No live Supabase or personal browser state. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { PDFDocument, rgb } = require('pdf-lib');
const { startFixture } = require('./fixture-server.cjs');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const source = { chunkId: 'chunk-1', documentId: 'book-1', pdfPage: 2, bookPage: 11, section: 'Próba odwagi' };
const usage = { model: 'model-test', month: { questions: 3, inputTokens: 25, cachedInputTokens: 4, outputTokens: 8, costUsd: .015, indexingCostUsd: .004, conversationCostUsd: .011, incompleteRequests: 1 }, allTime: { questions: 12, inputTokens: 120, cachedInputTokens: 24, outputTokens: 40, costUsd: .124, indexingCostUsd: .05, conversationCostUsd: .074, incompleteRequests: 2 } };
let fixture, browser, context, playerContext, mobileContext, page, player, pdfBytes, asks = [], tickets = 0, redeems = 0, mode = 'normal', heldRoute, errors = [];
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const body = answer => frame('status', { message: 'Szukam źródeł…' }) + frame('delta', { text: answer.slice(0, 4) }) + frame('delta', { text: answer }) + frame('done', { answer, sources: [source], insufficient_context: false });
async function handler(route) {
  const request = route.request().postDataJSON(), action = request.action;
  if (action !== 'redeem') {
    const auth = route.request().headers().authorization?.replace(/^Bearer /, '');
    assert(fixture.document.grants.some(grant => grant.uid === auth && grant.role === 'gm' && grant.active), `GM token required for ${action}`);
  }
  if (action === 'usage') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(usage) });
  if (action === 'ask') {
    asks.push(request);
    if (mode === 'held') { heldRoute = route; return; }
    if (mode === 'partial') return route.fulfill({ contentType: 'text/event-stream', body: frame('delta', { text: 'Niedokończone' }) });
    if (mode === 'long') return route.fulfill({ contentType: 'text/event-stream', body: body('ą'.repeat(1500)) });
    return route.fulfill({ contentType: 'text/event-stream', body: body(`Odpowiedź ${asks.length}`) });
  }
  if (action === 'ticket') { assert.equal(request.documentId, 'book-1'); assert.equal(request.pdfPage, 2); tickets++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ticket: 'fixture-ticket' }) }); }
  if (action === 'redeem') { assert.equal(request.ticket, 'fixture-ticket'); assert.equal(route.request().headers().authorization, undefined); redeems++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: fixture.url + '/fixture-book.pdf', pdfPage: 2, title: 'Księga prób' }) }); }
  throw new Error('Unexpected action: ' + action);
}
async function open(ctx, secret) {
  const p = await ctx.newPage(); p.on('pageerror', error => errors.push(error.message));
  await p.goto(fixture.url + '/#access=' + secret);
  await p.locator('main').waitFor({ state: 'visible' });
  return p;
}
async function ask(text) {
  await page.locator('#kompendium-question').fill(text);
  await page.locator('.kompendium-form button[type=submit]').click();
}
(async () => {
  fixture = await startFixture();
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 600]).drawText('FIRST PAGE', { x: 60, y: 450, size: 20, color: rgb(0, 0, 0) });
  pdf.addPage([400, 600]).drawText('SECOND PAGE', { x: 60, y: 450, size: 20, color: rgb(0, 0, 0) });
  pdfBytes = Buffer.from(await pdf.save());
  browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] });
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.route('**/functions/v1/kompendium', handler);
    await context.route('**/fixture-book.pdf', route => route.fulfill({ contentType: 'application/pdf', body: pdfBytes }));
    page = await open(context, fixture.secrets.gm);
    player = await open(playerContext, fixture.secrets.players[0]);
    assert.equal(await page.locator('#notebook-open + #journal-open').count(), 1);
    assert.equal(await page.locator('#kompendium-open').isVisible(), true);
    assert.equal(await player.locator('#kompendium-open').isVisible(), false);
    assert.equal(await player.locator('.kompendium-dialog').count(), 0);
    console.log('PASS: role visibility and notebook adjacency');

    await page.locator('#settings-open').click();
    await page.locator('#kompendium-usage-body table').waitFor();
    const usageText = await page.locator('#kompendium-usage-body').innerText();
    assert.match(usageText, /model-test/); assert.match(usageText, /Niepełne żądania/);
    assert.match(usageText, /0,0150|0\.0150/);
    await page.locator('#settings-close').click();
    await page.locator('#kompendium-open').click();
    await ask('Jak działa próba?');
    await page.locator('.kompendium-answer').last().filter({ hasText: 'Odpowiedź 1' }).waitFor();
    assert.equal(asks[0].history.length, 0);
    assert.equal(await page.locator('.kompendium-sources a').count(), 1);
    assert.equal(await page.locator('.kompendium-sources a').getAttribute('rel'), 'noopener noreferrer');
    await page.locator('.kompendium-dialog .journal-close').click();
    await page.locator('#kompendium-open').click();
    assert.match(await page.locator('.kompendium-answer').last().innerText(), /Odpowiedź 1/);
    await ask('Drugie pytanie');
    await page.locator('.kompendium-answer').last().filter({ hasText: 'Odpowiedź 2' }).waitFor();
    assert.equal(asks[1].history.length, 2);
    console.log('PASS: usage and conversation survives dialog close');

    const popupPromise = context.waitForEvent('page');
    await page.locator('.kompendium-sources a').first().click();
    const reader = await popupPromise; reader.on('pageerror', error => errors.push(error.message));
    await reader.locator('#status').filter({ hasText: 'Strona 2 z 2' }).waitFor({ timeout: 20000 });
    assert.equal(await reader.locator('#page').inputValue(), '2');
    assert.equal(await reader.locator('#title').innerText(), 'Księga prób');
    assert.equal(new URL(reader.url()).hash, '');
    assert.equal(tickets, 1); assert.equal(redeems, 1);
    await reader.locator('#prev').click();
    await reader.locator('#status').filter({ hasText: 'Strona 1 z 2' }).waitFor();
    await reader.locator('#next').click();
    await reader.locator('#status').filter({ hasText: 'Strona 2 z 2' }).waitFor();
    await reader.locator('#zoom').selectOption('1.5');
    await reader.locator('#status').filter({ hasText: 'Strona 2 z 2' }).waitFor();
    assert((await reader.locator('canvas').evaluate(node => node.width)) > 500);
    await reader.locator('main').evaluate(node => { node.scrollTop = 100; });
    assert((await reader.locator('main').evaluate(node => node.scrollTop)) > 0);
    await reader.locator('#zoom').selectOption('2');
    await reader.waitForFunction(() => document.querySelector('canvas').style.width === '800px');
    assert((await reader.locator('main').evaluate(node => node.scrollTop)) > 0, 'zoom retains reading position');
    await reader.locator('#zoom').selectOption('fit');
    await reader.setViewportSize({ width: 1000, height: 900 });
    await reader.waitForFunction(() => document.querySelector('canvas').style.width === '968px');
    assert((await reader.locator('main').evaluate(node => node.scrollTop)) > 0, 'resize retains reading position');
    await reader.locator('main').evaluate(node => { node.scrollTop = 200; });
    await reader.locator('#prev').click();
    await reader.locator('#status').filter({ hasText: 'Strona 1 z 2' }).waitFor();
    assert.equal(await reader.locator('main').evaluate(node => node.scrollTop), 0, 'previous page starts at top');
    await reader.locator('main').evaluate(node => { node.scrollTop = 200; });
    await reader.locator('#page').fill('2');
    await reader.locator('#page').press('Tab');
    await reader.locator('#status').filter({ hasText: 'Strona 2 z 2' }).waitFor();
    assert.equal(await reader.locator('main').evaluate(node => node.scrollTop), 0, 'manual page starts at top');
    await reader.locator('main').evaluate(node => { node.scrollTop = 200; });
    await reader.locator('#prev').click(); await reader.locator('#next').click();
    await reader.locator('#status').filter({ hasText: 'Strona 2 z 2' }).waitFor();
    assert.equal(await reader.locator('#page').inputValue(), '2');
    assert.equal(await reader.locator('main').evaluate(node => node.scrollTop), 0, 'latest rapid navigation resets once');
    await reader.locator('main').evaluate(node => { node.scrollTop = 200; });
    await reader.evaluate(() => {
      document.querySelector('#prev').click();
      const zoom = document.querySelector('#zoom'); zoom.value = '1.5'; zoom.dispatchEvent(new Event('change'));
    });
    await reader.locator('#status').filter({ hasText: 'Strona 1 z 2' }).waitFor();
    assert.equal(await reader.locator('main').evaluate(node => node.scrollTop), 0, 'zoom cannot cancel pending page reset');
    await reader.locator('main').evaluate(node => { node.scrollTop = 100; });
    await reader.locator('#page').fill('1');
    await reader.locator('#page').press('Tab');
    await reader.waitForFunction(() => document.querySelector('#status').textContent === 'Strona 1 z 2');
    assert((await reader.locator('main').evaluate(node => node.scrollTop)) > 0, 'manual selection of current page retains position');
    await reader.close();
    console.log('PASS: ticket handoff and actual second PDF page render');

    mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobileContext.route('**/functions/v1/kompendium', handler);
    const mobile = await open(mobileContext, fixture.secrets.gm);
    await mobile.locator('#kompendium-open').click();
    const mobileSize = await mobile.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, dialog: document.querySelector('.kompendium-dialog').getBoundingClientRect().toJSON() }));
    assert(mobileSize.document <= mobileSize.viewport + 1, `mobile horizontal overflow: ${JSON.stringify(mobileSize)}`);
    assert(mobileSize.dialog.left >= -1 && mobileSize.dialog.right <= mobileSize.viewport + 1);
    await mobileContext.close(); mobileContext = null;
    console.log('PASS: 390px mobile layout stays inside viewport');

    mode = 'partial'; await ask('Pytanie z przerwanym strumieniem');
    await page.locator('.kompendium-error').filter({ hasText: 'przerwana' }).waitFor();
    assert.equal(await page.locator('.kompendium-answer').last().innerText(), '');
    assert.equal(asks[2].history.length, 4);
    mode = 'normal'; await page.locator('.kompendium-form-foot button').filter({ hasText: 'Ponów' }).click();
    await page.locator('.kompendium-answer').last().filter({ hasText: 'Odpowiedź 4' }).waitFor();
    assert.equal(asks[3].question, 'Pytanie z przerwanym strumieniem');
    assert.equal(asks[3].history.length, 4);
    console.log('PASS: interrupted stream requires explicit retry');

    await page.reload(); await page.locator('main').waitFor({ state: 'visible' });
    await page.locator('#kompendium-open').click();
    assert.equal(await page.locator('.kompendium-turn').count(), 0);
    await ask('Po odświeżeniu');
    await page.locator('.kompendium-answer').last().filter({ hasText: 'Odpowiedź 5' }).waitFor();
    assert.equal(asks[4].history.length, 0);
    console.log('PASS: reload clears session conversation');

    for (let i = 0; i < 5; i++) {
      await ask('Kolejne pytanie ' + i);
      await page.locator('.kompendium-form button[type=submit]').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('.kompendium-form button[type=submit]').disabled);
    }
    assert.equal(asks.at(-1).history.length, 6);
    for (const request of asks) {
      assert(request.history.length <= 6);
      assert(request.history.every((entry, i) => entry.role === (i % 2 ? 'assistant' : 'user')));
    }
    mode = 'long'; await ask('Długa odpowiedź');
    await page.waitForFunction(() => !document.querySelector('.kompendium-form button[type=submit]').disabled);
    mode = 'normal'; await ask('Po długiej odpowiedzi');
    await page.waitForFunction(() => !document.querySelector('.kompendium-form button[type=submit]').disabled);
    assert.equal(asks.at(-1).history.length, 6);
    assert(asks.at(-1).history.some(entry => entry.role === 'assistant' && entry.content.length === 1500));
    console.log('PASS: last three history pairs retain a long answer');

    const beforeKeyboard = asks.length;
    await page.locator('#kompendium-question').fill('  ');
    await page.locator('#kompendium-question').press('Enter');
    assert.equal(asks.length, beforeKeyboard, 'blank Enter does not send');
    await page.locator('#kompendium-question').fill('Dwa wiersze');
    await page.locator('#kompendium-question').press('Shift+Enter');
    assert.equal(await page.locator('#kompendium-question').inputValue(), 'Dwa wiersze\n');
    await page.locator('#kompendium-question').evaluate(node => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, repeat: true }));
    });
    assert.equal(asks.length, beforeKeyboard, 'IME and repeat Enter do not send');
    await page.locator('#kompendium-question').press('Enter');
    await page.waitForFunction(() => !document.querySelector('.kompendium-form button[type=submit]').disabled);
    assert.equal(asks.length, beforeKeyboard + 1);
    assert.equal(asks.at(-1).question, 'Dwa wiersze');
    assert.match(await page.locator('.kompendium-key-hint').innerText(), /Shift\+Enter/);
    console.log('PASS: Enter submit, Shift+Enter newline, blank/repeat/IME guards');

    // Deliver real chunks to the transport at separate moments, leaving time to scroll between them.
    await page.evaluate(() => {
      const nativeFetch = window.fetch;
      let controller;
      window.__kompendiumStream = {
        ready: () => !!controller,
        push: (type, payload) => controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)),
        finish: () => { controller.close(); controller = null; },
        restore: () => { window.fetch = nativeFetch; delete window.__kompendiumStream; }
      };
      window.fetch = (input, options) => {
        if (new URL(input, location.href).pathname.endsWith('/functions/v1/kompendium') && JSON.parse(options.body || '{}').action === 'ask') {
          return Promise.resolve(new Response(new ReadableStream({ start(value) { controller = value; } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
        }
        return nativeFetch(input, options);
      };
    });
    await ask('Czy można czytać wcześniejszą odpowiedź?');
    await page.waitForFunction(() => window.__kompendiumStream.ready());
    const streamOne = 'A '.repeat(1000) + 'PIERWSZY';
    const streamTwo = streamOne + ' B '.repeat(500) + 'DRUGI';
    const streamThree = streamTwo + ' C '.repeat(500) + 'TRZECI';
    await page.evaluate(text => window.__kompendiumStream.push('delta', { text }), streamOne);
    await page.waitForFunction(() => [...document.querySelectorAll('.kompendium-answer')].at(-1)?.textContent.endsWith('PIERWSZY'));
    await page.locator('.kompendium-thread').evaluate(node => { node.scrollTop = 0; });
    await page.evaluate(text => window.__kompendiumStream.push('delta', { text }), streamTwo);
    await page.waitForFunction(() => [...document.querySelectorAll('.kompendium-answer')].at(-1)?.textContent.endsWith('DRUGI'));
    assert.equal(await page.locator('.kompendium-thread').evaluate(node => node.scrollTop), 0, 'reading above does not follow a delta');
    await page.locator('.kompendium-thread').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.evaluate(text => window.__kompendiumStream.push('delta', { text }), streamThree);
    await page.waitForFunction(() => [...document.querySelectorAll('.kompendium-answer')].at(-1)?.textContent.endsWith('TRZECI'));
    assert((await page.locator('.kompendium-thread').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)) <= 64, 'returning to bottom resumes follow');
    await page.evaluate(text => { window.__kompendiumStream.push('done', { answer: text, sources: [{ chunkId: 'stream-source', documentId: 'book-1', pdfPage: 2, bookPage: 11, section: 'Próba odwagi' }], insufficient_context: false }); window.__kompendiumStream.finish(); }, streamThree);
    await page.waitForFunction(() => document.querySelector('.kompendium-status').textContent === 'Gotowe');
    assert((await page.locator('.kompendium-thread').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)) <= 64, 'final source follows when already at bottom');
    await ask('Czy finał przesuwa czytanie?');
    await page.waitForFunction(() => window.__kompendiumStream.ready());
    await page.evaluate(text => window.__kompendiumStream.push('delta', { text }), streamTwo);
    await page.waitForFunction(() => [...document.querySelectorAll('.kompendium-answer')].at(-1)?.textContent.endsWith('DRUGI'));
    await page.locator('.kompendium-thread').evaluate(node => { node.scrollTop = 0; });
    await page.evaluate(text => { window.__kompendiumStream.push('done', { answer: text, sources: [{ chunkId: 'stream-source', documentId: 'book-1', pdfPage: 2, bookPage: 11, section: 'Próba odwagi' }], insufficient_context: false }); window.__kompendiumStream.finish(); }, streamTwo);
    await page.waitForFunction(() => document.querySelector('.kompendium-status').textContent === 'Gotowe');
    assert.equal(await page.locator('.kompendium-thread').evaluate(node => node.scrollTop), 0, 'final answer and sources preserve reading position');
    await page.evaluate(() => window.__kompendiumStream.restore());
    console.log('PASS: incremental stream follows only when reader is near bottom');

    mode = 'held'; await ask('Pytanie podczas cofnięcia');
    await page.waitForFunction(() => document.querySelector('.kompendium-form button[type=submit]').disabled);
    fixture.revokeGM();
    await page.evaluate(() => OneRingStore.refresh().catch(() => {}));
    await page.waitForFunction(() => OneRingStore.connection === 'revoked');
    assert.equal(await page.locator('#kompendium-open').isVisible(), false);
    assert.equal(await page.locator('.kompendium-dialog').count(), 0);
    assert.equal(await page.evaluate(() => document.querySelector('#kompendium-question')?.value || ''), '');
    await heldRoute?.fulfill({ contentType: 'text/event-stream', body: body('late') }).catch(() => {});
    console.log('PASS: revoked access cancels and clears conversation');

    assert.deepEqual(errors, []);
    console.log('PASS: no browser errors');
  } finally { await mobileContext?.close(); await playerContext?.close(); await context?.close(); await browser?.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
