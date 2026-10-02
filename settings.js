(function () {
  'use strict';
  const store = window.OneRingStore;
  const dialog = document.getElementById('settings');
  const avatars = window.OneRingAvatars;
  const connection = dialog.querySelector('.connection-settings');
  const playerRemove = document.createElement('button');
  playerRemove.type = 'button'; playerRemove.className = 'avatar-remove'; playerRemove.textContent = 'Usuń awatar'; playerRemove.hidden = true;
  const playerStatus = document.createElement('span');
  playerStatus.className = 'avatar-settings-status'; playerStatus.setAttribute('role', 'status');
  connection.append(playerRemove, playerStatus);
  const avatarFor = id => store.getState().heroes.find(hero => hero.id === id)?.avatarId;
  function syncAvatarActions() {
    const playerId = store.access.role === 'player' ? store.access.heroId : null;
    playerRemove.hidden = !playerId || !avatarFor(playerId);
    playerRemove.disabled = !store.canWrite || !!avatars?.isBusy(playerId);
    for (const button of dialog.querySelectorAll('[data-avatar-remove]')) {
      const id = button.dataset.avatarRemove;
      button.hidden = !avatarFor(id);
      button.disabled = !store.canWrite || !!avatars?.isBusy(id);
    }
  }
  playerRemove.onclick = async () => {
    const id = store.access.heroId;
    playerRemove.disabled = true;
    try { if (await avatars.remove(id)) playerStatus.textContent = 'Awatar usunięty.'; }
    catch (error) { playerStatus.textContent = error?.message || 'Nie udało się usunąć awatara.'; }
    finally { syncAvatarActions(); }
  };
  store.subscribe(syncAvatarActions);
  syncAvatarActions();
  document.getElementById('settings-open').onclick = () => {
    dialog.showModal(); dialog.querySelector('.journal-body').scrollTop = 0;
    if (store.access.role === 'gm') { render(); renderUsage(); }
    syncAvatarActions();
  };
  document.getElementById('settings-close').onclick = () => dialog.close();

  let outsidePress = false;
  const outside = event => {
    const r = dialog.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  };
  dialog.addEventListener('pointerdown', event => { outsidePress = event.target === dialog && outside(event); });
  dialog.addEventListener('pointerup', event => {
    if (outsidePress && event.target === dialog && outside(event)) dialog.close();
    outsidePress = false;
  });
  dialog.addEventListener('pointercancel', () => { outsidePress = false; });
  if (store.access.role !== 'gm') return;
  const host = document.getElementById('access-links'), status = document.getElementById('settings-status');
  const usageSection = document.getElementById('kompendium-usage'), usageBody = document.getElementById('kompendium-usage-body');
  usageSection.hidden = false;
  let usageGeneration = 0;
  async function renderUsage() {
    const token = ++usageGeneration;
    usageBody.textContent = 'Ładowanie kosztów…';
    try {
      const result = await window.OneJournalCompendium.request({ action: 'usage' });
      if (token !== usageGeneration || store.access.role !== 'gm' || store.connection === 'revoked') return;
      const money = value => '$' + (Number(value) || 0).toFixed(4);
      const number = value => (Number(value) || 0).toLocaleString('pl-PL');
      const rows = [
        ['Pytania', 'questions', number], ['Tokeny wejściowe', 'inputTokens', number],
        ['Tokeny wejściowe z pamięci podręcznej', 'cachedInputTokens', number],
        ['Tokeny wyjściowe', 'outputTokens', number], ['Koszt łączny', 'costUsd', money],
        ['Indeksowanie', 'indexingCostUsd', money], ['Rozmowy', 'conversationCostUsd', money],
        ['Niepełne żądania', 'incompleteRequests', number]
      ];
      const table = document.createElement('table');
      const header = document.createElement('tr');
      for (const text of ['Miara', 'Ten miesiąc', 'Cały okres']) { const cell = document.createElement('th'); cell.textContent = text; header.append(cell); }
      table.append(header);
      for (const [label, key, format] of rows) {
        const row = document.createElement('tr');
        for (const value of [label, format(result.month?.[key]), format(result.allTime?.[key])]) {
          const cell = document.createElement(row.childElementCount ? 'td' : 'th'); cell.textContent = value; row.append(cell);
        }
        table.append(row);
      }
      const model = document.createElement('p'); model.textContent = 'Model: ' + (result.model || 'nieznany');
      usageBody.replaceChildren(model, table);
      if (Number(result.month?.incompleteRequests) || Number(result.allTime?.incompleteRequests)) {
        const note = document.createElement('p'); note.textContent = 'Niepełne żądania mogły nadal wygenerować koszt.'; usageBody.append(note);
      }
    } catch (error) { if (token === usageGeneration && store.access.role === 'gm' && store.connection !== 'revoked') usageBody.textContent = error.message || 'Nie udało się pobrać kosztów.'; }
  }
  let generation = 0;
  const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  async function copyLink(input) {
    const value = input.value;
    if (!value) { status.textContent = 'Brak linku do skopiowania.'; return; }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Schowek niedostępny');
      await navigator.clipboard.writeText(value);
      status.textContent = 'Skopiowano link.';
      return;
    } catch (_) {
      input.focus(); input.select();
      try {
        if (document.execCommand('copy')) { status.textContent = 'Skopiowano link.'; return; }
      } catch (_) { /* The selected link remains available for manual copying. */ }
      status.textContent = 'Nie można skopiować automatycznie. Link jest zaznaczony — skopiuj go ręcznie.';
    }
  }
  async function render() {
    const token = ++generation;
    try {
      const response = await store.listLinks();
      if (token !== generation || store.access.role !== 'gm') return;
      const links = Array.isArray(response) ? response : response.links;
      host.replaceChildren();
      for (const hero of store.getState().heroes) {
        const grant = links.find(item => item.heroId === hero.id), row = el('article'); row.className = 'access-link';
        const heading = el('div'); heading.className = 'access-link-heading';
        heading.append(el('h3', hero.name));
        const removeAvatar = el('button', 'Usuń awatar');
        removeAvatar.type = 'button'; removeAvatar.className = 'avatar-remove'; removeAvatar.dataset.avatarRemove = hero.id;
        removeAvatar.hidden = !hero.avatarId;
        removeAvatar.disabled = !store.canWrite || !!avatars?.isBusy(hero.id);
        removeAvatar.onclick = async () => {
          removeAvatar.disabled = true;
          try { if (await avatars.remove(hero.id)) status.textContent = 'Awatar usunięty.'; }
          catch (error) { status.textContent = error?.message || 'Nie udało się usunąć awatara.'; }
          finally { syncAvatarActions(); }
        };
        heading.append(removeAvatar); row.append(heading);
        if (grant?.active && grant.secret) {
          const url = new URL(location.pathname, location.origin); url.hash = 'access=' + grant.secret;
          const input = el('input'); input.readOnly = true; input.value = url.href; input.setAttribute('aria-label', 'Link bohatera ' + hero.name);
          const copy = el('button', 'Kopiuj link'); copy.type = 'button'; copy.onclick = () => copyLink(input);
          row.append(input, copy);
          const revoke = el('button', 'Unieważnij'); revoke.type = 'button';
          revoke.onclick = () => act(() => store.revokeLink(hero.id), 'Unieważnić link i odebrać dostęp otwartym urządzeniom?');
          row.append(revoke);
        } else row.append(el('p', 'Brak aktywnego linku'));
        const rotate = el('button', grant?.active ? 'Wygeneruj nowy link' : 'Utwórz link'); rotate.type = 'button';
        rotate.onclick = () => act(() => store.rotateLink(hero.id), grant?.active ? 'Zastąpić link? Poprzedni link oraz jego sesje przestaną działać.' : null);
        row.append(rotate); host.append(row);
      }
      if (!store.getState().heroes.length) host.append(el('p', 'Najpierw utwórz bohatera w Drużynie.'));
      syncAvatarActions();
    } catch (error) { status.textContent = error.message; }
  }
  async function act(fn, question) {
    if (question && !confirm(question)) return;
    host.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await fn(); status.textContent = 'Zapisano zmianę dostępu.'; await render(); }
    catch (error) { status.textContent = error.message; }
    finally { host.querySelectorAll('button:not([data-avatar-remove])').forEach(button => { button.disabled = !store.canWrite; }); syncAvatarActions(); }
  }
  store.subscribe(() => { if (store.access.role !== 'gm' || store.connection === 'revoked') { host.replaceChildren(); usageGeneration++; usageBody.replaceChildren(); usageSection.hidden = true; } host.querySelectorAll('button:not([data-avatar-remove])').forEach(button => { button.disabled = !store.canWrite; }); syncAvatarActions(); });
})();
