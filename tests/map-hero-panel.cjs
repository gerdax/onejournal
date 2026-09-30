/* Isolated browser test for shared hero controls and participant navigation. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(process.env.BASE_URL || 'http://127.0.0.1:8765');
    assert.equal(await page.locator('#map-count').textContent(),'0');
    await page.locator('[data-tab="map"]').click();
    await page.locator('#map-add-heroes').click();
    assert.equal(await page.locator('#map-count').textContent(),'0');
    const ids = await page.evaluate(() => {
      const store = window.OneRingStore;
      const heroes = [
        {name:'Aragorn', stance:'Zapalczywa'},
        {name:'Gimli', maxEndurance:24, endurance:20, maxHope:12, hope:9, parry:18, armour:2, load:10, shadow:3},
        {name:'Legolas', stance:'Defensywna'},
        {name:'Frodo', stance:'Bezpieczna'},
        {name:'Boromir', stance:'Ostrożna'}
      ].map(data => { const h = store.saveHero(data); store.addHero(h.id); return h.id; });
      const enemies = ['Wilk','Goblin','Goblin'].map(name => store.addEnemy({name,kind:'Bestia',maxEndurance:8,endurance:8,maxHate:2,hate:2}).id);
      store.setMap(window.OneRingMap.generateTerrain('clearing','large','hero-panel'));
      return {heroes,enemies};
    });
    await page.locator('[data-tab="map"]').click();
    assert.equal(await page.locator('#map-count').textContent(),'8');
    assert.equal(await page.locator('#map-panel h3').count(),0);
    assert.equal(await page.locator('#map-panel .map-panel-help').textContent(),'Dotknij znacznika postaci na mapie, aby zobaczyć zasoby i działania.');
    await page.evaluate(id=>OneRingStore.toggleDefeated(id),ids.enemies[0]);
    assert.equal(await page.locator('#map-count').textContent(),'8');
    await page.evaluate(id=>OneRingStore.toggleDefeated(id),ids.enemies[0]);
    const viewport = page.locator('#map-viewport');
    const stageSize = await page.locator('#map-stage').evaluate(n => ({width:n.offsetWidth,height:n.offsetHeight}));
    assert.equal(stageSize.width,stageSize.height);
    const scale = () => page.locator('#map-stage').evaluate(n => new DOMMatrix(getComputedStyle(n).transform).a);
    assert.deepEqual(await viewport.locator('.map-zoom-controls:not(.map-center-controls):not(.map-fullscreen-controls) button').allTextContents(),['Dopasuj','−','+']);
    assert.equal(await page.locator('.map-toolbar .map-zoom-controls, #map-zoom-level').count(),0);
    await page.locator('#map-fit').click();
    const fittedScale = await scale();
    await page.locator('#map-zoom-in').click();
    assert.ok(await scale() > fittedScale);
    await page.locator('#map-zoom-out').click();
    assert.ok(Math.abs(await scale() - fittedScale) < .00001);
    await page.locator('#map-zoom-in').focus();
    await page.keyboard.press('Enter');
    assert.ok(await scale() > fittedScale);
    await page.locator('#map-fit').click();
    assert.ok(Math.abs(await scale() - fittedScale) < .00001);
    await page.locator('#map-fullscreen').click();
    await page.locator('#map-fit').click();
    const initialScale = await scale();
    await viewport.dispatchEvent('wheel',{deltaY:-100,deltaMode:0,clientX:300,clientY:300});
    const zoomed = await scale();
    assert.ok(zoomed > initialScale && zoomed <= 3);
    await viewport.dispatchEvent('wheel',{deltaY:100,deltaMode:0,clientX:300,clientY:300});
    assert.ok(Math.abs(await scale() - initialScale) < .00001);
    await viewport.dispatchEvent('wheel',{deltaY:0,deltaMode:0});
    assert.ok(Math.abs(await scale() - initialScale) < .00001);
    await page.locator('#map-fullscreen').click();
    const panel = page.locator('#map-panel');
    const title = () => panel.locator('h3').textContent();
    const selectHero = id => page.locator(`.map-token[data-id="hero:${id}"]`).click();
    await selectHero(ids.heroes[1]);
    assert.equal(await title(), 'Gimli');
    assert.equal(await panel.locator('[name="stance"]').inputValue(), 'Wyważona');
    assert.equal(await panel.locator('.map-panel-facts input').count(), 0);
    for (const value of ['18','2','10','3']) assert.ok((await panel.locator('.map-panel-facts').textContent()).includes(value));
    for (const expected of ['Boromir','Legolas','Frodo','Aragorn','Gimli']) {
      await panel.locator('.map-cycle-next').click(); assert.equal(await title(), expected);
    }
    await panel.locator('.map-cycle-prev').click(); assert.equal(await title(), 'Aragorn');
    await panel.locator('.map-cycle-prev').click(); assert.equal(await title(), 'Frodo');
    await selectHero(ids.heroes[1]);
    await panel.locator('[name="stance"]').selectOption('Defensywna');
    await panel.locator('.map-resource').filter({hasText:'Nadzieja'}).getByRole('button',{name:'Zmniejsz nadzieja',exact:true}).click();
    for (const key of ['weary','miserable','wounded']) await panel.locator(`[name="${key}"]`).check();
    await panel.locator('[name="injury"]').fill('Ciężka');
    await panel.locator('[name="injury"]').press('End');
    await page.keyboard.type(' rana');
    assert.equal(await panel.locator('[name="injury"]').inputValue(), 'Ciężka rana');
    await panel.locator('[name="injury"]').press('Tab');
    await panel.getByRole('button',{name:'Nieprzytomny / konający',exact:true}).click();
    assert.equal(await page.locator(`.map-token[data-id="hero:${ids.heroes[1]}"]`).evaluate(n => n.classList.contains('is-defeated')), true);
    await panel.getByRole('button',{name:'Przywróć do walki',exact:true}).click();
    assert.equal(await page.locator(`.map-token[data-id="hero:${ids.heroes[1]}"]`).evaluate(n => n.classList.contains('is-defeated')), false);
    await page.locator('[data-tab="heroes"]').click();
    await page.getByRole('tab',{name:'Gimli',exact:true}).click();
    assert.equal(await page.locator('#hero-editor [name="hope"]').inputValue(), '8');
    for (const key of ['weary','miserable','wounded']) assert.equal(await page.locator(`#hero-editor [name="${key}"]`).isChecked(), true);
    assert.equal(await page.locator('#hero-editor [name="injury"]').inputValue(), 'Ciężka rana');
    await page.locator('#hero-editor [name="weary"]').uncheck();
    await page.locator('#hero-editor [name="shadow"]').fill('5');
    await page.locator('#hero-editor [name="shadow"]').press('Tab');
    await page.locator('[data-tab="map"]').click();
    assert.equal(await panel.locator('[name="weary"]').isChecked(), false);
    assert.ok((await panel.locator('.map-panel-facts').textContent()).includes('5'));
    const heroPanelHeight = (await panel.boundingBox()).height;
    assert.equal((await page.locator('#map-viewport').boundingBox()).height, heroPanelHeight);
    await page.locator('.map-layout').screenshot({path:'/tmp/map-hero-panel.png'});
    await page.locator(`.map-token[data-id="${ids.enemies[0]}"]`).click();
    assert.deepEqual(await panel.locator('.map-panel-facts span').allTextContents(),['Zajadł.','Potęga','Obrona','Pancerz']);
    assert.equal(await panel.locator('.map-panel-hero-facts').count(),1);
    assert.equal((await panel.boundingBox()).height, heroPanelHeight);
    assert.equal((await page.locator('#map-viewport').boundingBox()).height, heroPanelHeight);
    assert.deepEqual(await page.locator('.enemy-token .map-token-label').allTextContents(),['Wilk','Goblin','Goblin']);
    const enemyCycle = [...ids.enemies.slice(1).sort((a,b)=>a.localeCompare(b)),ids.enemies[0]];
    for (const [index, expected] of ['Goblin','Goblin','Wilk'].entries()) {
      await panel.locator('.map-cycle-next').click(); assert.equal(await title(),expected);
      assert.equal(await page.locator('.map-token.is-selected').getAttribute('data-id'),enemyCycle[index]);
    }
    const selectedSymbol = page.locator('.map-token.is-selected .map-token-symbol');
    assert.equal(await selectedSymbol.evaluate(node=>getComputedStyle(node).outlineWidth),'6px');
    assert.equal(await selectedSymbol.evaluate(node=>getComputedStyle(node).animationName),'selected-token-pulse');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await selectedSymbol.evaluate(node=>getComputedStyle(node).animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await panel.locator('.map-cycle-prev').click(); assert.equal(await title(),'Goblin');
    await panel.getByRole('button',{name:'Oznacz jako pokonanego'}).click();
    assert.equal(await panel.evaluate(node=>node.classList.contains('is-defeated')),true);
    assert.equal(await panel.locator('h3').evaluate(node=>getComputedStyle(node).opacity),'0.55');
    assert.equal(await panel.locator('.map-panel-action').evaluate(node=>getComputedStyle(node).opacity),'1');
    await panel.getByRole('button',{name:'Przywróć do walki'}).click();
    assert.equal(await panel.evaluate(node=>node.classList.contains('is-defeated')),false);
    assert.equal(await panel.locator('h3').evaluate(node=>getComputedStyle(node).opacity),'1');
    await page.reload();
    assert.equal(await page.locator('#map-count').textContent(),'8');
    await page.locator('[data-tab="map"]').click();
    await selectHero(ids.heroes[1]);
    assert.equal(await panel.locator('[name="stance"]').inputValue(), 'Defensywna');
    assert.equal(await panel.locator('[name="injury"]').inputValue(), 'Ciężka rana');
    for (const width of [853,390,320]) {
      await page.setViewportSize({width,height:849});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow ${width}`);
    }
    page.once('dialog', d => d.accept());
    await panel.getByRole('button',{name:'Usuń z potyczki'}).click();
    assert.equal(await page.locator(`.map-token[data-id="hero:${ids.heroes[1]}"]`).count(),0);
    assert.equal(await page.evaluate(id => OneRingStore.getState().heroes.some(h => h.id === id),ids.heroes[1]),true);
    await page.evaluate(ids => { for (const id of ids) OneRingStore.removeParticipant('hero:' + id); }, ids.heroes.filter(id => id !== ids.heroes[0]));
    await selectHero(ids.heroes[0]);
    assert.equal(await panel.locator('.map-cycle-next').isDisabled(),true);
    assert.equal(await panel.locator('.map-cycle-prev').isDisabled(),true);
    const beforeClear = await page.evaluate(() => OneRingStore.exportBackup());
    page.once('dialog', d => d.dismiss());
    await page.locator('#map-clear').click();
    assert.deepEqual(await page.evaluate(() => OneRingStore.exportBackup()), beforeClear);
    page.once('dialog', d => d.accept());
    await page.locator('#map-clear').click();
    const afterClear = await page.evaluate(() => OneRingStore.exportBackup());
    assert.equal(afterClear.map,null);
    assert.deepEqual(afterClear.battle,[]);
    assert.deepEqual(afterClear.heroParticipants,[]);
    assert.deepEqual(afterClear.heroes,beforeClear.heroes);
    assert.deepEqual(afterClear.library,beforeClear.library);
    assert.equal(await page.locator('#map-stage').isVisible(),false);
    assert.equal(await page.locator('#map-blank').isVisible(),true);
    assert.deepEqual(errors,[]);
    assert.equal(await page.locator('#map-panel > h3').count(),0);
    await page.locator('#map-add-heroes').click();
    const added = await page.evaluate(()=>OneRingStore.getState());
    assert.equal(added.heroParticipants.length,added.heroes.length);
    const firstHero = [...added.heroes].sort((a,b)=>a.name.localeCompare(b.name,'pl'))[0];
    await page.locator('#map-generate').click();
    assert.equal(await page.locator('#map-panel > h3').textContent(),firstHero.name);
    assert.equal(await page.locator('.map-token.is-selected').getAttribute('data-id'),'hero:'+firstHero.id);
    await page.locator('#map-add-heroes').click();
    assert.deepEqual(await page.evaluate(()=>OneRingStore.getState().heroParticipants),added.heroParticipants);
    console.log('Map hero panel passed: shared fields, stance, defeat, separate cyclic navigation, reload, responsive layout, removal.');
  } finally { await browser.close(); }
})().catch(e => {console.error(e);process.exitCode=1;});
