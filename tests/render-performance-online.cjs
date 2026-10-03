/* View rendering regression against isolated HTTP storage. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function main() {
const fixture = await startFixture({ tokenCount: 12 });
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await context.routeWebSocket('**/*', socket => socket.close());
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  return url.hostname === '127.0.0.1' && url.port === new URL(fixture.url).port ? route.continue() : route.abort();
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(fixture.url + '/#access=' + fixture.secrets.gm);
  await page.waitForFunction(() => OneRingStore?.connection === 'online');
  await page.locator('[data-tab="map"]').click();
  await page.evaluate(() => {
    window.__renderChanges = { heroes: 0, library: 0, journal: 0, mapTokens: 0, mapPanel: 0 };
    for (const [key, selector] of Object.entries({
      heroes: '#hero-list', library: '#library-list', journal: '.journal-dialog .journal-body',
      mapTokens: '#map-tokens', mapPanel: '#map-panel'
    })) {
      new MutationObserver(records => { window.__renderChanges[key] += records.filter(record => record.type === 'childList').length; })
        .observe(document.querySelector(selector), { childList: true, subtree: true });
    }
  });
  const read = () => page.evaluate(() => ({ ...window.__renderChanges }));
  const flush = () => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  const before = await read();
  await page.evaluate(() => OneRingStore.refresh());
  await flush();
  assert.deepEqual(await read(), before, 'unchanged refresh leaves view trees intact');

  const heroId = fixture.heroes[0].id;
  await page.evaluate(id => OneRingStore.moveToken('hero:' + id, 450, 450), heroId);
  await flush();
  const moved = await read();
  for (const key of ['heroes', 'library', 'journal', 'mapPanel'])
    assert.equal(moved[key], before[key], 'token move does not rebuild ' + key);
  assert.equal(await page.locator('.map-token[data-id="hero:' + heroId + '"]').evaluate(node => node.style.left), '450px');

  // A pending optimistic marker must roll back immediately when connectivity is lost.
  await page.evaluate(id => OneRingStore.selectToken('hero:' + id), heroId);
  const heroMarker = page.locator('.map-token[data-id="hero:' + heroId + '"]');
  const authoritativeLeft = await heroMarker.evaluate(node => node.style.left);
  fixture.audit.setResponseDelay(600);
  await heroMarker.focus();
  await heroMarker.press('ArrowRight');
  assert.notEqual(await heroMarker.evaluate(node => node.style.left), authoritativeLeft, 'move is optimistic');
  await page.evaluate(() => OneRingStore.markOffline());
  assert.equal(await heroMarker.evaluate(node => node.style.left), authoritativeLeft, 'offline event restores authoritative marker');
  fixture.audit.setResponseDelay(0);
  await page.evaluate(() => OneRingStore.refresh());

  // Update each hidden view and check that opening it paints the latest state.
  await page.evaluate(id => OneRingStore.saveHero({ id, name: 'Ala odnowiona' }, OneRingStore.heroVersions?.[id] ?? 0), heroId);
  await page.evaluate(() => {
    const source = OneRingStore.getState().battle[0];
    return OneRingStore.addLibrary({ ...source, id: undefined, name: 'Biblioteka odnowiona', source: 'Własne', category: 'Własne' });
  });
  const roll = {
    id: 'render-regression-roll-1', heroId,
    config: { actor: 'hero', baseDice: 1, bonus: 0, featMode: 'normal', target: 10,
      hope: false, inspired: false, enemyResource: false, miserable: false, exhausted: false },
    raw: { feat: [12], success: [1] }
  };
  await page.evaluate(entry => OneRingStore.publishRoll(entry), roll);
  await page.locator('.journal-toast').waitFor();
  assert.equal((await read()).journal, before.journal, 'closed journal defers entry rendering while toast appears');
  await page.locator('#journal-open').click();
  assert.equal(await page.locator('.journal-dialog .journal-entry').count(), 1);
  await page.locator('.journal-dialog .journal-close').click();
  await page.locator('[data-tab="heroes"]').click();
  assert.equal(await page.locator('#hero-list').getByText('Ala odnowiona').count(), 1);
  assert.equal(await page.locator('#hero-editor input[name="name"]').inputValue(), 'Ala odnowiona');
  await page.locator('#hero-editor input[name="age"]').fill('43');
  await page.locator('[data-tab="map"]').click();
  await page.waitForFunction(id => OneRingStore.getState().heroes.find(hero => hero.id === id)?.age === '43', heroId);
  assert.equal(fixture.document.state.heroes.find(hero => hero.id === heroId)?.age, '43', 'hidden hero draft autosaves');
  await page.locator('[data-tab="opponents"]').click();
  await page.locator('#category-filters [data-category="Własne"]').click();
  assert.equal(await page.locator('#library-list').getByText('Biblioteka odnowiona').count(), 1);

  await page.locator('[data-tab="map"]').click();
  await page.evaluate(id => OneRingMap.selectParticipant('hero:' + id), heroId);
  await page.locator('#map-hero-sheet details[data-sheet-section="character"] summary').click();
  await page.locator('#map-hero-sheet input[name="age"]').waitFor();
  const gmUid = fixture.audit.requests.find(record => record.action === 'exchange').uid;
  fixture.setOffline(gmUid, true);
  await page.evaluate(() => OneRingStore.markOffline());
  await page.locator('#map-hero-sheet input[name="age"]').fill('44');
  await page.waitForFunction(() => document.querySelector('#map-hero-sheet .hero-save-status')?.textContent.includes('Brak połączenia'));
  await page.locator('[data-tab="heroes"]').click();
  fixture.setOffline(gmUid, false);
  await page.evaluate(() => OneRingStore.refresh());
  await page.waitForFunction(id => OneRingStore.getState().heroes.find(hero => hero.id === id)?.age === '44', heroId);
  assert.equal(fixture.document.state.heroes.find(hero => hero.id === heroId)?.age, '44', 'hidden embedded sheet retries its offline draft');
  await page.locator('[data-tab="map"]').click();
  const enemyId = await page.evaluate(() => OneRingStore.getParticipants().find(person => person.type === 'enemy').id);
  await page.evaluate(id => OneRingMap.selectParticipant(id), enemyId);
  await page.waitForFunction(() => document.querySelector('#map-enemy-notes textarea')?.value === 'Tajne notatki');
  await page.locator('[data-tab="heroes"]').click();
  fixture.revokeGM();
  await page.evaluate(() => OneRingStore.refresh().catch(() => {}));
  assert.equal(await page.evaluate(() => document.querySelector('#map-enemy-notes textarea')?.value || ''), '', 'hidden enemy notes clear on revocation');
  assert.equal(await page.evaluate(() => document.querySelector('#map-panel')?.textContent || ''), '', 'hidden map panel clears on revocation');
  assert.equal(await page.evaluate(() => document.querySelector('#hero-list')?.textContent || ''), '', 'hero list clears on revocation');
  assert.equal(await page.evaluate(() => document.querySelector('#library-list')?.textContent || ''), '', 'library list clears on revocation');
  assert.equal(await page.evaluate(() => document.querySelector('.journal-dialog .journal-body')?.textContent || ''), '', 'journal clears on revocation');
  assert.deepEqual(errors, [], 'no browser errors');
  console.log('PASS: unchanged refresh, unrelated views, hidden catch-up, draft autosave, and roll toast');
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
