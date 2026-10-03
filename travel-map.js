/* Private, session-cached atlas. Independent of encounter state and scenery. */
(function () {
  'use strict';
  const store = window.OneRingStore;
  if (!store) return;
  const launch = document.createElement('button');
  launch.type = 'button'; launch.className = 'travel-map-launch';
  launch.setAttribute('aria-label', 'Otwórz mapę'); launch.title = 'Otwórz mapę';
  launch.setAttribute('aria-haspopup', 'dialog');
  launch.innerHTML = '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="m16 3 3 10 10 3-10 3-3 10-3-10-10-3 10-3Z" fill="currentColor" transform="rotate(-10 16 16)"/></svg>';
  const dialog = document.createElement('dialog');
  dialog.className = 'travel-map-dialog'; dialog.setAttribute('aria-label', 'Mapa podróży');
  dialog.setAttribute('aria-describedby', 'travel-map-help'); dialog.tabIndex = -1;
  dialog.innerHTML = '<p id="travel-map-help" class="travel-map-sr">Przeciągnij mapę lub użyj strzałek, aby ją przesunąć. Kliknij mapę lub naciśnij Escape, aby zamknąć.</p><div class="travel-map-status" role="status"><span class="travel-map-spinner" aria-hidden="true"></span><span class="travel-map-message">Wczytywanie mapy…</span><button type="button" hidden>Spróbuj ponownie</button></div>';
  document.body.append(launch, dialog);
  const status = dialog.querySelector('.travel-map-status'), message = dialog.querySelector('.travel-map-message');
  const spinner = dialog.querySelector('.travel-map-spinner'), retry = status.querySelector('button');
  let generation = 0, activeImage = null, imageVersion = '', decodedImage = null, decodedVersion = '', savedOverflow = '', owner = identity();
  let x = 0, y = 0, width = 0, height = 0, gesture = null, viewOpen = false;
  const pointers = new Set();
  function identity() { return JSON.stringify(store.access); }
  function blocked() {
    return document.querySelector('.map-viewport.is-fullscreen') || document.fullscreenElement ||
      [...document.querySelectorAll('dialog[open]')].some(node => node !== dialog) ||
      document.querySelector('[aria-modal="true"]:not(.travel-map-dialog)');
  }
  function paint() {
    x = Math.max(Math.min(0, dialog.clientWidth - width), Math.min(0, x));
    y = Math.max(Math.min(0, dialog.clientHeight - height), Math.min(0, y));
    if (activeImage) activeImage.style.transform = `translate(${x}px, ${y}px)`;
  }
  function fit() {
    if (!activeImage || !dialog.open) return;
    const scale = Math.max(dialog.clientWidth / activeImage.naturalWidth, dialog.clientHeight / activeImage.naturalHeight);
    width = activeImage.naturalWidth * scale; height = activeImage.naturalHeight * scale;
    activeImage.style.width = `${width}px`; activeImage.style.height = `${height}px`;
    x = (dialog.clientWidth - width) / 2; y = (dialog.clientHeight - height) / 2; paint();
  }
  function close() { if (dialog.open) dialog.close(); finishClose(); }
  function clearView() {
    generation++; gesture = null; pointers.clear(); dialog.classList.remove('is-dragging');
    activeImage?.remove(); activeImage = null; imageVersion = '';
  }
  function finishClose() {
    if (!viewOpen) return;
    viewOpen = false;
    clearView(); document.body.style.overflow = savedOverflow;
    if (launch.isConnected && store.connection !== 'revoked') launch.focus({ preventScroll: true });
  }
  dialog.addEventListener('close', () => { if (!dialog.open) finishClose(); });
  function loading() {
    status.hidden = false; spinner.hidden = false; retry.hidden = true; message.textContent = 'Wczytywanie mapy…';
  }
  async function display(result, token) {
    if (token !== generation || !dialog.open || !result?.dataUrl || imageVersion === result.version) return;
    let image = decodedImage;
    if (!image || decodedVersion !== result.version) {
      image = new Image(); image.className = 'travel-map-image'; image.alt = result.mapId === 'eriador' ? 'Mapa Eriadoru' : 'Mapa podróży';
      image.draggable = false; image.src = result.dataUrl;
      await image.decode();
      if (token !== generation || !dialog.open) return;
      decodedImage = image; decodedVersion = result.version;
    }
    activeImage?.remove(); activeImage = image; imageVersion = result.version;
    dialog.prepend(image); status.hidden = true; fit();
  }
  async function load() {
    const token = ++generation;
    const cached = store.getCachedTravelMap();
    if (!activeImage) loading();
    try {
      if (cached) await display(cached, token);
      if (token !== generation || !dialog.open) return;
      const result = await store.getTravelMap();
      await display(result, token);
    } catch (error) {
      if (token !== generation || !dialog.open || store.connection === 'revoked') return;
      if (activeImage) return; // A transient network failure does not discard the session cache.
      spinner.hidden = true; retry.hidden = false; status.hidden = false;
      message.textContent = 'Nie udało się wczytać mapy.';
    }
  }
  launch.addEventListener('click', () => {
    if (dialog.open || blocked() || !['gm', 'player'].includes(store.access.role) || store.connection === 'revoked') return;
    savedOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    viewOpen = true; loading(); dialog.showModal(); dialog.focus({ preventScroll: true }); void load();
  });
  retry.addEventListener('click', event => { event.stopPropagation(); void load(); });
  dialog.addEventListener('pointerdown', event => {
    if (event.target.closest('button') || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointers.add(event.pointerId);
    if (pointers.size > 1) { if (gesture) gesture.cancelled = true; return; }
    gesture = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x, y, dragged: false, cancelled: false };
    dialog.setPointerCapture(event.pointerId);
  });
  dialog.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.id || gesture.cancelled) return;
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (Math.hypot(dx, dy) > 6) gesture.dragged = true;
    if (gesture.dragged) {
      dialog.classList.add('is-dragging'); x = gesture.x + dx; y = gesture.y + dy; paint();
    }
  });
  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (!gesture || event.pointerId !== gesture.id) return;
    const tap = event.type === 'pointerup' && !gesture.dragged && !gesture.cancelled && pointers.size === 0;
    gesture = null; dialog.classList.remove('is-dragging');
    if (dialog.hasPointerCapture(event.pointerId)) dialog.releasePointerCapture(event.pointerId);
    if (tap) { event.preventDefault(); close(); }
  }
  dialog.addEventListener('pointerup', endPointer);
  dialog.addEventListener('pointercancel', endPointer);
  dialog.addEventListener('lostpointercapture', event => { if (gesture?.id === event.pointerId) { gesture = null; dialog.classList.remove('is-dragging'); } });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    const delta = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }[event.key];
    if (delta) { event.preventDefault(); x += delta[0]; y += delta[1]; paint(); }
  });
  new ResizeObserver(fit).observe(dialog);
  store.subscribe(() => {
    const next = identity();
    if (store.connection === 'revoked' || next !== owner || store.connection === 'connecting') { close(); clearView(); decodedImage = null; decodedVersion = ''; }
    owner = next;
    launch.hidden = !['gm', 'player'].includes(store.access.role) || store.connection === 'revoked';
  });
})();
