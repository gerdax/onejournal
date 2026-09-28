(function () {
  'use strict';
  const store = window.OneRingStore;
  const owner = store.access.role + ':' + (store.access.heroId || 'gm');
  const pendingKey = 'onejournal:pending-rolls:' + location.pathname + ':' + owner;
  let pending = [], publishing = new Set(), toastTimer;
  try { const saved = JSON.parse(sessionStorage.getItem(pendingKey) || '[]'); if (Array.isArray(saved)) pending = saved.filter(x => x && typeof x.id === 'string' && x.config && x.raw); } catch (_) {}
  const seen = new Set(store.rolls.map(roll => roll.id));
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const dialog = el('dialog', null, 'journal-dialog'); dialog.setAttribute('aria-label', 'Dziennik rzutów');
  const head = el('div', null, 'journal-head'), close = el('button', '×', 'journal-close');
  close.type = 'button'; close.setAttribute('aria-label', 'Zamknij dziennik rzutów'); close.title = 'Zamknij';
  head.append(el('h2', 'Dziennik rzutów'), close);
  const list = el('div'), notice = el('p'); notice.setAttribute('role', 'status');
  const body = el('div', null, 'journal-body'); body.append(notice, list);
  dialog.append(head, body); document.body.append(dialog);
  close.onclick = () => dialog.close();
  document.getElementById('journal-open').onclick = () => { render(); dialog.showModal(); body.scrollTop = 0; };
  function persist() { try { sessionStorage.setItem(pendingKey, JSON.stringify(pending)); } catch (_) {} }
  function verdict(result) {
    if (result.automaticFailure) return 'automatyczna porażka';
    if (result.automaticSuccess) return 'automatyczny sukces';
    return result.passed === true ? 'sukces' : result.passed === false ? 'porażka' : 'bez PT';
  }
  function title(entry) { return (entry.authorRole === 'gm' && entry.actor === 'hero' ? 'MG za ' : '') + (entry.heroName || entry.name || (entry.actor === 'enemy' ? 'Wróg · prywatny rzut MG' : 'Bohater')); }
  function summary(entry) { return `${title(entry)}: ${entry.result.sum}${verdict(entry.result) === 'bez PT' ? '' : ' — ' + verdict(entry.result)}`; }
  function toast(text) {
    document.querySelector('.journal-toast')?.remove(); clearTimeout(toastTimer);
    const node = el('div', text, 'journal-toast'); node.setAttribute('role', 'status'); document.body.append(node);
    if (typeof node.showPopover === 'function') { node.setAttribute('popover', 'manual'); node.showPopover(); }
    toastTimer = setTimeout(() => node.remove(), 6000);
  }
  document.addEventListener('toggle', event => {
    if (event.target.tagName !== 'DIALOG' || event.newState !== 'open') return;
    const node = document.querySelector('.journal-toast');
    if (node?.matches(':popover-open')) { node.hidePopover(); node.showPopover(); }
  }, true);
  function die(face, ignored, feat) {
    const node = el('span', null, ignored ? 'journal-die is-ignored' : 'journal-die');
    const label = feat ? DiceRules.featLabel(face) : String(face);
    node.setAttribute('aria-label', label + (ignored ? ' — nieuwzględniona w wyniku' : ''));
    node.title = label + (ignored ? ' — nieuwzględniona w wyniku' : '');
    if (feat && face >= 11) {
      const paths = face === 11 ? '<path d="M -34 0 Q 0 -32 34 0 Q 0 32 -34 0Z"/><path d="M 0 -18 Q 12 0 0 18 Q -12 0 0 -18Z"/>' : '<path d="M 0 28 V -28 M -22 -8 L 0 -28 L 22 -8 M 0 5 L 21 -15"/>';
      node.innerHTML = '<svg width="22" height="24" viewBox="-40 -36 80 72" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
    } else node.textContent = String(face);
    return node;
  }
  function render() {
    if (!store.access.role) { list.replaceChildren(); pending = []; sessionStorage.removeItem(pendingKey); return; }
    list.replaceChildren();
    for (const entry of pending) {
      const row = el('article', null, 'journal-entry'); row.append(el('h3', 'Rzut oczekuje na publikację'));
      const result = DiceRules.interpretRoll(entry.config, entry.raw);
      row.append(el('p', `Wynik: ${result.sum}${verdict(result) === 'bez PT' ? '' : ' — ' + verdict(result)}. Ponowienie nie losuje nowych kości.`));
      const retry = el('button', publishing.has(entry.id) ? 'Publikowanie…' : 'Ponów publikację'); retry.disabled = !store.canWrite || publishing.has(entry.id);
      retry.onclick = () => publish(entry.id).catch(() => {}); row.append(retry); list.append(row);
    }
    for (const entry of store.rolls.slice().reverse()) {
      const row = el('article', null, 'journal-entry'); row.dataset.rollId = entry.id;
      const c = entry.config, result = entry.result;
      const time = el('time', new Date(entry.createdAt || entry.at).toLocaleString('pl-PL'), 'journal-time');
      time.dateTime = entry.createdAt || entry.at;
      row.append(time, el('h3', title(entry)));
      row.append(el('p', `Pula bazowa: ${c.baseDice}; premia/kara: ${c.bonus};`, 'journal-pool'));
      const flags = [];
      if (c.featMode === 'weary') flags.push('Osłabienie');
      if (c.featMode === 'favoured') flags.push('Wzmocnienie');
      flags.push(...[['exhausted', 'Wyczerpanie'], ['miserable', 'Przygnębienie'], ['hope', 'Nadzieja'], ['inspired', 'Natchnienie'], ['enemyResource', 'Nienawiść/Determinacja']].filter(([key]) => c[key]).map(([, label]) => label));
      if (flags.length) row.append(el('p', flags.join(' · '), 'journal-flags'));
      const dice = el('div', null, 'journal-dice');
      const feat = el('p', 'Kość Działania: ');
      entry.raw.feat.forEach((face, index) => {
        if (index) feat.append(document.createTextNode(', '));
        feat.append(die(face, index !== result.selectedFeatIndex, true));
      });
      const success = el('p', 'Kości sukcesu: ');
      entry.raw.success.forEach((face, index) => {
        if (index) success.append(document.createTextNode(', '));
        success.append(die(face, !!c.exhausted && face <= 3, false));
      });
      if (!entry.raw.success.length) success.append(document.createTextNode('brak'));
      dice.append(feat, success); row.append(dice);
      const outcome = el('p', null, 'journal-result');
      const successful = result.automaticSuccess || result.passed === true;
      const interpretation = verdict(result);
      outcome.append(el('strong', result.sum, 'journal-total' + (successful ? ' is-success' : '')), document.createTextNode(`${result.target == null ? '' : '/' + result.target}${interpretation === 'bez PT' ? '' : ' — ' + interpretation} · znaki sukcesu: ${result.marks}`));
      row.append(outcome); list.append(row);
    }
    if (!pending.length && !store.rolls.length) list.append(el('p', 'Nie ma jeszcze rzutów.'));
  }
  async function publish(id) {
    const entry = pending.find(item => item.id === id);
    if (!entry || publishing.has(id)) return;
    publishing.add(id); render();
    try {
      await store.publishRoll(entry);
      pending = pending.filter(item => item.id !== id); persist(); notice.textContent = 'Rzut opublikowany.';
      document.dispatchEvent(new CustomEvent('onejournal:roll-published', { detail: id }));
    } catch (error) {
      notice.textContent = 'Nie opublikowano rzutu. ' + error.message;
      throw error;
    } finally { publishing.delete(id); render(); }
  }
  function prepare(config, heroId) {
    if (!store.canWrite) throw new Error('Brak połączenia — rzut jest zablokowany.');
    if (store.access.role === 'player') {
      if (config.actor !== 'hero') throw new Error('Gracz może rzucać tylko swoim bohaterem.');
      heroId = store.access.heroId;
    }
    if (config.actor === 'hero' && !store.getState().heroes.some(h => h.id === heroId)) throw new Error('Wybierz bohatera dla rzutu.');
    return { id: crypto.randomUUID(), heroId: config.actor === 'hero' ? heroId : null, config: { ...config } };
  }
  function capture(prepared, raw) {
    const entry = { ...prepared, raw: JSON.parse(JSON.stringify(raw)) };
    DiceRules.interpretRoll(entry.config, entry.raw);
    pending.push(entry); persist(); render(); return entry.id;
  }
  store.subscribe(() => {
    for (const entry of store.rolls) {
      if (!seen.has(entry.id)) { seen.add(entry.id); toast(summary(entry)); }
    }
    render();
  });
  window.OneJournalRolls = { prepare, capture, publish, notify: toast, isPending: id => pending.some(entry => entry.id === id) };
  render();
})();
