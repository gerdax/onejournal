/* GM notebook. The server owns the document; this module keeps only an in-memory draft. */
(function () {
  'use strict';
  const store = window.OneRingStore;
  const state = window.OneRingState;
  const trigger = document.getElementById('notebook-open');
  if (!store || !trigger || store.access.role !== 'gm') return;

  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, id, title) => {
    const node = make('button', text);
    node.type = 'button'; node.id = id; node.title = title || text;
    return node;
  };
  const empty = () => ({ blocks: [] });
  const normalize = raw => state?.normalizeNotebook ? state.normalizeNotebook(raw) : (raw && Array.isArray(raw.blocks) ? raw : empty());
  const clone = value => JSON.parse(JSON.stringify(value));
  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'VIDEO', 'AUDIO', 'CANVAS', 'FORM', 'INPUT', 'BUTTON']);

  function addRun(runs, text, marks) {
    if (!text) return;
    const run = { text };
    if (marks.bold) run.bold = true;
    if (marks.italic) run.italic = true;
    if (marks.underline) run.underline = true;
    const last = runs[runs.length - 1];
    if (last && !!last.bold === !!run.bold && !!last.italic === !!run.italic && !!last.underline === !!run.underline) last.text += text;
    else runs.push(run);
  }
  function inline(node, runs, marks = {}) {
    if (node.nodeType === Node.TEXT_NODE) { addRun(runs, node.nodeValue, marks); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || skipTags.has(node.tagName)) return;
    if (node.tagName === 'BR') { addRun(runs, '\n', marks); return; }
    const tag = node.tagName;
    const style = node.style;
    const next = {
      bold: marks.bold || tag === 'B' || tag === 'STRONG' || /^(bold|bolder|[6-9]00)$/.test(style?.fontWeight || ''),
      italic: marks.italic || tag === 'I' || tag === 'EM' || style?.fontStyle === 'italic' || style?.fontStyle === 'oblique',
      underline: marks.underline || tag === 'U' || /\bunderline\b/.test(style?.textDecorationLine || style?.textDecoration || '')
    };
    for (const child of node.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && /^(P|DIV|UL|OL|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(child.tagName)
          && runs.length && !runs[runs.length - 1].text.endsWith('\n')) addRun(runs, '\n', next);
      inline(child, runs, next);
    }
  }
  function readBlocks(root, validate = true) {
    const blocks = [];
    let loose = [];
    const flush = () => { if (loose.length) { blocks.push({ type: 'paragraph', runs: loose }); loose = []; } };
    const visit = rootNode => { for (const node of rootNode.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) { inline(node, loose); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE || skipTags.has(node.tagName)) continue;
      if (node.tagName === 'HR') {
        flush(); blocks.push({ type: 'horizontalRule' });
      } else if (node.tagName === 'UL' || node.tagName === 'OL') {
        flush();
        const type = node.tagName === 'UL' ? 'bulletList' : 'orderedList';
        let items = [];
        const flushList = () => { if (items.length) { blocks.push({ type, items }); items = []; } };
        for (const child of node.children) {
          if (child.tagName !== 'LI') continue;
          if (!Array.from(child.children).some(element => element.tagName === 'HR')) {
            const runs = []; inline(child, runs); items.push(runs);
            continue;
          }
          let runs = [];
          for (const part of child.childNodes) {
            if (part.nodeType === Node.ELEMENT_NODE && part.tagName === 'HR') {
              if (runs.length) items.push(runs);
              flushList(); blocks.push({ type: 'horizontalRule' }); runs = [];
            } else {
              if (part.nodeType === Node.ELEMENT_NODE && /^(P|DIV|UL|OL|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(part.tagName)
                  && runs.length && !runs[runs.length - 1].text.endsWith('\n')) addRun(runs, '\n', {});
              inline(part, runs);
            }
          }
          if (runs.length) items.push(runs);
        }
        flushList();
      } else if (/^(P|DIV|H[1-6]|BLOCKQUOTE|PRE|LI)$/.test(node.tagName)) {
        flush();
        if (Array.from(node.children).some(child => /^(P|DIV|UL|OL|HR|H[1-6]|BLOCKQUOTE|PRE)$/.test(child.tagName))) visit(node);
        else { const runs = []; inline(node, runs); blocks.push({ type: 'paragraph', runs }); }
      } else {
        if (Array.from(node.children).some(child => /^(P|DIV|UL|OL|HR|H[1-6]|BLOCKQUOTE|PRE)$/.test(child.tagName))) { flush(); visit(node); }
        else inline(node, loose);
      }
    } };
    visit(root);
    flush();
    return validate ? normalize({ blocks }) : { blocks };
  }
  function renderRuns(parent, runs) {
    for (const run of runs || []) {
      const content = document.createDocumentFragment();
      const parts = (run.text || '').split('\n');
      parts.forEach((part, index) => { if (index) content.append(make('br')); if (part) content.append(document.createTextNode(part)); });
      let node = content;
      if (run.underline) { const wrap = make('u'); wrap.append(node); node = wrap; }
      if (run.italic) { const wrap = make('em'); wrap.append(node); node = wrap; }
      if (run.bold) { const wrap = make('strong'); wrap.append(node); node = wrap; }
      parent.append(node);
    }
  }
  function renderDocument(target, documentValue) {
    target.replaceChildren();
    for (const block of documentValue.blocks || []) {
      if (block.type === 'paragraph') {
        const p = make('p'); renderRuns(p, block.runs);
        if (!p.childNodes.length) p.append(make('br'));
        target.append(p);
      } else if (block.type === 'horizontalRule') {
        target.append(make('hr'));
      } else if (block.type === 'bulletList' || block.type === 'orderedList') {
        const list = make(block.type === 'bulletList' ? 'ul' : 'ol');
        for (const runs of block.items || []) {
          const li = make('li'); renderRuns(li, runs);
          if (!li.childNodes.length) li.append(make('br'));
          list.append(li);
        }
        target.append(list);
      }
    }
  }
  function asText(documentValue) {
    return (documentValue.blocks || []).map(block => block.type === 'paragraph'
      ? (block.runs || []).map(run => run.text).join('')
      : block.type === 'horizontalRule' ? '──────────'
      : (block.items || []).map((runs, i) => (block.type === 'bulletList' ? '• ' : `${i + 1}. `) + runs.map(run => run.text).join('')).join('\n')).join('\n');
  }

  const dialog = make('dialog', null, 'notebook-dialog');
  dialog.setAttribute('aria-labelledby', 'notebook-heading');
  const head = make('div', null, 'journal-head notebook-head');
  const heading = make('h2', 'Zapiski'); heading.id = 'notebook-heading';
  const close = button('×', 'notebook-close', 'Zamknij zapiski'); close.setAttribute('aria-label', 'Zamknij zapiski');
  head.append(heading, close);
  const toolbar = make('div', null, 'notebook-toolbar'); toolbar.id = 'notebook-toolbar'; toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Formatowanie');
  const commands = [
    ['bold', 'B', 'Pogrubienie'], ['italic', 'I', 'Kursywa'], ['underline', 'U', 'Podkreślenie'],
    ['insertUnorderedList', '•', 'Lista punktowana'], ['insertOrderedList', '1.', 'Lista numerowana'],
    ['horizontalRule', '―', 'Linia pozioma']
  ];
  for (const [command, label, title] of commands) {
    const control = button(label, 'notebook-' + command, title); control.dataset.command = command;
    control.setAttribute('aria-label', title); control.setAttribute('aria-pressed', 'false');
    toolbar.append(control);
  }
  const body = make('div', null, 'notebook-body');
  const editor = make('div', null, 'notebook-editor'); editor.id = 'notebook-editor';
  editor.contentEditable = 'true'; editor.setAttribute('role', 'textbox'); editor.setAttribute('aria-label', 'Treść zapisków'); editor.setAttribute('aria-multiline', 'true'); editor.dataset.placeholder = 'Zapisz swoje notatki…';
  body.append(editor);
  const conflict = make('div', null, 'notebook-conflict'); conflict.id = 'notebook-conflict'; conflict.hidden = true;
  conflict.append(make('p', 'Zapiski zmieniły się w innej sesji. Zachowaliśmy Twoją wersję w tej karcie.'));
  const reload = button('Wczytaj wersję z serwera', 'notebook-reload');
  const replace = button('Zastąp wersję na serwerze', 'notebook-replace');
  conflict.append(reload, replace); body.append(conflict);
  const foot = make('div', null, 'notebook-foot');
  const status = make('span', 'Gotowy', 'notebook-status'); status.id = 'notebook-status'; status.setAttribute('role', 'status');
  const retry = button('Ponów zapis', 'notebook-retry'); retry.hidden = true;
  const icon = (buttonNode, paths) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path); }
    buttonNode.append(svg);
  };
  const copy = button(null, 'notebook-copy', 'Kopiuj całość'); copy.setAttribute('aria-label', 'Kopiuj całość');
  icon(copy, ['M8 5h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'M3 17V4a2 2 0 0 1 2-2h11']);
  const clear = button(null, 'notebook-clear', 'Wyczyść zapiski'); clear.setAttribute('aria-label', 'Wyczyść zapiski');
  icon(clear, ['M4 6h16', 'M9 6V4h6v2', 'M6 6l1 15h10l1-15', 'M10 10v7', 'M14 10v7']);
  foot.append(toolbar, status, retry, copy, clear);
  dialog.append(head, body, foot); document.body.append(dialog);

  const confirm = make('dialog', null, 'notebook-clear-confirm'); confirm.id = 'notebook-clear-confirm'; confirm.setAttribute('aria-labelledby', 'notebook-clear-heading');
  const confirmHeading = make('h2', 'Wyczyścić wszystkie zapiski?'); confirmHeading.id = 'notebook-clear-heading';
  const confirmCancel = button('Anuluj', 'notebook-clear-cancel');
  const confirmGo = button('Wyczyść', 'notebook-clear-go');
  confirm.append(confirmHeading, make('p', 'Wszystkie zapiski zostaną usunięte.'), confirmCancel, confirmGo);
  document.body.append(confirm);

  let draft = empty(), version = 0, revision = 0, savedRevision = 0;
  let saveTimer = null, saving = null, clearing = false, conflictMode = false, errorText = '', opener = null;
  let active = true;
  let outsideDown = false;
  let unsubscribe = () => {};
  function isDirty() { return revision !== savedRevision; }
  function setStatus(message) { status.textContent = message; }
  function isEmpty() {
    return !(draft.blocks || []).some(block => block.type === 'horizontalRule' ||
      (block.type === 'paragraph' ? [block.runs] : block.items || [])
        .some(runs => (runs || []).some(run => (run.text || '').trim())));
  }
  function updateUI() {
    const writable = active && store.canWrite && !clearing && !conflictMode;
    editor.contentEditable = writable ? 'true' : 'false';
    toolbar.querySelectorAll('button').forEach(node => { node.disabled = !writable; });
    copy.disabled = !active || isEmpty();
    clear.disabled = !active || !store.canWrite || isEmpty() || clearing || conflictMode;
    retry.hidden = !errorText || !isDirty() || conflictMode || !active;
    retry.disabled = !store.canWrite || !!saving || clearing;
    conflict.hidden = !conflictMode;
    reload.disabled = !store.canWrite || clearing;
    replace.disabled = !store.canWrite || clearing || !!saving;
    if (!active) setStatus('');
    else if (clearing) setStatus('Czyszczenie…');
    else if (conflictMode) setStatus('Konflikt zapisu');
    else if (!store.canWrite) setStatus('Brak połączenia' + (isDirty() ? ' — szkic zachowany w tej karcie' : ''));
    else if (saving) setStatus('Zapisywanie…');
    else if (errorText) setStatus('Nie zapisano: ' + errorText);
    else setStatus(isDirty() ? 'Niezapisane zmiany' : 'Zapisano');
  }
  function loadFromStore() {
    if (!active) return;
    const remote = store.notebook || { document: empty(), version: 0 };
    if (!remote || !Number.isSafeInteger(remote.version)) return;
    draft = clone(normalize(remote.document)); version = remote.version;
    revision++; savedRevision = revision; errorText = ''; conflictMode = false;
    renderDocument(editor, draft); updateUI();
  }
  function forget() {
    clearTimeout(saveTimer); saveTimer = null;
    draft = empty(); version = 0; revision++; savedRevision = revision;
    errorText = ''; conflictMode = false; active = false;
    editor.replaceChildren(); editor.contentEditable = 'false';
    if (confirm.open) confirm.close();
    if (dialog.open) dialog.close();
    updateUI();
    unsubscribe();
    document.removeEventListener('selectionchange', updateFormat);
    window.removeEventListener('beforeunload', beforeUnload);
    trigger.removeEventListener('click', openNotebook);
    dialog.remove(); confirm.remove();
  }
  function scheduleSave(restart = false) {
    if (restart && saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    if (!isDirty() || conflictMode || clearing || !store.canWrite || !active) return;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => { saveTimer = null; save().catch(() => {}); }, 1000);
  }
  function edited() {
    if (!active || clearing || conflictMode || !store.canWrite) return;
    draft = readBlocks(editor, false); revision++;
    try { normalize(draft); errorText = ''; scheduleSave(true); }
    catch (error) { clearTimeout(saveTimer); saveTimer = null; errorText = error.message || 'Zapiski przekraczają limit rozmiaru'; }
    updateUI();
  }
  async function save() {
    if (saving || !active || clearing || conflictMode || !isDirty() || !store.canWrite) return saving;
    clearTimeout(saveTimer); saveTimer = null;
    let sendingDocument;
    try { sendingDocument = normalize(draft); }
    catch (error) { errorText = error.message || 'Zapiski przekraczają limit rozmiaru'; updateUI(); return; }
    const sendingRevision = revision, sendingVersion = version;
    const operation = store.saveNotebook(sendingDocument, sendingVersion);
    saving = operation; updateUI();
    try {
      const result = await operation;
      if (!active) return;
      version = result.version;
      savedRevision = sendingRevision;
      errorText = '';
    } catch (error) {
      if (!active) return;
      if (error.status === 409) conflictMode = true;
      else errorText = error.message || 'Błąd połączenia';
      throw error;
    } finally {
      if (saving === operation) saving = null;
      updateUI();
      if (active && isDirty() && !conflictMode && !errorText) scheduleSave();
    }
  }
  function maybeAcceptRemote() {
    const role = store.access.role;
    if (role !== 'gm' || store.connection === 'revoked') { if (active || dialog.open) forget(); return; }
    if (!active) { active = true; loadFromStore(); return; }
    if (!store.canWrite) { updateUI(); return; }
    const remote = store.notebook;
    if (remote && Number.isSafeInteger(remote.version) && remote.version !== version && !saving) {
      if (isDirty()) { conflictMode = true; clearTimeout(saveTimer); saveTimer = null; }
      else loadFromStore();
    }
    updateUI();
    if (isDirty() && !saving && !conflictMode && !errorText) scheduleSave();
  }

  function openNotebook() {
    if (!active || store.access.role !== 'gm') return;
    opener = document.activeElement;
    if (!isDirty()) loadFromStore();
    dialog.showModal(); editor.focus(); updateUI();
  }
  trigger.addEventListener('click', openNotebook);
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (confirm.open) confirm.close();
    if (isDirty()) save().catch(() => {});
    if (opener?.isConnected) opener.focus();
  });
  const outside = event => { const r = dialog.getBoundingClientRect(); return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom; };
  dialog.addEventListener('pointerdown', event => { outsideDown = event.target === dialog && outside(event); });
  dialog.addEventListener('pointerup', event => { if (outsideDown && event.target === dialog && outside(event)) dialog.close(); outsideDown = false; });
  dialog.addEventListener('pointercancel', () => { outsideDown = false; });
  toolbar.addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
  toolbar.addEventListener('click', event => {
    const control = event.target.closest('[data-command]');
    if (!control || control.disabled) return;
    editor.focus();
    if (control.dataset.command === 'horizontalRule') document.execCommand('insertHTML', false, '<hr>');
    else document.execCommand(control.dataset.command, false, null);
    edited(); updateFormat();
  });
  function updateFormat() {
    if (!dialog.open || document.activeElement !== editor) return;
    for (const control of toolbar.querySelectorAll('[data-command]')) {
      let selected = false;
      if (control.dataset.command !== 'horizontalRule') {
        try { selected = document.queryCommandState(control.dataset.command); } catch (_) {}
      }
      control.setAttribute('aria-pressed', String(!!selected));
    }
  }
  document.addEventListener('selectionchange', updateFormat);
  editor.addEventListener('input', edited);
  editor.addEventListener('paste', event => {
    event.preventDefault();
    if (!store.canWrite || conflictMode) return;
    try {
      const html = event.clipboardData?.getData('text/html');
      if (html) {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const safeDoc = readBlocks(parsed.body);
        const container = make('div'); renderDocument(container, safeDoc);
        const safeHtml = Array.from(container.childNodes, node => node.outerHTML).join('');
        if (safeHtml) document.execCommand('insertHTML', false, safeHtml);
      } else {
        document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') || '');
      }
      edited();
    } catch (error) {
      errorText = error.message || 'Nie wklejono treści'; updateUI();
    }
  });
  editor.addEventListener('drop', event => event.preventDefault());
  editor.addEventListener('dragover', event => event.preventDefault());
  copy.addEventListener('click', async () => {
    if (copy.disabled) return;
    const container = make('div'); renderDocument(container, draft);
    const html = Array.from(container.childNodes, node => node.outerHTML).join('');
    const plain = asText(draft);
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
      } else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(plain);
      else throw new Error('Schowek jest niedostępny.');
      setStatus('Skopiowano wszystkie zapiski');
    } catch (error) { setStatus('Nie skopiowano: ' + (error.message || 'Błąd schowka')); }
  });
  clear.addEventListener('click', () => { if (!clear.disabled) confirm.showModal(); });
  confirmCancel.addEventListener('click', () => confirm.close());
  confirmGo.addEventListener('click', async () => {
    if (clearing || !active || !store.canWrite) return;
    clearing = true; clearTimeout(saveTimer); saveTimer = null; updateUI();
    try {
      if (saving) await saving.catch(() => {});
      if (!active || !store.canWrite) throw new Error('Brak połączenia.');
      const result = await store.saveNotebook(empty(), version);
      if (!active) return;
      version = result.version; draft = empty(); revision++; savedRevision = revision;
      errorText = ''; conflictMode = false; renderDocument(editor, draft);
      confirm.close();
    } catch (error) {
      if (active) { if (error.status === 409) conflictMode = true; else errorText = error.message || 'Błąd połączenia'; }
      confirm.close();
    } finally { clearing = false; updateUI(); }
  });
  retry.addEventListener('click', () => { errorText = ''; save().catch(() => {}); });
  reload.addEventListener('click', async () => {
    if (!store.canWrite) return;
    try { await store.refresh(); if (active) loadFromStore(); }
    catch (error) { errorText = error.message || 'Nie wczytano'; updateUI(); }
  });
  replace.addEventListener('click', async () => {
    if (!store.canWrite || saving) return;
    try {
      await store.refresh();
      if (!active || !store.canWrite) return;
      const remote = store.notebook;
      if (!remote || !Number.isSafeInteger(remote.version)) throw new Error('Brak wersji z serwera.');
      version = remote.version; conflictMode = false; errorText = '';
      if (!isDirty()) revision++;
      updateUI(); await save();
    } catch (error) { if (active && !conflictMode) errorText = error.message || 'Nie zapisano'; updateUI(); }
  });
  function beforeUnload(event) { if (active && isDirty()) { event.preventDefault(); event.returnValue = ''; } }
  window.addEventListener('beforeunload', beforeUnload);
  unsubscribe = store.subscribe(maybeAcceptRemote);
  if (active) loadFromStore(); else updateUI();
})();
