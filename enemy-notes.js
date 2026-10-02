/* GM-only encounter notes. Drafts and pending writes belong to an enemy ID. */
(function (root) {
  'use strict';
  root.OneRingEnemyNotes = { mount(host, store) {
    const drafts = new Map(); let active = null;
    const label = document.createElement('label'); label.textContent = 'Notatki przeciwnika';
    const input = document.createElement('textarea'); input.rows = 5; label.append(input);
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Ponów zapis szkicu';
    const accept = document.createElement('button'); accept.type = 'button'; accept.textContent = 'Przyjmij treść serwera';
    host.classList.add('enemy-notes-editor'); host.append(label, status, retry, accept);
    const current = id => store.getState().battle.find(e => e.id === id);
    function paint() {
      const draft = drafts.get(active); if (!draft) return;
      if (input.value !== draft.text) input.value = draft.text;
      input.disabled = !current(active);
      status.textContent = draft.saving ? 'Zapisywanie…' : draft.error || (draft.text !== draft.base ? 'Niezapisany szkic' : 'Zapisano');
      retry.textContent = draft.conflict ? 'Zapisz szkic zamiast treści serwera' : 'Ponów zapis szkicu';
      retry.hidden = !draft.error; retry.disabled = draft.saving || !store.canWrite || !current(active);
      accept.hidden = !draft.conflict; accept.disabled = draft.saving;
    }
    function schedule(id) {
      const draft = drafts.get(id); clearTimeout(draft.timer);
      draft.timer = setTimeout(() => save(id), 500);
    }
    async function save(id) {
      const draft = drafts.get(id);
      if (draft.saving || draft.conflict || draft.text === draft.base) return;
      if (!current(id)) { draft.error = 'Przeciwnik został usunięty. Szkic zachowano.'; if (active === id) paint(); return; }
      const sent = draft.text, expected = draft.base;
      draft.saving = true; draft.error = ''; if (active === id) paint();
      try {
        await store.setEnemyNotes(id, sent, expected);
        draft.base = sent; draft.error = '';
      } catch (error) {
        draft.conflict = error.status === 409;
        draft.error = draft.conflict ? 'Konflikt: notatki zmieniono w innym oknie. Zachowano Twój szkic.' : 'Nie zapisano. Zachowano szkic. ' + error.message;
      } finally {
        draft.saving = false;
        if (!draft.error && draft.text !== draft.base) schedule(id);
        if (active === id) paint();
      }
    }
    input.addEventListener('input', () => {
      const draft = drafts.get(active); if (!draft) return;
      draft.text = input.value;
      if (!draft.conflict) { draft.error = ''; schedule(active); }
      paint();
    });
    retry.addEventListener('click', () => {
      const draft = drafts.get(active), enemy = current(active); if (!draft || !enemy) return;
      draft.base = enemy.notes; draft.conflict = false; draft.error = ''; save(active); paint();
    });
    accept.addEventListener('click', () => {
      const draft = drafts.get(active), enemy = current(active); if (!draft || !enemy) return;
      clearTimeout(draft.timer); draft.text = draft.base = enemy.notes; draft.conflict = false; draft.error = ''; paint();
    });
    return { show(id) {
      active = id;
      if (!id || store.access?.role !== 'gm') return;
      const enemy = current(id); if (!enemy) return;
      let draft = drafts.get(id);
      if (!draft) { draft = { text: enemy.notes, base: enemy.notes, saving: false, conflict: false, error: '' }; drafts.set(id, draft); }
      if (!draft.saving && enemy.notes !== draft.base) {
        if (draft.text === draft.base) { draft.text = draft.base = enemy.notes; draft.error = ''; }
        else { clearTimeout(draft.timer); draft.conflict = true; draft.error = 'Konflikt: notatki zmieniono w innym oknie. Zachowano Twój szkic.'; }
      }
      paint();
    } };
  } };
})(window);
