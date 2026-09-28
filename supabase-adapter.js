/* Provider boundary: anonymous authentication, Edge HTTP and Realtime signals. */
(function (root) {
  'use strict';
  function createTransport(config) {
    const base = new URL(config.supabaseUrl).href.replace(/\/$/, '');
    if (!base.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) throw new Error('Zaplecze wymaga HTTPS.');
    const key = config.supabaseAnonKey;
    const storageKey = 'onejournal:auth:' + location.pathname + ':' + base;
    let session = null, refreshing = null, socket, poll, heartbeat, reconnect, onChange, stopped = true, sequence = 0;
    try { session = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
    function remember(value) {
      session = { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: value.expires_at || Math.floor(Date.now() / 1000) + value.expires_in };
      if (!session.access_token || !session.refresh_token) throw new Error('Nie udało się utworzyć sesji.');
      sessionStorage.setItem(storageKey, JSON.stringify(session));
      send('access_token', { access_token: session.access_token });
    }
    async function fetchJSON(url, options) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(typeof body.error === 'string' ? body.error : body.message || body.msg || 'Serwer odrzucił żądanie.');
          error.status = response.status; throw error;
        }
        return body;
      } finally { clearTimeout(timer); }
    }
    async function authenticate(force = false) {
      if (!force && session?.access_token && session.expires_at > Date.now() / 1000 + 60) return;
      if (!refreshing) refreshing = (async () => {
        const path = session?.refresh_token ? '/auth/v1/token?grant_type=refresh_token' : '/auth/v1/signup';
        const body = session?.refresh_token ? { refresh_token: session.refresh_token } : {};
        remember(await fetchJSON(base + path, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      })().finally(() => { refreshing = null; });
      return refreshing;
    }
    async function request(body) {
      await authenticate();
      return fetchJSON(base + '/functions/v1/onejournal', {
        method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    }
    const topic = 'realtime:onejournal';
    function send(event, payload, channel = topic) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ topic: channel, event, payload, ref: String(++sequence), join_ref: channel === topic ? '1' : undefined }));
    }
    function connectSocket() {
      if (stopped || !session) return;
      clearTimeout(reconnect);
      const url = new URL(base + '/realtime/v1/websocket');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('apikey', key); url.searchParams.set('vsn', '1.0.0');
      socket = new WebSocket(url);
      socket.onopen = () => {
        sequence = 0;
        send('phx_join', { access_token: session.access_token, config: { broadcast: { ack: false, self: false }, presence: { enabled: false }, postgres_changes: [{ event: '*', schema: 'public', table: 'onejournal_updates' }] } });
        clearInterval(heartbeat); heartbeat = setInterval(() => send('heartbeat', {}, 'phoenix'), 25000);
        onChange?.();
      };
      socket.onmessage = event => {
        try { const message = JSON.parse(event.data); if (message.event === 'postgres_changes') onChange?.(); } catch (_) {}
      };
      socket.onclose = () => { clearInterval(heartbeat); if (!stopped) reconnect = setTimeout(connectSocket, 5000); };
      socket.onerror = () => socket?.close();
    }
    function stop() {
      stopped = true; clearInterval(poll); clearInterval(heartbeat); clearTimeout(reconnect);
      if (socket) { socket.onclose = null; socket.close(); socket = null; }
    }
    return {
      request,
      start(callback) { stop(); stopped = false; onChange = callback; connectSocket(); poll = setInterval(callback, 5000); },
      stop,
      clearSession() { stop(); session = null; sessionStorage.removeItem(storageKey); }
    };
  }
  root.OneJournalSupabase = { createTransport };
})(window);
