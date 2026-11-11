/* Isolated HTTP/Supabase fixture for authenticated browser checks. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('../state.js');
const { createServerCore, defaultDocument } = require('../server-core.js');

const root = path.resolve(__dirname, '..');
const gmSecret = 'fixture-gm-access-secret-00001';
const playerSecrets = ['fixture-player-access-secret-01', 'fixture-player-access-secret-02'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function startFixture(options = {}) {
  const storage = { getItem: () => null, setItem: () => {} };
  const seed = createStore(storage);
  const heroes = [seed.saveHero({ name: 'Ala', culture: 'Hobbit', hope: 8, maxHope: 10 }), seed.saveHero({ name: 'Bartek', culture: 'Człowiek', hope: 7, maxHope: 9 })];
  seed.addHero(heroes[0].id);
  seed.addHero(heroes[1].id);
  seed.addEnemy({ name: 'Ork Sekretny', kind: 'Ork', tier: 'Standardowy', fierceness: 4, endurance: 16, maxEndurance: 16, might: 1, hate: 4, maxHate: 4, parry: 1, armour: 2, attack: 'Łuk', traits: 'Sekret MG', notes: 'Tajne notatki' });
  for (let i = 3; i < (options.tokenCount || 3); i++) seed.addEnemy({ name: `Audit enemy ${i}`, endurance: 10, maxEndurance: 10, might: 1, hate: 2, maxHate: 2 });
  const { generateTerrain } = require('../map.js');
  seed.setMap(generateTerrain('clearing', 'small', 'online-test'));
  let doc = defaultDocument();
  doc.state = seed.getState();
  for (const [index, secret] of [gmSecret, ...playerSecrets].entries()) doc.links.push({ id: 'fixture-link-' + index, role: index ? 'player' : 'gm', heroId: index ? heroes[index - 1].id : null, secretHash: hash(secret), encryptedSecret: secret, version: 1, active: true });
  const repository = {
    get: async () => copy(doc),
    compareAndSwap: async (expected, next) => { if (doc.revision !== expected) return false; doc = copy(next); return true; }
  };
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'supabase/functions/onejournal/catalog.json'), 'utf8'));
  const avatarFiles = new Map();
  const avatarStorage = {
    get: async id => avatarFiles.get(id) || null,
    put: async (id, dataUrl) => { avatarFiles.set(id, dataUrl); }
  };
  const mapFiles = new Map();
  const mapStorage = {
    get: async id => mapFiles.get(id) || null,
    put: async (id, dataUrl) => { mapFiles.set(id, dataUrl); }
  };
  const travelBytes = fs.readFileSync(path.join(__dirname, 'fixtures/map-1024.jpg'));
  const travelVersion = hash(travelBytes);
  const travelMapStorage = options.travelMapStorage || {
    getManifest: async () => ({ maps: Object.fromEntries(['eriador', 'podrozy'].map(id => [id, { version: travelVersion, path: `${id}-${travelVersion}.jpg` }])) }),
    get: async () => `data:image/jpeg;base64,${travelBytes.toString('base64')}`
  };
  const core = createServerCore({ repository, avatarStorage, mapStorage, travelMapStorage, hashSecret: hash, randomSecret: () => 'fixture-random-secret-' + crypto.randomBytes(12).toString('hex'), encryptSecret: value => value, decryptSecret: value => value, catalog });
  // Opt-in audit controls: no effect on existing test callers.
  let responseDelay = options.responseDelay || 0;
  const requests = [], failures = [], snapshotListeners = new Set();
  const offline = new Set();
  let userSequence = 0;
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/auth/v1/signup' || url.pathname === '/auth/v1/token') {
        const uid = url.pathname.endsWith('signup') ? 'fixture-user-' + ++userSequence : JSON.parse(await body(req)).refresh_token;
        return send(res, 200, { access_token: uid, refresh_token: uid, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600 });
      }
      if (url.pathname === '/functions/v1/onejournal') {
        const uid = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (offline.has(uid)) return send(res, 503, { error: 'Fixture offline' });
        const request = JSON.parse(await body(req));
        const record = { uid, action: request.action, method: request.method, started: performance.now(), requestBytes: Buffer.byteLength(JSON.stringify(request)) };
        requests.push(record);
        const failIndex = failures.findIndex(item => item.method === request.method);
        let result, status = 200;
        try {
          if (failIndex >= 0) { const failure = failures.splice(failIndex, 1)[0]; throw Object.assign(new Error('Audit injected failure'), { status: failure.status }); }
          result = await core.handle(uid, request);
        } catch (error) { status = error.status || 500; result = { error: error.message }; }
        record.handled = performance.now();
        const delay = responseDelay;
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        record.completed = performance.now(); record.status = status;
        record.responseBytes = Buffer.byteLength(JSON.stringify(result)); record.revision = result.revision;
        return send(res, status, result);
      }
      if (url.pathname === '/config.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        return res.end(`window.ONEJOURNAL_CONFIG = {supabaseUrl: location.origin, supabaseAnonKey: 'fixture-anon'};`);
      }
      if (url.pathname === '/service-worker.js') return send(res, 404, {});
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, {});
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (error) { send(res, error.status || 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    secrets: { gm: gmSecret, players: playerSecrets }, heroes,
    get document() { return copy(doc); },
    core,
    audit: {
      requests,
      setResponseDelay(ms) { if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid response delay'); responseDelay = ms; },
      failNext(method, status = 503) { failures.push({ method, status }); },
      subscribeSnapshots(callback) { snapshotListeners.add(callback); return () => snapshotListeners.delete(callback); },
      // Explicit harness notification, not a Supabase WebSocket simulation.
      notifySnapshots() { return Promise.all([...snapshotListeners].map(callback => callback())); }
    },
    revokeGM() { const link = doc.links.find(item => item.role === 'gm'); link.active = false; link.version++; },
    setOffline(uid, value) { if (value) offline.add(uid); else offline.delete(uid); },
    close: () => new Promise(resolve => server.close(resolve))
  };
}
function body(req) { return new Promise((resolve, reject) => { let value = ''; req.on('data', chunk => value += chunk); req.on('end', () => resolve(value)); req.on('error', reject); }); }
module.exports = { startFixture };
