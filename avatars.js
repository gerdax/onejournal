(function () {
  'use strict';
  const store = window.OneRingStore;
  if (!store) return;
  const views = new Set(), slots = new WeakMap(), cache = new Map(), pending = new Map(), busy = new Set();
  let epoch = 0, wasRevoked = false;
  const hero = id => store.getState().heroes.find(item => item.id === id);
  const writable = () => store.connection === 'online' && store.canWrite;

  function paint(view) {
    const current = hero(view.id), avatarId = current?.avatarId || null;
    const entry = cache.get(view.id);
    const image = entry?.avatarId === avatarId ? entry.dataUrl : null;
    if (view.shown !== image) {
      view.shown = image;
      view.button.replaceChildren();
      if (image) {
        const img = document.createElement('img'); img.src = image; img.alt = '';
        view.button.append(img);
      } else view.button.textContent = '✧';
    }
    const disabled = !current || !writable() || busy.has(view.id);
    if (view.button.disabled !== disabled) view.button.disabled = disabled;
    const label = (avatarId ? 'Zmień awatar bohatera ' : 'Dodaj awatar bohatera ') + (current?.name || '');
    if (view.button.getAttribute('aria-label') !== label) view.button.setAttribute('aria-label', label);
    if (avatarId && !image) fetchAvatar(view.id, avatarId);
  }

  function notify() {
    for (const view of views) {
      if (!view.button.isConnected) { views.delete(view); continue; }
      paint(view);
    }
  }

  function fetchAvatar(id, avatarId) {
    if (!writable() || typeof store.getAvatar !== 'function') return;
    const existing = pending.get(id);
    if (existing?.avatarId === avatarId) return;
    const requestEpoch = epoch;
    const task = { avatarId };
    pending.set(id, task);
    store.getAvatar(id).then(result => {
      if (epoch !== requestEpoch || pending.get(id) !== task || hero(id)?.avatarId !== avatarId || result?.avatarId !== avatarId) return;
      if (typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:image/jpeg;base64,')) cache.set(id, { avatarId, dataUrl: result.dataUrl });
      notify();
    }).catch(() => {
      // A later refresh or user action may retry. The empty seal remains usable.
    }).finally(() => { if (pending.get(id) === task) pending.delete(id); });
  }

  function sync() {
    if (store.connection === 'revoked' || !store.access?.role) {
      if (!wasRevoked) { epoch++; cache.clear(); pending.clear(); wasRevoked = true; }
    } else wasRevoked = false;
    for (const [id, entry] of cache) if (hero(id)?.avatarId !== entry.avatarId) cache.delete(id);
    notify();
  }

  function normalizedImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), image = new Image();
      const finish = () => URL.revokeObjectURL(url);
      image.onerror = () => { finish(); reject(new Error('Nie można odczytać obrazu. Wybierz plik PNG, JPG lub WebP.')); };
      image.onload = () => {
        finish();
        const width = image.naturalWidth, height = image.naturalHeight;
        if (width !== height) { reject(new Error(`Awatar musi być kwadratowy. Wybrany obraz ma ${width} × ${height} px.`)); return; }
        if (!width || width * height > 25000000) { reject(new Error('Obraz ma zbyt duże wymiary. Maksymalnie 25 megapikseli.')); return; }
        try {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('Nie można przetworzyć obrazu.');
          context.fillStyle = '#fff'; context.fillRect(0, 0, 256, 256);
          context.drawImage(image, 0, 0, 256, 256);
          let dataUrl;
          for (const quality of [0.82, 0.7, 0.55, 0.4, 0.25]) {
            dataUrl = canvas.toDataURL('image/jpeg', quality);
            if ((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4 <= 65536) { resolve(dataUrl); return; }
          }
          reject(new Error('Nie udało się zmniejszyć awatara do 64 KiB.'));
        } catch (error) { reject(error); }
      };
      image.src = url;
    });
  }

  async function upload(id, file, view) {
    if (!file || !writable() || busy.has(id)) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { view.status.textContent = 'Wybierz plik PNG, JPG lub WebP.'; return; }
    if (file.size > 10 * 1024 * 1024) { view.status.textContent = 'Plik awatara może mieć najwyżej 10 MB.'; return; }
    const requestEpoch = epoch;
    busy.add(id); view.status.textContent = 'Zapisywanie awatara…'; notify();
    try {
      const dataUrl = await normalizedImage(file);
      if (requestEpoch !== epoch || !writable() || !hero(id)) throw new Error('Sesja zmieniła się podczas zapisu.');
      const saved = await store.setAvatar(id, dataUrl);
      if (requestEpoch !== epoch) return;
      const avatarId = saved?.avatarId || hero(id)?.avatarId;
      if (avatarId) cache.set(id, { avatarId, dataUrl });
      view.status.textContent = 'Awatar zapisany.';
    } catch (error) { if (requestEpoch === epoch) view.status.textContent = error?.message || 'Nie udało się zapisać awatara.'; }
    finally { busy.delete(id); sync(); }
  }

  async function remove(id) {
    if (!hero(id)?.avatarId || !writable() || busy.has(id)) return false;
    busy.add(id); notify();
    try {
      await store.setAvatar(id, null);
      cache.delete(id);
      return true;
    } finally { busy.delete(id); sync(); }
  }

  function mount(container, id) {
    if (!container || !id) return;
    const existing = slots.get(container);
    if (existing?.id === id) { views.add(existing); paint(existing); return; }
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'sheet-avatar';
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.hidden = true;
    const status = document.createElement('span');
    status.className = 'sheet-avatar-status'; status.setAttribute('role', 'status');
    const view = { id, button, status, shown: undefined };
    button.addEventListener('click', () => { if (writable()) input.click(); });
    input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; if (file) upload(id, file, view); });
    container.replaceChildren(button, input);
    container.parentElement.append(status);
    slots.set(container, view);
    views.add(view); paint(view);
  }

  store.subscribe(sync);
  window.OneRingAvatars = { mount, sync, remove, isBusy: id => busy.has(id) };
})();
