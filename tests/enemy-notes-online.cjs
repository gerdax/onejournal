'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');
(async () => {
  const f = await startFixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 384, height: 850 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(f.url + '/#access=' + f.secrets.gm);
    await page.waitForFunction(() => window.OneRingMap && OneRingStore.connection === 'online');
    await page.locator('[data-tab="map"]').click();
    const [a, b] = await page.evaluate(async () => {
      const a = OneRingStore.getState().battle[0];
      const b = await OneRingStore.addEnemy({ ...a, notes: '' });
      return [a.id, b.id];
    });
    const select = async id => { await page.evaluate(id => OneRingStore.selectToken(id), id); };
    const input = page.getByLabel('Notatki przeciwnika');
    await select(a); await page.locator('#map-enemy-notes summary').click();
    assert.equal(await input.inputValue(), 'Tajne notatki');
    await input.fill('Szkic A');
    await input.evaluate(n => n.setSelectionRange(3, 3));
    await page.evaluate(() => OneRingStore.refresh());
    assert.equal(await input.inputValue(), 'Szkic A');
    assert.equal(await input.evaluate(n => n.selectionStart), 3);
    await select(b); assert.equal(await input.inputValue(), '');
    await input.fill('Szkic B');
    await page.waitForFunction(([a,b]) => OneRingStore.getState().battle.find(e => e.id === a).notes === 'Szkic A' && OneRingStore.getState().battle.find(e => e.id === b).notes === 'Szkic B', [a,b]);
    await select(a); assert.equal(await input.inputValue(), 'Szkic A');
    // Preserve in-flight edits; a queued write must not steal another token's text.
    await page.route('**/functions/v1/onejournal', async route => {
      const data = route.request().postDataJSON();
      if (data?.method === 'setEnemyNotes') await new Promise(r => setTimeout(r, 300));
      await route.continue();
    });
    await input.fill('Pierwszy'); await page.waitForTimeout(550); await input.fill('Drugi');
    await page.waitForFunction(id => OneRingStore.getState().battle.find(e => e.id === id).notes === 'Drugi', a);
    await page.unroute('**/functions/v1/onejournal');
    // Conflict while the local draft is pending, including explicit retry and discard.
    await input.fill('Lokalny');
    await f.core.handle('fixture-user-1', { action: 'command', method: 'setEnemyNotes', args: [a, 'Zdalny', 'Drugi'] });
    await page.evaluate(() => OneRingStore.refresh());
    assert.equal(await input.inputValue(), 'Lokalny');
    await page.getByRole('button', { name: 'Zapisz szkic zamiast treści serwera' }).click();
    await page.waitForFunction(id => OneRingStore.getState().battle.find(e => e.id === id).notes === 'Lokalny', a);
    await input.fill('Odrzucany');
    await f.core.handle('fixture-user-1', { action: 'command', method: 'setEnemyNotes', args: [a, 'Serwer', 'Lokalny'] });
    await page.evaluate(() => OneRingStore.refresh());
    await page.getByRole('button', { name: 'Przyjmij treść serwera' }).click();
    assert.equal(await input.inputValue(), 'Serwer');
    f.setOffline('fixture-user-1', true);
    await input.fill('Offline');
    await page.waitForFunction(() => OneRingStore.connection === 'offline');
    assert.equal(await input.inputValue(), 'Offline');
    f.setOffline('fixture-user-1', false); await page.evaluate(() => OneRingStore.refresh());
    await page.getByRole('button', { name: 'Ponów zapis szkicu' }).click();
    await page.waitForFunction(id => OneRingStore.getState().battle.find(e => e.id === id).notes === 'Offline', a);
    await input.fill('Usuwany');
    await page.evaluate(id => OneRingStore.removeParticipant(id), a);
    await page.waitForTimeout(650);
    assert.equal(f.document.state.battle.some(e => e.id === a), false);
    await select(b); assert.equal(await input.inputValue(), 'Szkic B');
    const player = await browser.newPage();
    await player.goto(f.url + '/#access=' + f.secrets.players[0]);
    await player.waitForFunction(() => window.OneRingMap);
    await player.locator('[data-tab="map"]').click();
    assert.equal(await player.locator('#map-enemy-notes').isVisible(), false);
    assert.equal(await player.evaluate(() => JSON.stringify(OneRingStore.getState()).includes('Szkic B')), false);
    assert.deepEqual(errors, []);
    console.log('Enemy notes browser checks passed');
  } finally { await browser.close(); await f.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
