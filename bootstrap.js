(function () {
  'use strict';
  const main = document.querySelector('main'), screen = document.getElementById('access-screen');
  const message = document.getElementById('access-message'), status = document.getElementById('connection-status');
  const retry = document.getElementById('access-retry'), reconnect = document.getElementById('reconnect');
  let store, transport, started = false, connecting = false;
  function load(src) { return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = src; script.onload = resolve; script.onerror = () => reject(new Error('Nie udało się wczytać aplikacji. Odśwież stronę.')); document.body.append(script); }); }
  function updateConnection() {
    const online = store.connection === 'online';
    document.body.dataset.connection = store.connection;
    document.body.dataset.role = store.access.role || '';
    status.textContent = ({ online: store.access.role === 'gm' ? 'Mistrz gry · połączono' : 'Gracz · połączono', connecting: 'Synchronizacja…', offline: 'Brak połączenia — zmiany zablokowane', revoked: 'Dostęp został cofnięty' })[store.connection];
    reconnect.hidden = online || store.connection === 'revoked';
    if (store.connection === 'revoked') {
      // Remove any previously rendered private data, including open dialogs.
      main.replaceChildren(); main.hidden = true; screen.hidden = false;
      message.textContent = 'Ten dostęp wygasł lub został cofnięty. Otwórz aktualny link od mistrza gry.';
      document.querySelectorAll('dialog,.dice-launch,.journal-toast').forEach(node => node.remove());
      transport.clearSession();
    }
  }
  async function boot() {
    if (connecting || started) return;
    connecting = true; retry.hidden = true;
    try {
      const config = window.ONEJOURNAL_CONFIG;
      if (!config?.supabaseUrl || !config.supabaseAnonKey) {
        status.textContent = 'Zaplecze nie jest skonfigurowane';
        message.textContent = 'Ta instalacja onejournal wymaga podłączenia projektu Supabase. Instrukcja znajduje się w pliku DEPLOYMENT.md projektu. Dane bestiary pozostają nienaruszone.';
        return;
      }
      transport = OneJournalSupabase.createTransport(config);
      store = window.OneRingStore = OneJournalCloud.createStore(transport);
      const secret = new URLSearchParams(location.hash.slice(1)).get('access');
      if (secret) Object.keys(sessionStorage).filter(key => key.startsWith('onejournal:pending-rolls:' + location.pathname + ':')).forEach(key => sessionStorage.removeItem(key));
      await store.connect(secret);
      if (secret) history.replaceState(null, '', location.pathname + location.search);
      store.subscribe(updateConnection);
      if (store.access.role === 'player') {
        document.querySelector('[data-tab="heroes"]').textContent = 'Mój bohater';
        for (const name of ['opponents']) { const tab = document.querySelector(`[data-tab="${name}"]`); tab.hidden = true; tab.disabled = true; }
      }
      document.getElementById('gm-settings').hidden = store.access.role !== 'gm';
      for (const src of ['vendor/Sortable.min.js', 'heroes.js?v=oj4', 'map.js?v=oj3', 'app.js?v=oj1', 'dice-rules.js?v=oj1', 'journal.js?v=8', 'dice-engine.js?v=oj1', 'dice-roller.js?v=oj3', 'settings.js?v=2']) await load(src);
      started = true; screen.hidden = true; main.hidden = false;
      document.getElementById('journal-open').hidden = false;
      updateConnection();
    } catch (error) {
      transport?.stop(); status.textContent = 'Nie połączono';
      message.textContent = error.message || 'Otwórz link otrzymany od mistrza gry.';
      retry.hidden = false;
    } finally { connecting = false; }
  }
  retry.addEventListener('click', boot);
  reconnect.addEventListener('click', () => store?.refresh().catch(() => {}));
  window.addEventListener('offline', () => store?.markOffline());
  window.addEventListener('online', () => store?.refresh().catch(() => {}));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) store?.refresh().catch(() => {}); });
  // Navigation and reading remain available offline; server/store enforce writes.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js', { scope: './' }).catch(() => {});
  boot();
})();
