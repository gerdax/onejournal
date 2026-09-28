/* Cache only public application assets; never API responses or access links. */
const PREFIX = 'onejournal:' + new URL(self.registration.scope).pathname + ':';
const CACHE_NAME = PREFIX + 'v13';
const APP = ['index.html','config.js','state.js','cloud-store.js','supabase-adapter.js','bootstrap.js','heroes.js','map.js','app.js','dice-rules.js','dice-engine.js','dice-roller.js','journal.js','settings.js','style.css','overrides.css','heroes.css','map.css','dice-roller.css','online.css','manifest.webmanifest','icons/icon.svg','vendor/Sortable.min.js','vendor/dice-box/dice-box.es.js','vendor/dice-box/Dice.js','vendor/dice-box/world.none.js','vendor/dice-box/world.offscreen.js','vendor/dice-box/world.onscreen.js','vendor/dice-box/assets/ammo/ammo.wasm.wasm','vendor/dice-box/assets/themes/default/default.json','vendor/dice-box/assets/themes/default/diffuse-dark.png','vendor/dice-box/assets/themes/default/diffuse-light.png','vendor/dice-box/assets/themes/default/normal.png','vendor/dice-box/assets/themes/default/specular.jpg','vendor/dice-box/assets/themes/default/theme.config.json','vendor/dice-box/assets/themes/tor-enemy/symbols.png','vendor/dice-box/assets/themes/tor-enemy/theme.config.json','vendor/dice-box/assets/themes/tor-hero/symbols.png','vendor/dice-box/assets/themes/tor-hero/theme.config.json'];
const urls = new Set(APP.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll([...urls])).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.search && [...url.searchParams.keys()].some(key => key !== 'v')) return;
  url.search = ''; url.hash = '';
  if (url.href === self.registration.scope) url.pathname += 'index.html';
  if (!urls.has(url.href)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(url.href, copy))); }
    return response;
  }).catch(async () => (await caches.match(url.href)) || Response.error()));
});
