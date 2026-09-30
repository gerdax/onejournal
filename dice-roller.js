(function (root) {
  'use strict';

  const config = { actor: 'hero', privateRoll: true, baseDice: 0, featMode: 'normal', exhausted: false,
    miserable: false, bonus: 0, hope: false, inspired: false, enemyResource: false, target: '' };
  let dialog, launch, setup, resultPanel, stage, opener, pending = null, generation = 0, headerOnly = false;
  let pressStartedInSheet = false;

  function playerHero() {
    const store = root.OneRingStore;
    return store.access.role === 'player'
      ? store.getState().heroes.find(hero => hero.id === store.access.heroId) || null
      : null;
  }

  function setupHeading() {
    const hero = playerHero();
    return root.OneRingStore.access.role === 'player' ? hero?.name || 'Bez imienia' : 'Rzut';
  }

  function element(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  }

  function mount() {
    if (dialog || !document.body) return;
    launch = element('<button type="button" class="dice-launch" aria-label="Otwórz rzut kośćmi" title="Rzuć kośćmi"><svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" focusable="false"><rect x="4" y="4" width="24" height="24" rx="5" fill="none" stroke="currentColor" stroke-width="2" transform="rotate(-12 16 16)"/><g fill="currentColor" transform="rotate(-12 16 16)"><circle cx="10" cy="10" r="2"/><circle cx="22" cy="10" r="2"/><circle cx="16" cy="16" r="2"/><circle cx="10" cy="22" r="2"/><circle cx="22" cy="22" r="2"/></g></svg></button>');
    dialog = element(`<dialog class="dice-dialog" aria-label="Rzut kośćmi">
      <div class="dice-dialog-layout">
        <div class="dice-table" aria-hidden="true"></div>
        <section class="dice-sheet" aria-live="polite">
          <div class="dice-sheet-head"><h2><button type="button" class="dice-collapse" aria-label="Zwiń ustawienia rzutu" aria-expanded="true" aria-controls="dice-settings"><span id="dice-heading">Rzut</span><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg></button></h2><button type="button" class="dice-close" aria-label="Zamknij rzut">×</button></div>
          <div class="dice-setup">
            <div id="dice-settings" class="dice-settings">
            <fieldset class="dice-field"><legend>Kto rzuca?</legend><div class="dice-actor-row"><div class="dice-options" data-choice="actor"><button type="button" data-value="hero">MG</button><button type="button" data-value="enemy">Przeciwnik</button></div><label class="dice-private"><input type="checkbox" data-check="privateRoll"> Priv</label></div></fieldset>
            <fieldset class="dice-field"><legend>Kości sukcesu</legend><div class="dice-options dice-counts" data-choice="baseDice"><button type="button" data-value="0">0</button><button type="button" data-value="1">1</button><button type="button" data-value="2">2</button><button type="button" data-value="3">3</button><button type="button" data-value="4">4</button><button type="button" data-value="5">5</button><button type="button" data-value="6">6</button></div></fieldset>
            <fieldset class="dice-field"><legend>Kość działania</legend><div class="dice-options" data-choice="featMode"><button type="button" data-value="weary">Osłabiona</button><button type="button" data-value="normal">Normalna</button><button type="button" data-value="favoured">Wzmocniona</button></div></fieldset>
            <div class="dice-checks"><label><input type="checkbox" data-check="exhausted"> Wyczerpany</label><label class="dice-miserable"><input type="checkbox" data-check="miserable"> Przygnębiony</label></div>
            <div class="dice-lower"><div class="dice-bonus"><span>Premia / kara</span><div class="dice-stepper"><button type="button" data-step="-1" aria-label="Zmniejsz premię">−</button><output class="dice-bonus-value">0k</output><button type="button" data-step="1" aria-label="Zwiększ premię">+</button></div></div>
              <label class="dice-target">PT <span>(opcjonalnie)</span><input type="number" min="0" step="1" inputmode="numeric" data-target></label></div>
            <div class="dice-hope"><label class="dice-hero-resource"><input type="checkbox" data-check="hope"> Wydaj Nadzieję <span>+1k</span></label><label class="dice-enemy-resource" hidden><input type="checkbox" data-check="enemyResource"><span class="dice-spend-text">Wydaj Nienawiść/Determinację</span><span>+1k</span></label><label class="dice-inspired"><input type="checkbox" data-check="inspired"> Natchniony <span>→ +2k</span></label></div>
            </div>
            <div class="dice-pool" role="status"></div><div class="dice-preview" aria-hidden="true"></div>
            <p class="dice-error" role="alert" hidden></p><button type="button" class="dice-roll">Rzuć</button>
          </div>
          <div class="dice-result" hidden></div>
        </section>
        <div id="dice-stage" aria-label="Kości 3D"></div>
      </div>
    </dialog>`);
    document.body.append(launch, dialog);
    setup = dialog.querySelector('.dice-setup');
    resultPanel = dialog.querySelector('.dice-result');
    stage = dialog.querySelector('#dice-stage');
    launch.addEventListener('click', open);
    dialog.querySelector('.dice-close').addEventListener('click', close);
    dialog.querySelector('.dice-collapse').addEventListener('click', () => {
      if (pending) return;
      headerOnly = !headerOnly;
      renderCollapse();
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('pointerdown', event => {
      pressStartedInSheet = !!event.target.closest('.dice-sheet');
    });
    dialog.addEventListener('click', event => {
      const outsideSheet = !event.target.closest('.dice-sheet');
      if (outsideSheet && !pressStartedInSheet) close();
      pressStartedInSheet = false;
    });
    setup.addEventListener('click', event => {
      const choice = event.target.closest('[data-choice] button');
      if (choice) {
        const field = choice.parentElement.dataset.choice;
        config[field] = field === 'baseDice' ? Number(choice.dataset.value) : choice.dataset.value;
        renderSetup();
      }
      const step = event.target.closest('[data-step]');
      if (step) { config.bonus = Math.max(-6, Math.min(6, config.bonus + Number(step.dataset.step))); renderSetup(); }
    });
    setup.addEventListener('change', event => {
      if (event.target.dataset.check) { config[event.target.dataset.check] = event.target.checked; renderSetup(); }
      if (event.target.matches('[data-target]')) { config.target = event.target.value; renderSetup(); }
    });
    setup.querySelector('.dice-roll').addEventListener('click', roll);
    renderSetup();
  }

  function renderSetup() {
    if (!dialog) return;
    const store = root.OneRingStore;
    if (store.access.role === 'player') { config.actor = 'hero'; config.privateRoll = false; }
    if (dialog.dataset.view === 'setup') dialog.querySelector('#dice-heading').textContent = setupHeading();
    setup.querySelector('[data-choice="actor"]').closest('fieldset').hidden = store.access.role === 'player';
    dialog.dataset.actor = config.actor;
    setup.querySelectorAll('[data-choice]').forEach(group => {
      const field = group.dataset.choice;
      group.querySelectorAll('button').forEach(button => {
        const selected = String(config[field]) === button.dataset.value;
        button.setAttribute('aria-pressed', String(selected));
      });
    });
    const hero = playerHero();
    if (store.access.role === 'player' && !(Number(hero?.hope) > 0)) {
      config.hope = false;
      config.inspired = false;
    }
    setup.querySelectorAll('[data-check]').forEach(input => { input.checked = !!config[input.dataset.check]; });
    setup.querySelector('.dice-miserable').inert = config.actor === 'enemy';
    setup.querySelector('.dice-hero-resource').hidden = config.actor === 'enemy';
    setup.querySelector('.dice-enemy-resource').hidden = config.actor !== 'enemy';
    setup.querySelector('.dice-inspired').hidden = config.actor === 'enemy' || !config.hope;
    setup.querySelector('[data-target]').value = config.target;
    setup.querySelector('.dice-bonus-value').textContent = `${config.bonus > 0 ? '+' : ''}${config.bonus}k`;
    setup.querySelectorAll('button, input').forEach(control => { control.disabled = !!pending; });
    setup.querySelector('[data-check="hope"]').disabled = !!pending || (store.access.role === 'player' && !(Number(hero?.hope) > 0));
    setup.querySelector('[data-step="-1"]').disabled = !!pending || config.bonus <= -6;
    setup.querySelector('[data-step="1"]').disabled = !!pending || config.bonus >= 6;
    const pool = root.DiceRules.calculatePool(config);
    const featCount = config.featMode === 'normal' ? 1 : 2;
    setup.querySelector('.dice-pool').textContent = `Pula: ${featCount} × kość działania · ${pool} × kość sukcesu`;
    const preview = setup.querySelector('.dice-preview');
    preview.replaceChildren();
    // Reserve both actors' preview slots so switching actors does not change row wrapping.
    const previewSlots = Math.max(pool, root.DiceRules.calculatePool({ ...config, actor: 'hero' }),
      root.DiceRules.calculatePool({ ...config, actor: 'enemy' }));
    for (let i = 0; i < featCount + previewSlots; i++) {
      const die = document.createElement('span');
      die.className = `dice-preview-die ${i < featCount ? 'dice-feat' : 'dice-success'}`;
      die.textContent = i < featCount ? '✦' : '6';
      if (i >= featCount + pool) die.style.visibility = 'hidden';
      preview.append(die);
    }
    setup.querySelector('.dice-roll').disabled = !!pending || !store.canWrite;
    renderCollapse();
  }

  function renderCollapse() {
    const settings = setup.querySelector('#dice-settings');
    settings.hidden = headerOnly;
    setup.hidden = dialog.dataset.view !== 'setup' || headerOnly;
    resultPanel.hidden = dialog.dataset.view !== 'result' || headerOnly;
    dialog.querySelector('.dice-sheet').classList.toggle('is-header-only', headerOnly);
    const toggle = dialog.querySelector('.dice-collapse');
    toggle.setAttribute('aria-controls', dialog.dataset.view === 'result' ? 'dice-result-details' : 'dice-settings');
    toggle.disabled = !!pending;
    toggle.setAttribute('aria-expanded', String(!headerOnly));
    const details = dialog.dataset.view === 'result' ? 'szczegóły wyniku' : 'ustawienia rzutu';
    toggle.setAttribute('aria-label', `${headerOnly ? 'Rozwiń' : 'Zwiń'} ${details}`);
  }

  function resizeStage() {
    requestAnimationFrame(() => {
      if (dialog && dialog.open) window.dispatchEvent(new Event('resize'));
    });
  }

  function showError(message) {
    const error = setup.querySelector('.dice-error');
    error.textContent = message;
    error.hidden = false;
  }

  function open() {
    mount();
    if (!dialog || dialog.open) return;
    opener = document.activeElement;
    headerOnly = false;
    pressStartedInSheet = false;
    const hero = playerHero();
    if (hero) {
      config.exhausted = !!hero.weary;
      config.miserable = !!hero.miserable;
      config.hope = false;
      config.inspired = false;
    }
    dialog.dataset.view = 'setup';
    setup.hidden = false;
    resultPanel.hidden = true;
    dialog.querySelector('#dice-heading').textContent = setupHeading();
    dialog.showModal();
    renderSetup();
    resizeStage();
    setup.querySelector(root.OneRingStore.access.role === 'player' ? '[data-choice="baseDice"] button[aria-pressed="true"]' : '[data-choice="actor"] button[aria-pressed="true"]').focus();
  }

  function close() {
    if (!dialog || !dialog.open) return;
    generation++;
    dialog.close();
    pressStartedInSheet = false;
    if (root.DiceEngine && typeof root.DiceEngine.clear === 'function') root.DiceEngine.clear();
    if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
  }

  function featSymbol(face) {
    const paths = face === 11
        ? '<path d="M -34 0 Q 0 -32 34 0 Q 0 32 -34 0Z"/><path d="M 0 -18 Q 12 0 0 18 Q -12 0 0 -18Z"/>'
        : '<path d="M 0 28 V -28 M -22 -8 L 0 -28 L 22 -8 M 0 5 L 21 -15"/>';
    return element(`<svg class="dice-feat-symbol" viewBox="-40 -36 80 72" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`);
  }

  function resultDie(face, selected, automaticSuccess) {
    const node = document.createElement('span');
    node.className = `dice-result-die${!selected ? ' is-unused' : automaticSuccess ? ' is-success' : ''}`;
    const label = root.DiceRules.featLabel(face);
    if (face === 11 || face === 12) {
      node.append(featSymbol(face));
      node.title = label;
    } else {
      node.textContent = label;
    }
    if (!selected) node.setAttribute('aria-label', `${label}, niewykorzystana`);
    if (selected) {
      const selectedLabel = document.createElement('small');
      selectedLabel.textContent = 'wykorzystana';
      node.append(selectedLabel);
      node.setAttribute('aria-label', `${label}, wykorzystana`);
    }
    return node;
  }

  function showResult(outcome) {
    resultPanel.replaceChildren();
    const featTitle = element('<h3>Kość działania</h3>');
    const featRow = element('<div class="dice-result-row"></div>');
    outcome.feat.forEach((face, index) => featRow.append(resultDie(face, index === outcome.selectedFeatIndex, outcome.automaticSuccess)));
    const successTitle = element('<h3>Kości sukcesu</h3>');
    const successRow = element('<div class="dice-result-row"></div>');
    outcome.successDice.forEach(die => {
      const item = element('<span class="dice-result-die"></span>');
      const used = die.value > 0;
      if (!used) item.classList.add('is-unused');
      else if (die.successMarks > 0) item.classList.add('is-success');
      item.textContent = String(die.raw);
      item.setAttribute('aria-label', used ? `${die.raw}, wykorzystana` : `${die.raw}, niewykorzystana przez Wyczerpanie, liczy się jako 0`);
      successRow.append(item);
    });
    const summary = element('<div class="dice-result-summary"></div>');
    const total = element('<p class="dice-total"></p>');
    const totalValue = element('<span class="dice-total-value"></span>');
    totalValue.textContent = String(outcome.sum);
    totalValue.classList.toggle('is-threshold-met', outcome.automaticSuccess || (outcome.target !== null && outcome.sum >= outcome.target));
    total.append('Suma: ', totalValue);
    if (outcome.target !== null) total.append(`/${outcome.target}`);
    const marks = element('<p></p>');
    marks.textContent = `Znaki sukcesu: ${outcome.marks}`;
    summary.append(total, marks);
    if (outcome.automaticSuccess) {
      const verdict = element('<p class="dice-verdict"></p>');
      verdict.setAttribute('aria-label', `${outcome.selectedFeatLabel} · automatyczny sukces`);
      verdict.append(featSymbol(outcome.selectedFeat), ' · AUTOMATYCZNY SUKCES');
      summary.append(verdict);
    } else if (outcome.target !== null) {
      const verdict = element('<p class="dice-verdict"></p>');
      verdict.textContent = outcome.passed ? 'SUKCES' : 'PORAŻKA';
      verdict.classList.toggle('is-failure', !outcome.passed);
      summary.append(verdict);
    }
    const again = element('<button type="button" class="dice-again">Przygotuj kolejny rzut</button>');
    again.addEventListener('click', () => {
      resultPanel.hidden = true;
      setup.hidden = false;
      dialog.dataset.view = 'setup';
      dialog.querySelector('#dice-heading').textContent = setupHeading();
      if (root.DiceEngine && typeof root.DiceEngine.clear === 'function') root.DiceEngine.clear();
      renderSetup();
      resizeStage();
      setup.querySelector('.dice-roll').focus();
    });
    const groups = element('<div id="dice-result-details" class="dice-result-groups"></div>');
    const featGroup = element('<section class="dice-result-group" aria-label="Kość działania"></section>');
    const successGroup = element('<section class="dice-result-group" aria-label="Kości sukcesu"></section>');
    featGroup.append(featTitle, featRow);
    successGroup.append(successTitle, successRow);
    groups.append(featGroup, successGroup);
    resultPanel.append(groups, summary, again);
    setup.hidden = true;
    resultPanel.hidden = false;
    dialog.dataset.view = 'result';
    dialog.querySelector('#dice-heading').textContent = 'Wynik';
    renderCollapse();
    again.focus();
  }

  async function roll() {
    if (pending || !dialog.open) return;
    if (!root.OneRingStore.canWrite) { showError('Brak połączenia — rzut jest zablokowany.'); return; }
    const targetInput = setup.querySelector('[data-target]');
    if (!targetInput.checkValidity()) {
      headerOnly = false;
      renderSetup();
      targetInput.reportValidity();
      return;
    }
    config.target = targetInput.value;
    setup.querySelector('.dice-error').hidden = true;
    if (root.OneRingStore.access.role === 'player' && config.hope && !(Number(playerHero()?.hope) > 0)) {
      showError('Brak Nadziei — wyłącz jej wydawanie przed rzutem.');
      renderSetup();
      return;
    }
    if (!root.DiceEngine || typeof root.DiceEngine.roll !== 'function') {
      showError('Silnik kości jest niedostępny.');
      return;
    }
    const token = ++generation;
    const snapshot = { ...config };
    let prepared;
    try { prepared = root.OneJournalRolls.prepare(snapshot); }
    catch (error) { showError(error.message); return; }
    const pool = root.DiceRules.calculatePool(snapshot);
    const button = setup.querySelector('.dice-roll');
    button.disabled = true;
    button.textContent = 'Kości w ruchu…';
    dialog.dataset.rolling = 'true';
    try {
      pending = Promise.resolve(root.DiceEngine.roll({
        container: stage, actor: snapshot.actor,
        featCount: snapshot.featMode === 'normal' ? 1 : 2, successCount: pool
      }));
      renderSetup();
      const raw = await pending;
      // Always preserve a settled roll, even when the overlay was closed.
      const rollId = root.OneJournalRolls.capture(prepared, raw);
      if (token === generation && dialog.open) showResult(root.DiceRules.interpretRoll(snapshot, raw));
      try { await root.OneJournalRolls.publish(rollId); }
      catch (_) { root.OneJournalRolls.notify('Wynik nieopublikowany. Otwórz Dziennik rzutów i ponów publikację.'); }
    } catch (error) {
      if (token === generation && dialog.open) showError(`Rzut się nie powiódł: ${error && error.message ? error.message : 'nieznany błąd. Spróbuj ponownie.'}`);
    } finally {
      pending = null;
      button.textContent = 'Rzuć';
      dialog.dataset.rolling = 'false';
      if (dialog.open) renderSetup();
    }
  }

  root.DiceRoller = { open, close };
  root.OneRingStore.subscribe(() => { if (dialog?.open) renderSetup(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})(globalThis);
