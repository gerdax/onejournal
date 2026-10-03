/* Portable async store. Only supabase-adapter.js knows the hosting provider. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OneJournalCloud = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const mutations = ['addEnemy', 'removeParticipant', 'clearBattle', 'clearEncounter', 'toggleDefeated', 'setEnemyWound', 'setEnemyWeary', 'setEnemyNotes', 'adjustResource', 'reorderEnemies', 'saveHero', 'deleteHero', 'addHero', 'setMap', 'moveToken', 'addLibrary', 'removeLibrary', 'importLibrary', 'removeMap', 'setMapFavorite', 'loadMap', 'restoreBackup', 'selectToken'];
  function createStore(transport) {
    let snapshot = null, connection = 'connecting', listeners = new Set(), tail = Promise.resolve(), refreshing, stopped = false, epoch = 0;
    let requestOrder = 0, appliedOrder = 0, refreshGeneration = 0;
    const empty = { version: 2, library: [], battle: [], heroes: [], heroParticipants: [], mapLibrary: [], map: null };
    function emit() { for (const fn of listeners) { try { fn(store.getState()); } catch (error) { console.error('State observer failed', error); } } }
    const sameAccess = (a, b) => a?.role === b?.role && a?.heroId === b?.heroId;
    const projection = data => { const copy = clone(data); delete copy.result; return copy; };
    function accept(data, order) {
      if (!data || !data.state || !data.access) throw new Error('Nieprawidłowa odpowiedź serwera.');
      const next = projection(data);
      const sameScope = snapshot && sameAccess(next.access, snapshot.access);
      const stale = snapshot && (sameScope && Number(next.revision) < Number(snapshot.revision) ||
        order < appliedOrder && (!sameScope || Number(next.revision) === Number(snapshot.revision)));
      const changed = !stale && (!snapshot || JSON.stringify(next) !== JSON.stringify(snapshot));
      if (changed) snapshot = next;
      if (!stale) appliedOrder = Math.max(appliedOrder, order);
      const transitioned = connection !== 'online';
      connection = 'online';
      if (changed || transitioned) emit();
    }
    function failed(error) {
      const previous = connection, hadSnapshot = !!snapshot;
      if (error.status === 401 || error.status === 403) { epoch++; snapshot = null; connection = 'revoked'; transport.stop?.(); }
      else if (!error.status || error.status >= 500) {
        connection = 'offline'; refreshGeneration++; refreshing = null;
      }
      if (connection !== previous || hadSnapshot && !snapshot) emit();
    }
    async function request(body, isCurrent) {
      const startedEpoch = epoch;
      try {
        const response = await transport.request(body);
        if (epoch !== startedEpoch || stopped) { const error = new Error('Sesja zmieniła się podczas żądania.'); error.stale = true; throw error; }
        return response;
      } catch (error) { if (!error.stale && epoch === startedEpoch && ([401, 403].includes(error.status) || !isCurrent || isCurrent())) failed(error); throw error; }
    }
    function assertWritable() { if (!store.canWrite) throw new Error('Brak połączenia. Zaczekaj na synchronizację.'); }
    function staleSession() { const error = new Error('Sesja zmieniła się podczas żądania.'); error.stale = true; return error; }
    function enqueue(body, apply = false) {
      try { assertWritable(); } catch (error) { return Promise.reject(error); }
      const queuedEpoch = epoch;
      const run = tail.then(async () => {
        if (epoch !== queuedEpoch || stopped) throw staleSession();
        assertWritable();
        try {
          const order = ++requestOrder;
          const response = await request(body);
          if (apply) accept(response, order);
          return response;
        } catch (error) {
          if (error.status === 409) await store.refresh().catch(() => {});
          throw error;
        }
      });
      tail = run.catch(() => {});
      return run;
    }
    const store = {
      get access() { return clone(snapshot?.access || { role: null, heroId: null }); },
      get connection() { return connection; },
      get canWrite() { return connection === 'online' && !!snapshot && !stopped; },
      get selection() { return snapshot?.selection || null; },
      get heroVersions() { return clone(snapshot?.heroVersions || {}); },
      get catalog() { return clone(snapshot?.catalog || []); },
      get rollEpoch() { return snapshot?.rollEpoch || 0; },
      get rolls() { return clone(snapshot?.rolls || []); },
      get notebook() { return snapshot?.access?.role === 'gm' ? clone(snapshot.notebook || null) : null; },
      get loadError() { return null; },
      getState() { return clone(snapshot?.state || empty); },
      getParticipants() { return clone(snapshot?.participants || []); },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async connect(secret) {
        epoch++; refreshGeneration++; stopped = false; refreshing = null; connection = 'connecting'; emit();
        const order = ++requestOrder;
        const response = await request(secret ? { action: 'exchange', secret } : { action: 'snapshot' });
        // Opening a new link may deliberately switch role and reset revisions.
        snapshot = null; accept(response, order);
        transport.start?.(() => store.refresh().catch(() => {}));
        return store;
      },
      refresh() {
        if (stopped || connection === 'revoked') return Promise.reject(new Error('Dostęp został cofnięty.'));
        if (!refreshing) {
          const generation = refreshGeneration;
          const baseline = connection === 'online' ? snapshot : null;
          const conditional = baseline && Number.isSafeInteger(baseline.revision) && baseline.revision >= 0;
          const body = conditional ? { action: 'snapshot', knownRevision: baseline.revision, knownAccess: clone(baseline.access) } : { action: 'snapshot' };
          const order = ++requestOrder;
          const pending = (async () => {
            const response = await request(body, () => generation === refreshGeneration);
            if (generation !== refreshGeneration) throw staleSession();
            if (response?.unchanged === true) {
              // A newer response may have changed the projection while this read was in flight.
              if (snapshot !== baseline) return;
              if (conditional && response.revision === body.knownRevision && sameAccess(response.access, body.knownAccess)) {
                if (connection !== 'online') { connection = 'online'; emit(); }
                return;
              }
              const fullOrder = ++requestOrder;
              const full = await request({ action: 'snapshot' }, () => generation === refreshGeneration);
              if (generation !== refreshGeneration) throw staleSession();
              if (full?.unchanged === true) throw new Error('Nieprawidłowa odpowiedź serwera.');
              accept(full, fullOrder);
              return;
            }
            accept(response, order);
          })();
          let settled;
          settled = pending.finally(() => { if (refreshing === settled) refreshing = null; });
          refreshing = settled;
        }
        return refreshing;
      },
      markOffline() { if (connection !== 'revoked') { epoch++; refreshGeneration++; refreshing = null; const changed = connection !== 'offline'; connection = 'offline'; if (changed) emit(); } },
      stop() { epoch++; refreshGeneration++; refreshing = null; stopped = true; transport.stop?.(); const changed = connection !== 'offline'; connection = 'offline'; if (changed) emit(); },
      exportBackup() { return enqueue({ action: 'export' }); },
      getAvatar(heroId) { return enqueue({ action: 'avatarGet', heroId }); },
      uploadMap({ id, name, dataUrl, thumbnailDataUrl }) {
        return enqueue({ action: 'mapUpload', id, name, dataUrl, thumbnailDataUrl }, true).then(response => clone(response.result));
      },
      getMapImage(imageId) { return enqueue({ action: 'mapGet', imageId }); },
      setAvatar(heroId, dataUrl, heroVersion) {
        return enqueue({ action: 'avatarSet', heroId, dataUrl: dataUrl || null,
          heroVersion: heroVersion ?? snapshot?.heroVersions?.[heroId] ?? 0 }, true).then(response => clone(response.result));
      },
      listLinks() { return enqueue({ action: 'links' }); },
      rotateLink(heroId) { return enqueue({ action: 'rotateLink', heroId }); },
      revokeLink(heroId) { return enqueue({ action: 'revokeLink', heroId }); },
      clearRolls() { return enqueue({ action: 'clearRolls' }, true); },
      saveNotebook(document, version) {
        return enqueue({ action: 'notebookSave', document: clone(document), version: version ?? snapshot?.notebook?.version ?? 0 }, true)
          .then(response => clone(response.result));
      },
      publishRoll(entry) { return enqueue({ action: 'roll', ...clone(entry) }, true); }
    };
    mutations.forEach(method => {
      store[method] = (...args) => {
        if (method === 'restoreBackup' && args[0]?.format === 'onejournal' && args[0].version === 2) {
          return (async () => {
            const restoreEpoch = epoch;
            const assertRestoreSession = () => { if (epoch !== restoreEpoch || stopped) throw staleSession(); };
            const backup = clone(args[0]);
            if (!backup.avatars || typeof backup.avatars !== 'object' || Array.isArray(backup.avatars)) throw new Error('Nieprawidłowy spis portretów.');
            for (const [id, dataUrl] of Object.entries(backup.avatars)) {
              assertRestoreSession();
              const staged = await enqueue({ action: 'avatarStage', dataUrl });
              if (staged.avatarId !== id) throw new Error('Portret w kopii nie pasuje do identyfikatora.');
              backup.avatars[id] = null;
            }
            if (Object.hasOwn(backup, 'maps')) {
              if (!backup.maps || typeof backup.maps !== 'object' || Array.isArray(backup.maps)) throw new Error('Nieprawidłowy spis map.');
              const thumbnailIds = new Set((backup.state?.mapLibrary || []).map(m => m.thumbnailId));
              for (const [id, dataUrl] of Object.entries(backup.maps)) {
                assertRestoreSession();
                const staged = await enqueue({ action: 'mapStage', dataUrl, thumbnail: thumbnailIds.has(id) });
                if (staged.imageId !== id) throw new Error('Mapa w kopii nie pasuje do identyfikatora.');
                backup.maps[id] = null;
              }
            }
            assertRestoreSession();
            return enqueue({ action: 'command', method, args: [backup] }, true).then(response => clone(response.result));
          })();
        }
        const body = { action: 'command', method, args: clone(args) };
        if (method === 'saveHero') {
          body.args = [clone(args[0])];
          if (args[0]?.id) body.heroVersion = args[1] ?? snapshot?.heroVersions?.[args[0].id];
        }
        return enqueue(body, true).then(response => clone(response.result));
      };
    });
    return store;
  }
  return { createStore };
});
