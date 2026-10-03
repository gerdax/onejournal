/* GM reference conversation: all questions and answers live only in this tab. */
(function () {
  'use strict';
  const store = window.OneRingStore, api = window.OneJournalCompendium;
  const trigger = document.getElementById('kompendium-open');
  if (!store || !api || store.access.role !== 'gm' || !trigger) return;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const dialog = el('dialog', 'kompendium-dialog');
  dialog.setAttribute('aria-labelledby', 'kompendium-heading');
  const head = el('div', 'journal-head');
  const heading = el('h2', '', 'Kompendium'); heading.id = 'kompendium-heading';
  const close = el('button', 'journal-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Zamknij Kompendium');
  head.append(heading, close);
  const thread = el('div', 'kompendium-thread'); thread.setAttribute('aria-live', 'polite');
  const form = el('form', 'kompendium-form');
  const label = el('label', '', 'Zapytaj o zasady lub świat gry'); label.htmlFor = 'kompendium-question';
  const question = el('textarea'); question.id = 'kompendium-question'; question.rows = 3; question.maxLength = 2000;
  question.placeholder = 'Zapytaj o zasady lub świat gry…'; question.required = true;
  const keyHint = el('p', 'kompendium-key-hint', 'Enter — wyślij · Shift+Enter — nowa linia');
  keyHint.id = 'kompendium-key-hint'; question.setAttribute('aria-describedby', keyHint.id);
  question.title = keyHint.textContent;
  const foot = el('div', 'kompendium-form-foot');
  const status = el('span', 'kompendium-status', 'Gotowe'); status.setAttribute('role', 'status');
  const retry = el('button', '', 'Ponów'); retry.type = 'button'; retry.hidden = true;
  const send = el('button', 'primary', 'Zapytaj'); send.type = 'submit';
  foot.append(status, retry, send); form.append(label, question, keyHint, foot); dialog.append(head, thread, form); document.body.append(dialog);
  let history = [], controller = null, lastQuestion = '', generation = 0, opener = null;
  const handoffs = new Set();
  let readerWindow = null;
  const nearBottom = () => thread.scrollHeight - thread.clientHeight - thread.scrollTop <= 64;
  const followBottom = follow => { if (follow) thread.scrollTop = thread.scrollHeight; };
  function clear() {
    generation++; controller?.abort(); controller = null; history = []; lastQuestion = '';
    for (const handoff of handoffs) { clearTimeout(handoff.timer); handoff.channel.close(); }
    handoffs.clear(); question.value = ''; question.disabled = true; send.disabled = true;
    thread.replaceChildren(); status.textContent = 'Dostęp cofnięty'; retry.hidden = true;
    trigger.hidden = true; if (dialog.open) dialog.close();
  }
  store.subscribe(() => { if (store.connection === 'revoked' || store.access.role !== 'gm') clear(); });
  trigger.onclick = () => { opener = trigger; if (!dialog.open) dialog.showModal(); question.focus(); };
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => { if (opener?.isConnected && !opener.hidden) opener.focus(); });
  let outsideDown = false;
  const outside = event => { const box = dialog.getBoundingClientRect(); return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom; };
  dialog.addEventListener('pointerdown', event => { outsideDown = event.target === dialog && outside(event); });
  dialog.addEventListener('pointerup', event => { if (outsideDown && event.target === dialog && outside(event)) dialog.close(); outsideDown = false; });
  dialog.addEventListener('pointercancel', () => { outsideDown = false; });
  function showSources(host, sources) {
    if (!Array.isArray(sources) || !sources.length) return;
    const list = el('div', 'kompendium-sources'); list.append(el('strong', '', 'Źródła: '));
    for (const source of sources) {
      if (!source || !source.documentId || !Number.isInteger(source.pdfPage) || source.pdfPage < 1) continue;
      const link = el('a', '', [source.section, source.bookPage && `s. ${source.bookPage}`].filter(Boolean).join(' · ') || `Strona ${source.pdfPage}`);
      link.href = 'reader.html'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.addEventListener('click', event => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        if (!window.BroadcastChannel) { status.textContent = 'Przeglądarka nie obsługuje otwierania źródeł.'; return; }
        // A new source supersedes any ticket still being prepared for the previous one.
        for (const handoff of handoffs) { clearTimeout(handoff.timer); handoff.channel.close(); }
        handoffs.clear();
        const id = crypto.randomUUID(), channel = new BroadcastChannel('onejournal-reader-' + id);
        const handoff = { channel, timer: null };
        handoffs.add(handoff);
        handoff.timer = setTimeout(() => { handoffs.delete(handoff); channel.close(); status.textContent = 'Czytnik nie odpowiedział. Sprawdź blokadę wyskakujących okien.'; }, 15000);
        let issued = false;
        channel.onmessage = async incoming => {
          if (incoming.data?.type !== 'ready' || issued || !handoffs.has(handoff)) return;
          issued = true;
          try {
            const result = await api.request({ action: 'ticket', documentId: source.documentId, pdfPage: source.pdfPage });
            if (handoffs.has(handoff)) channel.postMessage({ type: 'ticket', ticket: result.ticket });
          } catch (error) { if (handoffs.has(handoff)) { channel.postMessage({ type: 'error', error: error.message }); status.textContent = error.message; } }
          finally { clearTimeout(handoff.timer); handoffs.delete(handoff); setTimeout(() => channel.close(), 1000); }
        };
        // A distinct query forces a fresh ticket exchange instead of hash-only navigation.
        const url = `reader.html?open=${encodeURIComponent(id)}#channel=${encodeURIComponent(id)}`;
        try {
          if (!readerWindow || readerWindow.closed) {
            // Keep our handle for reuse, but remove the reader's access to the game tab
            // before loading any content. No invitation/session token enters its URL.
            readerWindow = window.open('about:blank', '_blank');
            if (!readerWindow) throw new Error('Sprawdź blokadę wyskakujących okien.');
            readerWindow.opener = null;
          }
          readerWindow.location.replace(url);
          readerWindow.focus();
        } catch (_) {
          clearTimeout(handoff.timer); handoffs.delete(handoff); channel.close();
          readerWindow = null;
          status.textContent = 'Nie udało się otworzyć czytnika. Kliknij źródło ponownie i sprawdź blokadę wyskakujących okien.';
        }
      });
      link.addEventListener('auxclick', event => {
        if (event.button === 1) { event.preventDefault(); link.click(); }
      });
      list.append(link, document.createTextNode(' '));
    }
    host.append(list);
  }
  async function ask(value) {
    if (controller || store.connection === 'revoked' || store.access.role !== 'gm') return;
    const prompt = value.trim(); if (!prompt) return;
    lastQuestion = prompt; retry.hidden = true;
    const turn = el('article', 'kompendium-turn');
    turn.append(el('p', 'kompendium-prompt', prompt));
    const answer = el('p', 'kompendium-answer'); turn.append(answer); thread.append(turn);
    thread.scrollTop = thread.scrollHeight;
    const requestHistory = history.slice(-6).map(item => ({ role: item.role, content: item.content, sources: item.sources || [] }));
    controller = new AbortController(); const active = controller, token = generation;
    send.disabled = true; question.disabled = true; status.textContent = 'Szukam w książkach…';
    try {
      const done = await api.request({ action: 'ask', question: prompt, history: requestHistory }, {
        signal: active.signal, onEvent(type, payload) {
          if (token !== generation) return;
          if (type === 'status') status.textContent = payload.message || 'Pracuję…';
          if (type === 'delta') {
            const follow = nearBottom();
            answer.textContent = payload.text || '';
            status.textContent = 'Odpowiedź wstępna — trwa sprawdzanie…';
            followBottom(follow);
          }
        }
      });
      if (token !== generation) return;
      const follow = nearBottom();
      answer.textContent = done.answer || '';
      if (done.insufficient_context) turn.append(el('p', 'kompendium-caution', 'W udostępnionych źródłach brak wystarczającej odpowiedzi.'));
      showSources(turn, done.sources);
      followBottom(follow);
      history.push({ role: 'user', content: prompt }, { role: 'assistant', content: done.answer || '', sources: (done.sources || []).map(item => ({ chunkId: item.chunkId })).filter(item => item.chunkId) });
      question.value = ''; status.textContent = 'Gotowe';
    } catch (error) {
      if (token !== generation) return;
      const follow = nearBottom();
      answer.textContent = ''; turn.append(el('p', 'kompendium-error', error.message || 'Nie udało się uzyskać odpowiedzi.'));
      followBottom(follow);
      status.textContent = 'Pytanie nie powiodło się'; retry.hidden = false;
    } finally {
      if (token === generation) { controller = null; send.disabled = false; question.disabled = false; }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); ask(question.value); });
  question.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (event.repeat || !question.value.trim() || controller || question.disabled) return;
    form.requestSubmit(send);
  });
  retry.onclick = () => ask(lastQuestion);
})();
