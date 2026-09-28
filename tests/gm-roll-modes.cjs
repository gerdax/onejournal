/* UI-driven GM and player roll modes against an isolated in-memory game.
   NODE_PATH=<runtime node_modules> node tests/gm-roll-modes.cjs */
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
  await page.goto(fixture.url + '/#access=' + secret, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => !!window.DiceEngine?.roll && !!window.OneJournalRolls?.prepare);
  await page.evaluate(() => {
    window.DiceEngine.roll = async ({ featCount, successCount }) => ({
      feat: Array(featCount).fill(12), success: Array(successCount).fill(6)
    });
  });
  return { page, context };
}
async function refresh(page) { await page.evaluate(() => window.OneRingStore.refresh()); }
async function roll(page, mode, nextCount) {
  await page.locator('.dice-launch').click();
  if (mode) await page.locator(`.dice-dialog [data-choice="actor"] [data-value="${mode}"]`).click();
  await page.locator('.dice-dialog [data-choice="baseDice"] [data-value="1"]').click();
  await page.locator('.dice-dialog .dice-roll').click();
  await page.waitForFunction(count => window.OneRingStore.rolls.length === count, nextCount);
  await page.locator('.dice-dialog .dice-close').click();
}
async function main() {
  fixture = await startFixture();
  browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] });
  const gm = await open('gm', fixture.secrets.gm);
  const a = await open('player A', fixture.secrets.players[0]);
  const b = await open('player B', fixture.secrets.players[1]);
  try {
    await gm.page.locator('.dice-launch').click();
    assert.deepEqual(await gm.page.locator('.dice-dialog [data-choice="actor"] button').allTextContents(), ['Bohater', 'NPC', 'Przeciwnik']);
    assert.equal(await gm.page.locator('.dice-dialog select').count(), 0, 'GM should not choose a hero for a generic roll');
    await gm.page.locator('.dice-dialog .dice-close').click();
    await a.page.locator('.dice-launch').click();
    assert.equal(await a.page.locator('.dice-dialog [data-choice="actor"]').isVisible(), false, 'Player actor choice must be hidden');
    assert.equal(await a.page.locator('.dice-dialog select').count(), 0, 'Player should not choose a hero');
    await a.page.locator('.dice-dialog .dice-close').click();

    await roll(gm.page, 'hero', 1);
    let entry = fixture.document.rolls.at(-1).entry;
    assert.equal(entry.actor, 'hero');
    assert.equal(entry.heroId, null);
    assert.equal(entry.heroName, null);
    assert.equal(entry.name, 'Bohater');
    assert.equal(fixture.document.rolls.at(-1).visibility, 'public');
    await refresh(a.page); await refresh(b.page);
    for (const { page } of [a, b]) {
      assert.equal(await page.evaluate(() => window.OneRingStore.rolls.length), 1);
      assert.match(await page.locator('.journal-toast').textContent(), /Bohater/);
      await page.locator('.journal-toast').evaluate(node => node.remove());
    }
    console.log('PASS: GM generic hero is public, has no heroId, and reaches both players');

    await gm.page.locator('.dice-launch').click();
    await gm.page.locator('.dice-dialog [data-choice="actor"] [data-value="npc"]').click();
    assert.equal(await gm.page.locator('.dice-dialog .dice-hero-resource').isVisible(), true);
    assert.equal(await gm.page.locator('.dice-dialog .dice-enemy-resource').isVisible(), false);
    await gm.page.locator('.dice-dialog .dice-close').click();
    await roll(gm.page, 'npc', 2);
    entry = fixture.document.rolls.at(-1).entry;
    assert.equal(entry.actor, 'npc');
    assert.equal(entry.heroId, null);
    assert.equal(entry.name, 'NPC');
    assert.equal(fixture.document.rolls.at(-1).visibility, 'private');
    await refresh(a.page); await refresh(b.page);
    for (const { page } of [a, b]) {
      assert.equal(await page.evaluate(() => window.OneRingStore.rolls.length), 1);
      assert.equal(await page.locator('.journal-toast').count(), 0);
    }
    console.log('PASS: NPC uses hero controls and stays private');

    await roll(gm.page, 'enemy', 3);
    entry = fixture.document.rolls.at(-1).entry;
    assert.equal(entry.actor, 'enemy');
    assert.equal(entry.heroId, null);
    assert.equal(entry.name, 'Przeciwnik');
    assert.equal(fixture.document.rolls.at(-1).visibility, 'private');
    await refresh(a.page); await refresh(b.page);
    for (const { page } of [a, b]) {
      assert.equal(await page.evaluate(() => window.OneRingStore.rolls.length), 1);
      assert.equal(await page.locator('.journal-toast').count(), 0);
    }
    console.log('PASS: enemy roll stays private with generic identity');

    await roll(a.page, null, 2);
    entry = fixture.document.rolls.at(-1).entry;
    assert.equal(entry.actor, 'hero');
    assert.equal(entry.heroId, fixture.heroes[0].id);
    assert.equal(entry.heroName, fixture.heroes[0].name);
    await refresh(b.page);
    assert.equal(await b.page.evaluate(() => window.OneRingStore.rolls.length), 2);
    console.log('PASS: player roll is forced to assigned hero name and public');

    for (const hero of fixture.heroes) await gm.page.evaluate(id => window.OneRingStore.deleteHero(id), hero.id);
    await roll(gm.page, 'hero', 5);
    entry = fixture.document.rolls.at(-1).entry;
    assert.equal(entry.actor, 'hero');
    assert.equal(entry.heroId, null);
    assert.equal(entry.name, 'Bohater');
    console.log('PASS: GM generic hero roll works with an empty hero list');
    assert.deepEqual(errors, []);
  } finally { await gm.context.close(); await a.context.close(); await b.context.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await fixture?.close(); });
