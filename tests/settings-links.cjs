/* Browser check for distinct hero links and clipboard behavior after rotation.
   NODE_PATH=<runtime node_modules> node tests/settings-links.cjs */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const fixture = await startFixture();
  let browser, context;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] });
    context = await browser.newContext();
    await context.addInitScript(() => {
      window.__clipboard = { value: 'stary link', mode: 'normal' };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async value => {
          if (window.__clipboard.mode !== 'normal') throw new Error('Clipboard API unavailable');
          window.__clipboard.value = value;
        }
      } });
      document.execCommand = command => {
        if (command !== 'copy' || window.__clipboard.mode === 'failure') return false;
        window.__clipboard.value = String(window.getSelection() || '') || document.activeElement?.value?.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd) || '';
        return true;
      };
    });
    const page = await context.newPage();
    page.on('dialog', dialog => dialog.accept());
    await page.goto(fixture.url + '/#access=' + fixture.secrets.gm, { waitUntil: 'domcontentloaded' });
    await page.locator('main').waitFor({ state: 'visible' });
    await page.locator('#settings-open').click();
    await page.locator('#access-links article').first().waitFor();
    const rows = page.locator('#access-links article');
    assert.equal(await rows.count(), 2);
    const first = await rows.nth(0).locator('input').inputValue();
    const second = await rows.nth(1).locator('input').inputValue();
    assert.notEqual(first, second, 'Each hero must have a distinct link');
    assert.equal(new URL(first).hash.slice(8), fixture.secrets.players[0]);
    assert.equal(new URL(second).hash.slice(8), fixture.secrets.players[1]);

    await rows.nth(0).getByRole('button', { name: 'Kopiuj link' }).click();
    assert.equal(await page.evaluate(() => window.__clipboard.value), first);
    await rows.nth(1).getByRole('button', { name: 'Kopiuj link' }).click();
    assert.equal(await page.evaluate(() => window.__clipboard.value), second);
    console.log('PASS: each hero copies the link shown in that row');

    await rows.nth(0).getByRole('button', { name: 'Wygeneruj nowy link' }).click();
    await page.waitForFunction(previous => document.querySelector('#access-links article input')?.value !== previous, first);
    const rotated = await rows.nth(0).locator('input').inputValue();
    assert.notEqual(rotated, first);
    assert.notEqual(rotated, second);
    await rows.nth(0).getByRole('button', { name: 'Kopiuj link' }).click();
    assert.equal(await page.evaluate(() => window.__clipboard.value), rotated);
    assert.equal(await rows.nth(1).locator('input').inputValue(), second);
    console.log('PASS: rotation copies the fresh link and preserves the other hero link');

    await page.evaluate(() => { window.__clipboard.mode = 'fallback'; window.__clipboard.value = 'stary link'; });
    await rows.nth(1).getByRole('button', { name: 'Kopiuj link' }).click();
    assert.equal(await page.evaluate(() => window.__clipboard.value), second);
    assert.equal(await page.locator('#settings-status').textContent(), 'Skopiowano link.');
    console.log('PASS: denied Clipboard API uses successful selection-copy fallback');

    await page.evaluate(() => { window.__clipboard.mode = 'failure'; window.__clipboard.value = 'stary link'; });
    await rows.nth(0).getByRole('button', { name: 'Kopiuj link' }).click();
    assert.equal(await page.evaluate(() => window.__clipboard.value), 'stary link');
    assert.match(await page.locator('#settings-status').textContent(), /Nie można skopiować automatycznie/);
    assert.equal(await rows.nth(0).locator('input').evaluate(input => input.selectionEnd - input.selectionStart), rotated.length);
    console.log('PASS: total clipboard failure reports manual-copy state');
  } finally { await context?.close(); await browser?.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
