/* Authenticated browser integration against an in-memory Supabase fixture.
   NODE_PATH=<runtime node_modules> node tests/online.cjs */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser, fixture;
const errors = [];
async function open(role, secret) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(role + ': ' + error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(fixture.url + '/#access=' + secret, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => window.OneRingStore?.connection === 'online');
  return { page, context };
}
async function state(page) { return page.evaluate(() => window.OneRingStore.getState()); }
async function refresh(page) { await page.evaluate(() => window.OneRingStore.refresh()); }
async function main() {
  fixture = await startFixture();
  browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] });
  const gm = await open('gm', fixture.secrets.gm);
  const one = await open('player 1', fixture.secrets.players[0]);
  const two = await open('player 2', fixture.secrets.players[1]);
  const [heroOne, heroTwo] = fixture.heroes;
  try {
    assert.equal((await state(gm.page)).heroes.length, 2);
    for (const [page, own, other] of [[one.page, heroOne, heroTwo], [two.page, heroTwo, heroOne]]) {
      const visible = await state(page);
      assert.deepEqual(visible.heroes.map(h => h.id), [own.id]);
      assert.equal(visible.battle.length, 0);
      assert.equal(visible.library.length, 0);
      assert.equal(await page.locator('[data-tab="opponents"]').isVisible(), false);
      assert.equal(await page.locator('[data-tab="settings"]').isVisible(), false);
      assert.equal(await page.locator('#hero-editor input[name="name"]').inputValue(), own.name);
      assert.equal(await page.evaluate(() => document.body.textContent.includes('Tajne notatki') || document.body.textContent.includes('Sekret MG')), false);
      assert.equal(await page.evaluate(id => window.OneRingStore.getState().heroes.some(h => h.id === id), other.id), false);
    }
    console.log('PASS: separate GM/player snapshots and private enemy data');

    await gm.page.locator('[data-tab="map"]').click();
    const enemy = gm.page.locator('.enemy-token').first();
    const enemyId = await enemy.getAttribute('data-id');
    await enemy.click();
    await gm.page.waitForFunction(id => window.OneRingStore.selection === id, enemyId);
    for (const { page } of [one, two]) {
      await refresh(page);
      await page.locator('[data-tab="map"]').click();
      await page.waitForFunction(id => window.OneRingStore.selection === id, enemyId);
      assert.equal(await page.locator(`.map-token[data-id="${enemyId}"]`).evaluate(node => node.classList.contains('is-selected')), true);
      assert.equal(await page.locator('#map-panel').textContent().then(text => text.includes('Ork Sekretny')), true);
      assert.equal(await page.locator('#map-panel .map-resource').count(), 0);
      assert.equal(await page.locator('#map-panel .map-enemy-details').count(), 0);
      assert.equal(await page.locator('#map-hero-sheet form').count(), 1);
    }
    const before = fixture.document.state.map.positions[enemyId];
    await one.page.locator(`.map-token[data-id="${enemyId}"]`).click();
    await one.page.locator(`.map-token[data-id="${enemyId}"]`).focus();
    await one.page.keyboard.press('ArrowRight');
    await one.page.keyboard.press('Enter');
    const markerBox = await one.page.locator(`.map-token[data-id="${enemyId}"]`).boundingBox();
    await one.page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
    await one.page.mouse.down();
    await one.page.mouse.move(markerBox.x + markerBox.width / 2 + 60, markerBox.y + markerBox.height / 2 + 40, { steps: 5 });
    await one.page.mouse.up();
    assert.deepEqual(fixture.document.state.map.positions[enemyId], before);
    assert.equal(fixture.document.selection, enemyId);
    console.log('PASS: shared GM selection and read-only player tokens');

    await one.page.locator('[data-tab="heroes"]').click();
    const culture = one.page.locator('#hero-editor input[name="culture"]');
    await culture.fill('Shire updated');
    await culture.blur();
    await one.page.waitForFunction(id => window.OneRingStore.getState().heroes.find(h => h.id === id)?.culture === 'Shire updated', heroOne.id);
    await refresh(gm.page);
    assert.equal((await state(gm.page)).heroes.find(h => h.id === heroOne.id).culture, 'Shire updated');
    console.log('PASS: own hero edit reaches GM');

    await gm.page.locator('[data-tab="settings"]').click();
    await gm.page.locator('#access-links article').first().waitFor();
    assert.equal(await gm.page.locator('#access-links article').count(), 2);
    await gm.page.locator('#access-links article').first().getByRole('button', { name: 'Wygeneruj nowy link' }).click();
    await gm.page.getByText('Zapisano zmianę dostępu.').waitFor();
    const firstLink = await gm.page.locator('#access-links article').first().locator('input').inputValue();
    assert.match(firstLink, /#access=/);
    console.log('PASS: GM settings link rotation');

    await refresh(one.page).catch(() => {});
    await one.page.locator('#access-screen').waitFor({ state: 'visible' });
    assert.equal(await one.page.locator('main').isVisible(), false);
    assert.equal(await one.page.evaluate(() => document.body.textContent.includes('Shire updated')), false);
    console.log('PASS: revocation removes player UI');

    const uid = await two.page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith('onejournal:auth:')))).access_token);
    fixture.setOffline(uid, true);
    await two.page.evaluate(() => window.OneRingStore.markOffline());
    await two.page.locator('[data-tab="heroes"]').click();
    const name = two.page.locator('#hero-editor input[name="name"]');
    await name.fill('Bartek offline'); await name.blur();
    assert.equal(await name.inputValue(), 'Bartek offline');
    assert.equal(fixture.document.state.heroes.find(h => h.id === heroTwo.id).name, 'Bartek');
    fixture.setOffline(uid, false);
    await refresh(two.page);
    await two.page.locator('#hero-editor .hero-retry').click();
    await two.page.waitForFunction(id => window.OneRingStore.getState().heroes.find(h => h.id === id)?.name === 'Bartek offline', heroTwo.id);
    console.log('PASS: offline edit retained and retried after recovery');

    const pending = two.page.locator('#hero-editor input[name="culture"]');
    await pending.fill('Pending conflict');
    await refresh(gm.page);
    await gm.page.evaluate(id => window.OneRingStore.saveHero({ id, culture: 'GM changed' }), heroTwo.id);
    await pending.blur();
    await two.page.locator('#hero-editor .hero-retry').waitFor({ state: 'visible' });
    assert.equal(await pending.inputValue(), 'Pending conflict');
    assert.equal(fixture.document.state.heroes.find(h => h.id === heroTwo.id).culture, 'GM changed');
    await two.page.locator('#hero-editor .hero-retry').click();
    await two.page.waitForFunction(id => window.OneRingStore.getState().heroes.find(h => h.id === id)?.culture === 'Pending conflict', heroTwo.id);
    console.log('PASS: 409 retains draft and explicit retry writes it');

    const config = { actor: 'hero', baseDice: 1, bonus: 0, featMode: 'normal', target: 10, hope: false, inspired: false, enemyResource: false, miserable: false, exhausted: false };
    const raw = { feat: [12], success: [1] };
    const heroRoll = { id: 'fixture-roll-0001', heroId: heroTwo.id, config, raw };
    await two.page.evaluate(entry => window.OneRingStore.publishRoll(entry), heroRoll);
    await refresh(gm.page);
    assert.equal(await gm.page.evaluate(() => window.OneRingStore.rolls.length), 1);
    await two.page.evaluate(entry => window.OneRingStore.publishRoll(entry), heroRoll);
    assert.equal(fixture.document.rolls.length, 1);
    await gm.page.evaluate(entry => window.OneRingStore.publishRoll(entry), { ...heroRoll, id: 'fixture-roll-0002', heroId: null, config: { ...config, actor: 'enemy' } });
    await refresh(two.page);
    assert.equal(await gm.page.evaluate(() => window.OneRingStore.rolls.length), 2);
    assert.equal(await two.page.evaluate(() => window.OneRingStore.rolls.length), 1);
    const renewed = await open('player 1 renewed', new URL(firstLink).hash.slice('#access='.length));
    try {
      assert.equal(await renewed.page.evaluate(() => window.OneRingStore.rolls.length), 1);
      await renewed.page.locator('#journal-open').click();
      assert.equal(await renewed.page.locator('.journal-dialog .journal-entry').count(), 1);
      assert.equal(await renewed.page.locator('.journal-dialog').textContent().then(text => text.includes('Przeciwnik')), false);
      await gm.page.locator('#journal-open').click();
      assert.equal(await gm.page.locator('.journal-dialog .journal-entry').count(), 2);
    } finally { await renewed.context.close(); }
    console.log('PASS: public hero rolls, private enemy rolls, duplicate suppression');
    await gm.page.evaluate(() => window.OneRingStore.clearEncounter());
    await refresh(two.page);
    await two.page.locator('[data-tab="map"]').click();
    assert.equal((await state(two.page)).map, null);
    assert.equal(await two.page.locator('#map-hero-sheet form').count(), 1);
    assert.equal(await two.page.locator('#map-hero-sheet input[name="name"]').inputValue(), 'Bartek offline');
    console.log('PASS: player sheet remains on map view without encounter');
    assert.deepEqual(errors, []);
  } finally { await gm.context.close(); await one.context.close(); await two.context.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await fixture?.close(); });
