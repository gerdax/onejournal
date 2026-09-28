/* Portable async store. Only supabase-adapter.js knows the hosting provider. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OneJournalCloud = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const mutations = ['addEnemy', 'removeParticipant', 'clearBattle', 'clearEncounter', 'toggleDefeated', 'setEnemyWound', 'adjustResource', 'reorderEnemies', 'saveHero', 'deleteHero', 'addHero', 'setMap', 'moveToken', 'addLibrary', 'removeLibrary', 'importLibrary', 'restoreBackup', 'selectToken'];
  function createStore(transport) {
    let snapshot = null, connection = 'connecting', listeners = new Set(), tail = Promise.resolve(), refreshing, stopped = false, epoch = 0;
    const empty = { version: 2, library: [], battle: [], heroes: [], heroParticipants: [], map: null };
    function emit() { for (const fn of listeners) { try { fn(store.getState()); } catch (error) { console.error('State observer failed', error); } } }
    function accept(data) {
      if (!data || !data.state || !data.access) throw new Error('Nieprawidłowa odpowiedź serwera.');
      if (!snapshot || Number(data.revision) >= Number(snapshot.revision)) snapshot = clone(data);
      connection = 'online'; emit();
    }
    function failed(error) {
      if (error.status === 401 || error.status === 403) { epoch++; snapshot = null; connection = 'revoked'; transport.stop?.(); }
      else if (!error.status || error.status >= 500) connection = 'offline';
      emit();
    }
    async function request(body) {
      const startedEpoch = epoch;
      try {
        const response = await transport.request(body);
        if (epoch !== startedEpoch || stopped) { const error = new Error('Sesja zmieniła się podczas żądania.'); error.stale = true; throw error; }
        return response;
      } catch (error) { if (!error.stale && epoch === startedEpoch) failed(error); throw error; }
    }
    function assertWritable() { if (!store.canWrite) throw new Error('Brak połączenia. Zaczekaj na synchronizację.'); }
    function enqueue(body, apply = false) {
      try { assertWritable(); } catch (error) { return Promise.reject(error); }
      const run = tail.then(async () => {
        assertWritable();
        try {
          const response = await request(body);
          if (apply) accept(response);
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
      get rolls() { return clone(snapshot?.rolls || []); },
      get loadError() { return null; },
      getState() { return clone(snapshot?.state || empty); },
      getParticipants() { return clone(snapshot?.participants || []); },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async connect(secret) {
        epoch++; stopped = false; connection = 'connecting'; emit();
        const response = await request(secret ? { action: 'exchange', secret } : { action: 'snapshot' });
        // Opening a new link may deliberately switch role and reset revisions.
        snapshot = null; accept(response);
        transport.start?.(() => store.refresh().catch(() => {}));
        return store;
      },
      refresh() {
        if (stopped || connection === 'revoked') return Promise.reject(new Error('Dostęp został cofnięty.'));
        if (!refreshing) refreshing = request({ action: 'snapshot' }).then(accept).finally(() => { refreshing = null; });
        return refreshing;
      },
      markOffline() { if (connection !== 'revoked') { connection = 'offline'; emit(); } },
      stop() { epoch++; stopped = true; transport.stop?.(); connection = 'offline'; emit(); },
      exportBackup() { return enqueue({ action: 'export' }); },
      listLinks() { return enqueue({ action: 'links' }); },
      rotateLink(heroId) { return enqueue({ action: 'rotateLink', heroId }); },
      revokeLink(heroId) { return enqueue({ action: 'revokeLink', heroId }); },
      publishRoll(entry) { return enqueue({ action: 'roll', ...clone(entry) }, true); }
    };
    mutations.forEach(method => {
      store[method] = (...args) => {
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
