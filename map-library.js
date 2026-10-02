/* GM map library, image preparation and private image display. */
(function (root) {
  'use strict';
  const doc = root.document;
  if (!doc) return;
  const MAX_FILE = 20 * 1024 * 1024;
  const MAX_PIXELS = 40_000_000;
  const MAX_IMAGE = 2 * 1024 * 1024;
  const imageCache = new Map();
  let activeRequest = 0, pendingActiveId = null;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const errorText = error => error?.message || 'Nie udało się wykonać operacji.';
  const imageBytes = dataUrl => Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * .75);
  function getImage(store, id) {
    if (!imageCache.has(id)) imageCache.set(id, Promise.resolve().then(() => store.getMapImage(id)).then(result => {
      if (!result?.dataUrl) throw new Error('Nie udało się pobrać obrazu mapy.');
      return result.dataUrl;
    }).catch(error => { imageCache.delete(id); throw error; }));
    return imageCache.get(id);
  }
  function showActiveImage(map, terrainSvg, store) {
    if (map?.kind !== 'image' || !map.imageId) { activeRequest++; pendingActiveId = null; return; }
    if (pendingActiveId === map.imageId || terrainSvg.querySelector('image')?.dataset.imageId === map.imageId) return;
    const request = ++activeRequest;
    pendingActiveId = map.imageId;
    const backing = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    backing.setAttribute('width', map.width);
    backing.setAttribute('height', map.height);
    backing.setAttribute('fill', '#c4b595');
    terrainSvg.append(backing);
    getImage(store, map.imageId).then(dataUrl => {
      if (request !== activeRequest || store.getState().map?.imageId !== map.imageId) return;
      pendingActiveId = null;
      const image = doc.createElementNS('http://www.w3.org/2000/svg', 'image');
      image.setAttribute('href', dataUrl);
      image.dataset.imageId = map.imageId;
      image.setAttribute('width', map.width);
      image.setAttribute('height', map.height);
      image.setAttribute('preserveAspectRatio', 'none');
      terrainSvg.replaceChildren(image);
      const box = doc.getElementById('map-error');
      if (box?.textContent.startsWith('Nie udało się wczytać mapy:')) { box.textContent = ''; box.hidden = true; }
    }).catch(error => {
      if (request !== activeRequest || store.getState().map?.imageId !== map.imageId) return;
      pendingActiveId = null;
      const box = doc.getElementById('map-error');
      box.textContent = 'Nie udało się wczytać mapy: ' + errorText(error);
      box.hidden = false;
    });
  }
  function readBitmap(file) {
    return root.createImageBitmap(file).catch(() => { throw new Error('Nie można odczytać obrazu.'); });
  }
  function squareCanvas(bitmap, size) {
    const canvas = doc.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Nie można przygotować obrazu.');
    context.fillStyle = '#e9ddc4';
    context.fillRect(0, 0, size, size);
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    return canvas;
  }
  function jpegWithin(canvas, limit) {
    for (const quality of [.9, .82, .74, .66, .58, .5]) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (imageBytes(dataUrl) <= limit) return dataUrl;
    }
    throw new Error('Obraz po obróbce przekracza dopuszczalny rozmiar.');
  }
  async function prepare(file) {
    if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('Wybierz plik JPG lub PNG.');
    if (file.size > MAX_FILE) throw new Error('Plik przekracza limit 20 MiB.');
    const bitmap = await readBitmap(file);
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_PIXELS) throw new Error('Obraz przekracza limit 40 megapikseli.');
      return { dataUrl: jpegWithin(squareCanvas(bitmap, 1024), MAX_IMAGE), thumbnailDataUrl: jpegWithin(squareCanvas(bitmap, 384), 256 * 1024) };
    } finally { bitmap.close?.(); }
  }
  function init({ store, openButton }) {
    if (!openButton) return;
    const dialog = make('dialog', 'map-library-dialog');
    dialog.id = 'map-library-dialog';
    dialog.setAttribute('aria-labelledby', 'map-library-title');
    dialog.innerHTML = '<div class="map-library-head"><h2 id="map-library-title">Wybierz scenerię</h2><button type="button" id="map-library-close" aria-label="Zamknij bibliotekę map">×</button></div><div class="map-library-body"><div class="map-library-drop" id="map-library-drop"><span>Przeciągnij grafikę lub <button type="button" id="map-library-add" class="map-library-upload-link">kliknij tutaj</button></span><input id="map-library-files" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" multiple hidden /></div><p class="map-library-help">JPG lub PNG, do 20 MiB i 40 megapikseli. Obraz zostanie przycięty do kwadratu.</p><div id="map-library-uploads" class="map-library-uploads" aria-live="polite"></div><p id="map-library-error" class="map-error" role="alert" hidden></p><div id="map-library-grid" class="map-library-grid"></div><p id="map-library-empty" class="map-library-empty">Biblioteka map jest pusta.</p></div>';
    doc.body.append(dialog);
    const closeButton = dialog.querySelector('#map-library-close');
    const fileInput = dialog.querySelector('#map-library-files');
    const addButton = dialog.querySelector('#map-library-add');
    const drop = dialog.querySelector('#map-library-drop');
    const uploads = dialog.querySelector('#map-library-uploads');
    const grid = dialog.querySelector('#map-library-grid');
    const empty = dialog.querySelector('#map-library-empty');
    const errorBox = dialog.querySelector('#map-library-error');
    const jobs = new Map(), pendingActions = new Set();
    let restoreFocus = openButton, libraryKey = null, sessionGeneration = 0;
    function showError(error) { errorBox.textContent = errorText(error); errorBox.hidden = false; }
    function clearError() { errorBox.hidden = true; errorBox.textContent = ''; }
    function gm() { return store.access?.role === 'gm'; }
    function refresh() {
      if (!gm()) {
        sessionGeneration++;
        grid.replaceChildren(); uploads.replaceChildren(); jobs.clear(); clearError(); libraryKey = null;
        if (dialog.open) dialog.close();
        return;
      }
      if (!dialog.open) return;
      const records = (store.getState().mapLibrary || []).slice().sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt) || String(b.id).localeCompare(String(a.id)));
      const nextKey = JSON.stringify([records, store.connection]);
      if (nextKey === libraryKey) return;
      libraryKey = nextKey;
      const focused = grid.contains(doc.activeElement) ? doc.activeElement : null;
      const focusedId = focused?.closest('[data-id]')?.dataset.id, focusedAction = focused?.dataset.action;
      grid.replaceChildren();
      empty.hidden = !!records.length;
      for (const record of records) {
        const card = make('article', 'map-library-card');
        card.dataset.id = record.id;
        const preview = make('div', 'map-library-preview');
        const image = make('img');
        image.alt = '';
        preview.append(image);
        preview.tabIndex = 0; preview.setAttribute('role', 'button');
        preview.dataset.action = 'load';
        preview.setAttribute('aria-label', 'Wczytaj mapę do potyczki');
        preview.title = 'Kliknij dwukrotnie, aby wczytać mapę do potyczki';
        const date = make('p', 'map-library-date', Number.isFinite(Date.parse(record.uploadedAt)) ? new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.uploadedAt)) : '');
        const actions = make('div', 'map-library-meta');
        const remove = make('button', 'text-button', 'Usuń');
        remove.type = 'button';
        remove.dataset.action = 'remove';
        actions.append(date, remove);
        card.append(preview, actions);
        grid.append(card);
        getImage(store, record.thumbnailId).then(dataUrl => { if (card.isConnected && card.dataset.id === record.id) image.src = dataUrl; }).catch(() => { if (card.isConnected) { preview.textContent = 'Nie można wczytać miniatury'; libraryKey = null; } });
      }
      if (focusedId && focusedAction) {
        const replacement = [...grid.querySelectorAll('[data-action]')].find(button => button.closest('[data-id]').dataset.id === focusedId && button.dataset.action === focusedAction);
        (replacement || addButton).focus();
      }
    }
    function renderJob(job) {
      let row = uploads.querySelector(`[data-job-id="${job.id}"]`);
      if (!row) { row = make('div', 'map-library-upload'); row.dataset.jobId = job.id; uploads.prepend(row); }
      row.replaceChildren();
      row.append(make('span', 'map-library-upload-name', job.name), make('span', 'map-library-upload-status', job.status));
      if (job.failed) {
        const retry = make('button', 'text-button', 'Ponów');
        retry.type = 'button'; retry.dataset.retry = job.id; row.append(retry);
      }
    }
    async function upload(job) {
      if (!gm() || jobs.get(job.id) !== job || job.running) return;
      const generation = sessionGeneration;
      const current = () => jobs.get(job.id) === job && sessionGeneration === generation && gm();
      job.running = true;
      job.failed = false; job.status = 'Przygotowywanie…'; renderJob(job);
      try {
        if (!job.prepared) job.prepared = await prepare(job.file);
        if (!current()) return;
        job.status = 'Wysyłanie…'; renderJob(job);
        if (!store.canWrite) throw new Error('Brak połączenia. Spróbuj ponownie po synchronizacji.');
        if (!current()) return;
        await store.uploadMap({ id: job.id, name: job.name, ...job.prepared });
        if (!current()) return;
        job.status = 'Dodano do biblioteki'; job.prepared = null; job.file = null;
        if (dialog.open) renderJob(job);
        else { jobs.delete(job.id); uploads.querySelector(`[data-job-id="${job.id}"]`)?.remove(); }
        refresh();
      } catch (error) {
        if (!current()) return;
        job.status = errorText(error); job.failed = true; renderJob(job);
      } finally { job.running = false; }
    }
    function queue(files) {
      if (!gm()) return;
      clearError();
      for (const file of Array.from(files)) {
        const id = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const job = { id, file, name: file.name, status: 'Oczekuje…', failed: false, prepared: null };
        jobs.set(id, job); renderJob(job); upload(job);
      }
    }
    openButton.addEventListener('click', () => {
      if (!gm()) return;
      restoreFocus = doc.activeElement || openButton;
      clearError(); refresh(); dialog.showModal(); closeButton.focus(); refresh();
    });
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      for (const [id, job] of jobs) if (!job.failed && job.file === null) { jobs.delete(id); uploads.querySelector(`[data-job-id="${id}"]`)?.remove(); }
      restoreFocus?.focus?.();
    });
    addButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { queue(fileInput.files); fileInput.value = ''; });
    for (const name of ['dragenter', 'dragover']) dialog.addEventListener(name, event => { event.preventDefault(); drop.classList.add('is-dragging'); });
    for (const name of ['dragleave', 'drop']) dialog.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('is-dragging'); });
    dialog.addEventListener('drop', event => queue(event.dataTransfer?.files || []));
    uploads.addEventListener('click', event => { const id = event.target.dataset.retry; if (id && jobs.has(id)) upload(jobs.get(id)); });
    async function act(target, action) {
      const card = target?.closest('.map-library-card');
      if (!card || !gm() || pendingActions.has(card.dataset.id)) return;
      const id = card.dataset.id;
      const record = (store.getState().mapLibrary || []).find(item => item.id === id);
      if (!record) { refresh(); return; }
      if (action === 'remove' && !root.confirm(`Usunąć mapę „${record.name}” z biblioteki?`)) return;
      if (action === 'load' && store.getState().map && store.getParticipants().length && !root.confirm('Wczytać inną mapę? Rozstawienie znaczników zostanie wyzerowane.')) return;
      const generation = sessionGeneration;
      clearError(); pendingActions.add(id); target.setAttribute('aria-disabled', 'true');
      try {
        if (!store.canWrite) throw new Error('Brak połączenia. Spróbuj ponownie po synchronizacji.');
        if (action === 'load') { await store.loadMap(id); if (gm() && generation === sessionGeneration) dialog.close(); }
        else { await store.removeMap(id); refresh(); }
      } catch (error) { if (gm() && generation === sessionGeneration) showError(error); }
      finally { pendingActions.delete(id); target.removeAttribute('aria-disabled'); }
    }
    grid.addEventListener('click', event => {
      const remove = event.target.closest('[data-action="remove"]');
      if (remove) act(remove, 'remove');
    });
    grid.addEventListener('dblclick', event => {
      const preview = event.target.closest('.map-library-preview');
      if (preview) act(preview, 'load');
    });
    grid.addEventListener('keydown', event => {
      if (event.target.matches('.map-library-preview') && ['Enter', ' '].includes(event.key)) {
        event.preventDefault(); if (!event.repeat) act(event.target, 'load');
      }
    });
    let lastTap = null;
    grid.addEventListener('pointerup', event => {
      if (event.pointerType !== 'touch') return;
      const preview = event.target.closest('.map-library-preview');
      if (!preview) { lastTap = null; return; }
      if (lastTap?.preview === preview && event.timeStamp - lastTap.time < 400 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 20) {
        lastTap = null; event.preventDefault(); act(preview, 'load');
      } else lastTap = { preview, time: event.timeStamp, x: event.clientX, y: event.clientY };
    });
    store.subscribe(refresh);
  }
  root.OneRingMapLibrary = { init, showActiveImage, prepare };
})(window);
