/* Responsive primary navigation against an isolated online fixture. */
'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startFixture } = require('./fixture-server.cjs');

(async () => {
  const fixture = await startFixture();
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox'] });
  try {
    const gm = await browser.newPage();
    const player = await browser.newPage();
    const errors = [];
    for (const page of [gm, player]) page.on('pageerror', error => errors.push(error.message));
    await Promise.all([
      gm.goto(fixture.url + '/#access=' + fixture.secrets.gm),
      player.goto(fixture.url + '/#access=' + fixture.secrets.players[0])
    ]);
    await Promise.all([gm.locator('main').waitFor({ state: 'visible' }), player.locator('main').waitFor({ state: 'visible' })]);
    const stable = async page => page.waitForFunction(() => {
      const nav = document.querySelector('.tabs');
      return nav.getClientRects().length && document.fonts.status === 'loaded' &&
        !!document.querySelector('[data-tab="heroes"] .nav-tab-icon');
    });
    await Promise.all([stable(gm), stable(player)]);

    async function checkLayout(page, width, role) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.locator('.tabs').evaluate(nav => {
        const tabs = [...nav.querySelectorAll(':scope > [data-tab]')].filter(node => node.getClientRects().length);
        const actions = [...nav.querySelectorAll('.nav-actions > button')].filter(node => node.getClientRects().length);
        const nodes = [...tabs, ...actions];
        const boxes = nodes.map(node => ({ label: node.getAttribute('aria-label'), x: node.getBoundingClientRect().left,
          y: node.getBoundingClientRect().top, right: node.getBoundingClientRect().right,
          bottom: node.getBoundingClientRect().bottom, width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height }));
        return { icon: nav.classList.contains('nav-icon-label'), countHidden: nav.classList.contains('nav-hide-count'),
          navRight: nav.getBoundingClientRect().right, boxes,
          iconVisible: tabs.map(node => getComputedStyle(node.querySelector('.nav-tab-icon')).display !== 'none'),
          labelVisible: tabs.map(node => getComputedStyle(node.querySelector('.nav-label-long')).display !== 'none'),
          actions: actions.map(node => node.getAttribute('aria-label')) };
      });
      assert.deepEqual(layout.actions, role === 'gm' ? ['Zapiski', 'Dziennik rzutów', 'Ustawienia'] : ['Dziennik rzutów', 'Ustawienia']);
      assert.equal(layout.iconVisible.every(Boolean), layout.icon, `${role} ${width}: icon visibility`);
      assert.equal(layout.labelVisible.every(Boolean), !layout.icon, `${role} ${width}: full label visibility`);
      if (layout.icon) {
        assert.equal(layout.countHidden, true, `${role} ${width}: hide count before icons`);
        assert.equal(layout.boxes.every(box => box.width >= 44 && box.height >= 44), true, `${role} ${width}: touch targets`);
      }
      for (let i = 0; i < layout.boxes.length; i++) {
        const a = layout.boxes[i];
        assert.equal(a.right <= layout.navRight + 0.5, true, `${role} ${width}: ${a.label} within nav`);
        for (let j = i + 1; j < layout.boxes.length; j++) {
          const b = layout.boxes[j];
          assert.equal(a.right <= b.x + 0.5 || b.right <= a.x + 0.5 || a.bottom <= b.y + 0.5 || b.bottom <= a.y + 0.5,
            true, `${role} ${width}: ${a.label} and ${b.label} do not overlap`);
        }
      }
      return layout;
    }

    for (const width of [320, 360, 384, 412, 1280]) {
      await checkLayout(gm, width, 'gm');
      await checkLayout(player, width, 'player');
    }
    assert.equal((await checkLayout(gm, 1280, 'gm')).icon, false, 'desktop keeps full labels');
    assert.equal((await checkLayout(gm, 320, 'gm')).icon, true, 'narrow GM nav uses icons');
    const heroTab = player.locator('[data-tab="heroes"]');
    await heroTab.click();
    assert.equal(await heroTab.evaluate(node => node.classList.contains('active')), true);
    await player.locator('[data-tab="map"]').click();
    assert.equal(await player.locator('[data-tab="map"]').evaluate(node => node.classList.contains('active')), true);
    await player.locator('#journal-open').click();
    assert.equal(await player.locator('.journal-dialog').isVisible(), true);
    await player.getByRole('button', { name: 'Zamknij dziennik rzutów' }).click();
    await gm.locator('#settings-open').click();
    assert.equal(await gm.locator('#settings').isVisible(), true);
    await gm.locator('#settings-close').click();
    await gm.locator('#notebook-open').click();
    assert.equal(await gm.locator('.notebook-dialog').isVisible(), true);
    await gm.getByRole('button', { name: /Zamknij.*zapiski/i }).click();

    const longName = 'Bardzo Długa Nazwa Bohatera z Dalekiej Krainy';
    await gm.evaluate(async ({ id, name }) => OneRingStore.saveHero({ id, name }, 0), { id: fixture.heroes[0].id, name: longName });
    await player.evaluate(() => OneRingStore.refresh());
    await player.waitForFunction(name => document.querySelector('[data-tab="heroes"]').getAttribute('aria-label') === name, longName);
    assert.equal(await heroTab.locator('.nav-tab-icon').count(), 1, 'name updates preserve icon');
    assert.equal((await checkLayout(player, 320, 'player')).icon, true, 'long player name uses icons');
    assert.equal((await checkLayout(player, 1280, 'player')).icon, false, 'long player name fits on desktop');
    await player.addStyleTag({ content: '.tabs > .tab { font-size: 28px !important; }' });
    assert.equal((await checkLayout(player, 412, 'player')).icon, true, 'scaled text triggers icon mode');
    await checkLayout(gm, 240, 'gm');
    assert.deepEqual(errors, []);
    console.log('PASS: responsive GM/player nav icons, labels, actions, long name and scaled text');
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
