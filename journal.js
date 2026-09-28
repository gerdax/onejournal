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
  const head = el('div', null, 'journal-head'), close = el('button', 'Zamknij');
  head.append(el('h2', 'Dziennik rzutów'), close);
  const list = el('div'), notice = el('p'); notice.setAttribute('role', 'status');
  dialog.append(head, notice, list); document.body.append(dialog);
  close.onclick = () => dialog.close();
  document.getElementById('journal-open').onclick = () => { render(); dialog.showModal(); };
  function persist() { try { sessionStorage.setItem(pendingKey, JSON.stringify(pending)); } catch (_) {} }
  function verdict(result) {
    if (result.automaticFailure) return 'automatyczna porażka';
    if (result.automaticSuccess) return 'automatyczny sukces';
    return result.passed === true ? 'sukces' : result.passed === false ? 'porażka' : 'bez PT';
  }
  function title(entry) { return (entry.authorRole === 'gm' && entry.actor === 'hero' ? 'MG za ' : '') + (entry.heroName || entry.name || (entry.actor === 'enemy' ? 'Wróg · prywatny rzut MG' : 'Bohater')); }
  function summary(entry) { return `${title(entry)}: ${entry.result.sum} — ${verdict(entry.result)}`; }
  function toast(text) {
    document.querySelector('.journal-toast')?.remove(); clearTimeout(toastTimer);
    const node = el('div', text, 'journal-toast'); node.setAttribute('role', 'status'); document.body.append(node);
    toastTimer = setTimeout(() => node.remove(), 6000);
  }
  function render() {
    if (!store.access.role) { list.replaceChildren(); pending = []; sessionStorage.removeItem(pendingKey); return; }
    list.replaceChildren();
    for (const entry of pending) {
      const row = el('article', null, 'journal-entry'); row.append(el('h3', 'Rzut oczekuje na publikację'));
      const result = DiceRules.interpretRoll(entry.config, entry.raw);
      row.append(el('p', `Wynik: ${result.sum} — ${verdict(result)}. Ponowienie nie losuje nowych kości.`));
      const retry = el('button', publishing.has(entry.id) ? 'Publikowanie…' : 'Ponów publikację'); retry.disabled = !store.canWrite || publishing.has(entry.id);
      retry.onclick = () => publish(entry.id).catch(() => {}); row.append(retry); list.append(row);
    }
    for (const entry of store.rolls.slice().reverse()) {
      const row = el('article', null, 'journal-entry'); row.dataset.rollId = entry.id;
      row.append(el('h3', title(entry)), el('p', `${entry.result.sum} — ${verdict(entry.result)} · znaki sukcesu: ${entry.result.marks}`));
      row.append(el('small', new Date(entry.createdAt || entry.at).toLocaleString('pl-PL')));
      const details = el('details'); details.append(el('summary', 'Kości i ustawienia'));
      details.append(el('p', 'Kość Działania: ' + entry.raw.feat.map(DiceRules.featLabel).join(', ')), el('p', 'Kości sukcesu: ' + (entry.raw.success.join(', ') || 'brak')));
      const c = entry.config;
      details.append(el('p', `Pula bazowa: ${c.baseDice}; premia/kara: ${c.bonus}; PT: ${c.target === '' || c.target == null ? 'brak' : c.target}; Kość Działania: ${{ normal: 'normalna', weary: 'osłabiona', favoured: 'wzmocniona' }[c.featMode]}`));
      const flags = [['exhausted', 'Wyczerpanie'], ['miserable', 'Przygnębienie'], ['hope', 'Nadzieja'], ['inspired', 'Natchnienie'], ['enemyResource', 'Nienawiść/Determinacja']].filter(([key]) => c[key]).map(([, label]) => label);
      if (flags.length) details.append(el('p', flags.join(' · ')));
      row.append(details); list.append(row);
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
  window.OneJournalRolls = { prepare, capture, publish, isPending: id => pending.some(entry => entry.id === id) };
  render();
})();
