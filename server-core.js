/* Portable, dependency-injected Onejournal command processor. */
"use strict";

const { createStore, normalizeNotebook } = typeof require === "function" ? require("./state.js") : globalThis.OneRingState;
const DiceRules = typeof require === "function" ? require("./dice-rules.js") : globalThis.DiceRules;
const MAX_ROLLS = 10000;
const GM_METHODS = new Set(["addEnemy", "removeParticipant", "clearBattle", "clearEncounter", "toggleDefeated", "setEnemyWound", "setEnemyWeary", "setEnemyNotes", "adjustResource", "reorderEnemies", "addLibrary", "removeLibrary", "importLibrary", "saveHero", "deleteHero", "addHero", "setMap", "moveToken", "removeMap", "loadMap", "restoreBackup", "selectToken"]);
const own = (x, key) => Object.prototype.hasOwnProperty.call(x, key);
const clone = x => JSON.parse(JSON.stringify(x));
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const isObject = x => x !== null && typeof x === "object" && !Array.isArray(x);
const finiteInt = x => Number.isInteger(x) && x >= 0;
const avatarIds = state => [...new Set((Array.isArray(state?.heroes) ? state.heroes : []).map(h => h?.avatarId).filter(Boolean))];
const mapRoles = state => [...(Array.isArray(state?.mapLibrary) ? state.mapLibrary.flatMap(m => [{ id: m.imageId, thumbnail: false }, { id: m.thumbnailId, thumbnail: true }]) : []), ...(state?.map?.kind === "image" ? [{ id: state.map.imageId, thumbnail: false }] : [])];
const mapIds = state => [...new Set(mapRoles(state).map(ref => ref.id))];
function jpegImage(dataUrl, hashSecret, dimension, maxBytes) {
  if (typeof dataUrl !== "string" || dataUrl.length > 23 + 4 * Math.ceil(maxBytes / 3) || !/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataUrl)) fail(400, "Nieprawidłowy obraz JPEG.");
  const encoded = dataUrl.slice(23);
  let bytes;
  try { bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)); } catch { fail(400, "Nieprawidłowy obraz portretu."); }
  if (bytes.length > maxBytes || bytes.length < 32 || bytes[0] !== 255 || bytes[1] !== 216) fail(400, "Nieprawidłowy obraz JPEG.");
  let pos = 2, width = 0, height = 0, scan = false, ended = false, scanSeen = false, entropy = 0, quantization = false, huffman = false;
  while (pos < bytes.length) {
    if (scan) {
      while (pos < bytes.length && bytes[pos] !== 255) { pos++; entropy++; }
      if (pos >= bytes.length) break;
      while (pos < bytes.length && bytes[pos] === 255) pos++;
      if (pos >= bytes.length) break;
      if (bytes[pos] === 0 || bytes[pos] >= 208 && bytes[pos] <= 215) { pos++; entropy++; continue; }
      scan = false;
    } else {
      if (bytes[pos++] !== 255) break;
      while (pos < bytes.length && bytes[pos] === 255) pos++;
    }
    const marker = bytes[pos++];
    if (marker === 217) { ended = pos === bytes.length; break; }
    if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215 || pos + 2 > bytes.length) break;
    const length = bytes[pos] * 256 + bytes[pos + 1];
    if (length < 2 || pos + length > bytes.length) break;
    if ([192, 193, 194].includes(marker)) {
      if (length < 11 || width || bytes[pos + 2] !== 8 || length !== 8 + 3 * bytes[pos + 7] || bytes[pos + 7] < 1 || bytes[pos + 7] > 4) break;
      height = bytes[pos + 3] * 256 + bytes[pos + 4]; width = bytes[pos + 5] * 256 + bytes[pos + 6];
    } else if (marker >= 195 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) break;
    if (marker === 219) quantization = true;
    if (marker === 196) huffman = true;
    if (marker === 218) {
      if (!width || length < 8 || length !== 6 + 2 * bytes[pos + 2] || bytes[pos + 2] < 1) break;
      scan = true; scanSeen = true;
    }
    pos += length;
  }
  if (!ended || !scanSeen || !entropy || !quantization || !huffman || width !== dimension || height !== dimension) fail(400, `Obraz musi być poprawnym JPEG ${dimension} × ${dimension}.`);
  return { id: hashSecret(bytes), dataUrl };
}
const avatarImage = (dataUrl, hashSecret) => jpegImage(dataUrl, hashSecret, 256, 65536);
const mapImage = (dataUrl, hashSecret, thumbnail = false) => jpegImage(dataUrl, hashSecret, thumbnail ? 384 : 1024, thumbnail ? 262144 : 2 * 1024 * 1024);
const storageFor = state => {
  let saved = state ? JSON.stringify(state) : null;
  return { getItem: key => key === "one-ring-state" ? saved : null, setItem: (key, value) => { if (key === "one-ring-state") saved = value; } };
};
const cleanConfig = config => {
  if (!isObject(config) || !["hero", "npc", "enemy"].includes(config.actor)) fail(400, "Nieprawidłowy rzut.");
  if (!Number.isInteger(config.baseDice) || config.baseDice < 0 || config.baseDice > 6 || !Number.isInteger(config.bonus) || config.bonus < -6 || config.bonus > 6) fail(400, "Nieprawidłowa pula kości.");
  if (!["normal", "favoured", "weary"].includes(config.featMode)) fail(400, "Nieprawidłowy tryb kości.");
  let target = config.target;
  if (target === null || target === undefined) target = "";
  if (typeof target === "string" && target !== "") {
    if (!/^(0|[1-9][0-9]*)$/.test(target)) fail(400, "Nieprawidłowy PT.");
    target = Number(target);
  }
  if (target !== "" && (!finiteInt(target) || target > 100)) fail(400, "Nieprawidłowy PT.");
  for (const key of ["hope", "inspired", "enemyResource", "miserable", "exhausted"]) if (typeof config[key] !== "boolean") fail(400, "Nieprawidłowa konfiguracja rzutu.");
  if (own(config, "privateRoll") && typeof config.privateRoll !== "boolean") fail(400, "Nieprawidłowa widoczność rzutu.");
  return { actor: config.actor, baseDice: config.baseDice, bonus: config.bonus, featMode: config.featMode, target,
    hope: config.hope, inspired: config.inspired, enemyResource: config.enemyResource, miserable: config.miserable, exhausted: config.exhausted,
    ...(own(config, "privateRoll") ? { privateRoll: config.privateRoll } : {}) };
};
const rollVisibility = (config, authorRole) => authorRole === "player" ? "public" :
  config.privateRoll === true ? "private" : config.privateRoll === false ? "public" :
    config.actor === "hero" ? "public" : "private";
const defaultDocument = () => ({ state: createStore(storageFor(null)).getState(), revision: 0, publicRevision: 0, heroVersions: {}, selection: null, rolls: [], links: [], grants: [], notebook: { blocks: [] }, notebookVersion: 0 });
const publicMap = map => map?.kind === "image" ? clone(map) : map ? {
  scene: map.scene, size: map.size, seed: map.seed, width: map.width, height: map.height,
  terrain: map.terrain.map(t => ({ kind: t.kind, x: t.x, y: t.y, r: t.r, rotation: t.rotation, variant: t.variant })),
  positions: clone(map.positions), ...(map.features ? { features: clone(map.features) } : {})
} : null;
const participantList = state => state.battle.map(e => ({ id: e.id, type: "enemy", heroId: null, name: e.name, defeated: !!e.defeated })).concat(state.heroParticipants.map(p => {
  const hero = state.heroes.find(h => h.id === p.heroId);
  return { id: p.id, type: "hero", heroId: p.heroId, name: hero ? hero.name : "", defeated: !!(hero && hero.defeated) };
}));
function accessFor(doc, uid) {
  const grant = doc.grants.find(x => x.uid === uid && x.active);
  if (!grant) fail(403, "Brak aktywnego dostępu.");
  const link = doc.links.find(x => x.id === grant.linkId && x.active && x.version === grant.version);
  if (!link || link.role !== grant.role || link.heroId !== grant.heroId || (grant.role === "player" && !doc.state.heroes.some(h => h.id === grant.heroId))) fail(403, "Dostęp wygasł.");
  return { role: grant.role, heroId: grant.heroId };
}
function snapshot(doc, access) {
  const gm = access.role === "gm";
  const state = gm ? { ...clone(doc.state), mapLibrary: clone(doc.state.mapLibrary || []) } : { version: 2, library: [], battle: [], heroes: doc.state.heroes.filter(h => h.id === access.heroId).map(clone), heroParticipants: doc.state.heroParticipants.filter(p => p.heroId === access.heroId).map(clone), map: publicMap(doc.state.map) };
  const versions = gm ? clone(doc.heroVersions) : { [access.heroId]: doc.heroVersions[access.heroId] || 0 };
  const publicParticipants = participantList(doc.state);
  const fullParticipants = createStore(storageFor(doc.state)).getParticipants();
  const participants = gm ? fullParticipants : publicParticipants.map(p =>
    p.type === "hero" && p.heroId === access.heroId ? fullParticipants.find(full => full.id === p.id) : p);
  return { state, participants, access, rollEpoch: doc.rollEpoch || 0, revision: gm ? doc.revision : doc.publicRevision, heroVersions: versions, selection: doc.selection, rolls: doc.rolls.filter(r => gm || r.visibility === "public").map(r => clone(r.entry)), ...(gm ? { notebook: { document: clone(doc.notebook || { blocks: [] }), version: doc.notebookVersion || 0 } } : {}) };
}
function resultOf(method, args, doc) {
  if (method === "selectToken") {
    const id = args[0];
    if (id !== null && (typeof id !== "string" || !participantList(doc.state).some(p => p.id === id))) fail(400, "Nieprawidłowy żeton.");
    doc.selection = id;
    return id;
  }
  const store = createStore(storageFor(doc.state));
  const result = store[method](...args);
  doc.state = store.getState();
  if (doc.selection && !participantList(doc.state).some(p => p.id === doc.selection)) doc.selection = null;
  return result;
}
function restoredRolls(raw, uid) {
  if (!Array.isArray(raw) || raw.length > MAX_ROLLS) fail(400, "Nieprawidłowy dziennik rzutów.");
  const seen = new Set();
  return raw.map(item => {
    if (!isObject(item) || typeof item.id !== "string" || !/^[\w-]{8,80}$/.test(item.id) || seen.has(item.id) || !["gm", "player"].includes(item.authorRole)) fail(400, "Nieprawidłowy dziennik rzutów.");
    seen.add(item.id);
    const config = cleanConfig(item.config);
    if (item.authorRole === "player" && (config.actor !== "hero" || config.privateRoll === true)) fail(400, "Nieprawidłowa widoczność rzutu gracza.");
    if (own(item, "visibility") && !["public", "private"].includes(item.visibility)) fail(400, "Nieprawidłowa widoczność rzutu.");
    const visibility = own(item, "visibility") ? item.visibility : rollVisibility(config, item.authorRole);
    if (item.authorRole === "player" && visibility !== "public") fail(400, "Nieprawidłowa widoczność rzutu gracza.");
    const heroId = config.actor === "hero" && typeof item.heroId === "string" && item.heroId.length <= 100 ? item.heroId : null;
    if (config.actor === "hero" && item.authorRole === "player" && !heroId) fail(400, "Nieprawidłowy bohater w dzienniku.");
    const historicName = typeof item.heroName === "string" && item.heroName.length <= 200 ? item.heroName :
      heroId && typeof item.name === "string" && item.name.length <= 200 ? item.name : null;
    const heroName = heroId ? historicName : null;
    const createdAt = item.createdAt || item.at;
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) fail(400, "Nieprawidłowa data rzutu.");
    let result;
    try { result = DiceRules.interpretRoll(config, item.raw); } catch (error) { fail(400, error.message); }
    const rawDice = { feat: item.raw.feat.slice(), success: item.raw.success.slice() };
    const enemyId = config.actor === "enemy" && typeof item.enemyId === "string" && item.enemyId.length <= 100 ? item.enemyId : null;
    if (own(item, "enemyId") && !enemyId) fail(400, "Nieprawidłowy przeciwnik w dzienniku.");
    const enemyName = enemyId && typeof item.name === "string" ? item.name : null;
    if (enemyId && !enemyName) fail(400, "Brakuje historycznej nazwy przeciwnika.");
    const name = config.actor === "npc" ? "NPC" : config.actor === "enemy" ? enemyName || "Przeciwnik" :
      heroName || (item.authorRole === "gm" && typeof item.name === "string" && item.name.length <= 200 ? item.name : null) ||
      (item.authorRole === "gm" ? "MG" : "Bohater");
    const entry = { id: item.id, heroId, heroName, ...(enemyId ? { enemyId } : {}), name, actor: config.actor,
      authorRole: item.authorRole, config, visibility, raw: rawDice, result, createdAt, at: createdAt };
    return { id: item.id, uid, payload: JSON.stringify({ restored: entry }), visibility, entry };
  });
}
function validateMethodInput(method, args, access, doc, heroVersion) {
  if (!GM_METHODS.has(method) || !Array.isArray(args) || args.length > 3) fail(400, "Nieznana komenda.");
  if (access.role === "player") {
    if (method === "adjustResource") {
      if (args.length !== 3 || args[0] !== "hero:" + access.heroId || !doc.state.heroParticipants.some(p => p.id === args[0] && p.heroId === access.heroId) || !["endurance", "hope"].includes(args[1]) || !Number.isFinite(args[2])) fail(403, "Możesz zmieniać tylko Wytrzymałość i Nadzieję swojego bohatera w walce.");
      return;
    }
    if (method === "toggleDefeated") {
      if (args.length !== 1 || args[0] !== "hero:" + access.heroId || !doc.state.heroParticipants.some(p => p.id === args[0] && p.heroId === access.heroId)) fail(403, "Możesz zmienić stan tylko swojego bohatera w walce.");
      return;
    }
    if (method !== "saveHero" || !isObject(args[0]) || args[0].id !== access.heroId || !doc.state.heroes.some(h => h.id === access.heroId)) fail(403, "Brak uprawnień do tej komendy.");
    const assigned = doc.state.heroes.find(h => h.id === access.heroId);
    if (Object.keys(args[0]).some(key => key !== "id" && (key === "defeated" || (!own(assigned, key) && !/^(weapon[0-3]|helm|shield)Enabled$/.test(key))))) fail(403, "To pole może zmieniać tylko mistrz gry.");
  }
  if (["addEnemy", "addLibrary"].includes(method) && args[0]?.might != null && (!finiteInt(args[0].might) || args[0].might > 5)) fail(400, "Potęga musi wynosić od 0 do 5.");
  if (method === "setEnemyNotes") {
    if (args.length !== 3 || args.some(value => typeof value !== "string")) fail(400, "Nieprawidłowe notatki przeciwnika.");
    const enemy = doc.state.battle.find(e => e.id === args[0]);
    if (!enemy) fail(404, "Przeciwnik został usunięty.");
    if (enemy.notes !== args[2]) fail(409, "Notatki zostały zmienione w innym oknie.");
  }
  if (method === "saveHero") {
    for (const [key, value] of Object.entries(args[0] || {})) {
      if (/^(weapon[0-3]|helm|shield)Enabled$/.test(key) && typeof value !== "boolean") fail(400, "Nieprawidłowy stan rynsztunku.");
    }
    if (own(args[0] || {}, "avatarId")) {
      const existing = doc.state.heroes.find(h => h.id === args[0].id);
      if ((args[0].avatarId || null) !== (existing?.avatarId || null)) fail(400, "Portret należy zmieniać osobno.");
    }
    const id = args[0] && args[0].id;
    if (!isObject(args[0]) || typeof args[0].name !== "string" && !id) fail(400, "Nieprawidłowy bohater.");
    if (id && doc.state.heroes.some(h => h.id === id) && heroVersion !== (doc.heroVersions[id] || 0)) fail(409, "Arkusz bohatera został zmieniony. Zachowaj szkic i odśwież dane.");
  }
  if (method === "restoreBackup" && access.role !== "gm") fail(403, "Brak uprawnień.");
}
function createServerCore({ repository, avatarStorage = { get: async () => null, put: async () => { throw new Error("Avatar storage unavailable"); } }, mapStorage = { get: async () => null, put: async () => { throw new Error("Map storage unavailable"); } }, hashSecret, randomSecret, encryptSecret, decryptSecret, catalog = [], now = () => new Date().toISOString() }) {
  if (!repository || !hashSecret || !randomSecret || !encryptSecret || !decryptSecret) throw new Error("Missing server dependency");
  async function verifyMapReferences(raw) {
    const checked = createStore(storageFor(raw));
    if (checked.loadError) fail(400, checked.loadError.message);
    const state = checked.getState();
    for (const { id, thumbnail } of mapRoles(state)) {
      const dataUrl = await mapStorage.get(id);
      if (!dataUrl || mapImage(dataUrl, hashSecret, thumbnail).id !== id) fail(400, "Brakuje poprawnego obrazu mapy.");
    }
    return state;
  }
  const project = (doc, access) => {
    const response = snapshot(doc, access);
    if (access.role === "gm") response.catalog = clone(catalog);
    return response;
  };
  async function read(uid, action, request) {
    const doc = await repository.get();
    const access = accessFor(doc, uid);
    if (action === "snapshot") {
      const revision = access.role === "gm" ? doc.revision : doc.publicRevision;
      if (Number.isSafeInteger(request.knownRevision) && request.knownRevision >= 0 &&
          request.knownRevision === revision && isObject(request.knownAccess) &&
          request.knownAccess.role === access.role && request.knownAccess.heroId === access.heroId) {
        return { unchanged: true, revision, access };
      }
      return project(doc, access);
    }
    if (action === "export") {
      if (access.role !== "gm") fail(403, "Brak uprawnień.");
      const avatars = {};
      for (const id of avatarIds(doc.state)) {
        const dataUrl = await avatarStorage.get(id);
        if (!dataUrl || avatarImage(dataUrl, hashSecret).id !== id) fail(500, "Brakuje obrazu portretu.");
        avatars[id] = dataUrl;
      }
      const maps = {};
      for (const { id, thumbnail } of mapRoles(doc.state)) {
        const dataUrl = await mapStorage.get(id);
        if (!dataUrl || mapImage(dataUrl, hashSecret, thumbnail).id !== id) fail(500, "Brakuje obrazu mapy.");
        maps[id] = dataUrl;
      }
      const current = await repository.get();
      if (accessFor(current, uid).role !== "gm") fail(403, "Brak uprawnień.");
      if (current.revision !== doc.revision || current.notebookVersion !== doc.notebookVersion) fail(409, "Stan gry zmienił się. Ponów eksport.");
      return { format: "onejournal", version: 2, state: clone(doc.state), rolls: doc.rolls.map(r => clone(r.entry)), avatars, maps, notebook: clone(doc.notebook || { blocks: [] }) };
    }
    if (action === "links") {
      if (access.role !== "gm") fail(403, "Brak uprawnień.");
      return doc.links.map(l => ({ heroId: l.heroId, role: l.role, secret: decryptSecret(l.encryptedSecret), active: l.active }));
    }
    fail(400, "Nieznane działanie.");
  }
  async function mutate(uid, request) {
    if (request.action === "notebookSave") {
      for (let attempt = 0; attempt < 5; attempt++) {
        const doc = await repository.get();
        const expected = doc.revision;
        if (accessFor(doc, uid).role !== "gm") fail(403, "Brak uprawnień.");
        if (!finiteInt(request.version)) fail(400, "Nieprawidłowa wersja notatnika.");
        let document;
        try { document = normalizeNotebook(request.document); } catch (error) { fail(400, error.message); }
        const version = doc.notebookVersion || 0;
        if (request.version !== version) {
          if (request.version === version - 1 && JSON.stringify(document) === JSON.stringify(doc.notebook || { blocks: [] })) {
            const response = project(doc, { role: "gm", heroId: null });
            response.result = { document: clone(doc.notebook), version };
            return response;
          }
          fail(409, "Notatnik został zmieniony. Odśwież dane przed zapisem.");
        }
        doc.notebook = document;
        doc.notebookVersion = version + 1;
        doc.revision = expected + 1;
        if (await repository.compareAndSwap(expected, doc, false)) {
          const response = project(doc, { role: "gm", heroId: null });
          response.result = { document: clone(document), version: doc.notebookVersion };
          return response;
        }
      }
      fail(409, "Notatnik został zmieniony. Odśwież dane przed zapisem.");
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const doc = await repository.get();
      const expected = doc.revision;
      let access, output, publicChange = true;
      if (request.action === "exchange") {
        if (typeof request.secret !== "string" || request.secret.length < 24 || request.secret.length > 256) fail(400, "Nieprawidłowy link.");
        const digest = hashSecret(request.secret);
        const link = doc.links.find(l => l.secretHash === digest && l.active);
        if (!link || link.role === "player" && !doc.state.heroes.some(h => h.id === link.heroId)) fail(403, "Link wygasł.");
        doc.grants = doc.grants.filter(g => g.uid !== uid);
        doc.grants.push({ uid, linkId: link.id, version: link.version, role: link.role, heroId: link.heroId, active: true });
        access = { role: link.role, heroId: link.heroId };
        publicChange = false;
      } else {
        access = accessFor(doc, uid);
        if (request.action === "mapUpload") {
          if (access.role !== "gm") fail(403, "Brak uprawnień.");
          if (typeof request.id !== "string" || !/^[\w-]{1,100}$/.test(request.id) || typeof request.name !== "string" || !request.name.trim() || request.name.length > 200) fail(400, "Nieprawidłowa nazwa mapy.");
          const image = mapImage(request.dataUrl, hashSecret);
          const thumbnail = mapImage(request.thumbnailDataUrl, hashSecret, true);
          const existing = doc.state.mapLibrary?.find(m => m.id === request.id);
          if (existing) {
            if (existing.name !== request.name.trim() || existing.imageId !== image.id || existing.thumbnailId !== thumbnail.id) fail(409, "ID mapy jest już użyte.");
            await mapStorage.put(image.id, image.dataUrl);
            await mapStorage.put(thumbnail.id, thumbnail.dataUrl);
            const response = project(doc, access); response.result = clone(existing); return response;
          }
          await mapStorage.put(image.id, image.dataUrl);
          await mapStorage.put(thumbnail.id, thumbnail.dataUrl);
          output = resultOf("addMap", [{ id: request.id, name: request.name, imageId: image.id, thumbnailId: thumbnail.id, uploadedAt: now() }], doc);
          publicChange = false;
        } else if (request.action === "avatarSet") {
          const hero = doc.state.heroes.find(h => h.id === request.heroId);
          if (!hero) fail(400, "Nieznany bohater.");
          if (access.role !== "gm" && access.heroId !== hero.id) fail(403, "Brak uprawnień do bohatera.");
          if (request.heroVersion !== (doc.heroVersions[hero.id] || 0)) fail(409, "Arkusz bohatera został zmieniony. Zachowaj szkic i odśwież dane.");
          let avatarId = null;
          if (request.dataUrl != null && request.dataUrl !== "") {
            const image = avatarImage(request.dataUrl, hashSecret);
            avatarId = image.id;
            await avatarStorage.put(avatarId, image.dataUrl);
          }
          hero.avatarId = avatarId;
          output = clone(hero);
          doc.heroVersions[hero.id] = (doc.heroVersions[hero.id] || 0) + 1;
        } else if (request.action === "command") {
          validateMethodInput(request.method, request.args, access, doc, request.heroVersion);
          const oldState = doc.state;
          const args = clone(request.args);
          if (request.method === "restoreBackup" && isObject(args[0]) && args[0].format === "onejournal") {
            if (![1, 2].includes(args[0].version) || !Array.isArray(args[0].rolls) || !isObject(args[0].state)) fail(400, "Nieprawidłowa kopia.");
            const wrapper = args[0];
            const checkedWrapper = createStore(storageFor(wrapper.state));
            if (checkedWrapper.loadError) fail(400, checkedWrapper.loadError.message);
            const wrapperState = checkedWrapper.getState();
            const ids = avatarIds(wrapper.state || { heroes: [] });
            if (wrapper.version === 2) {
              if (!isObject(wrapper.avatars) || Object.keys(wrapper.avatars).length !== ids.length || Object.keys(wrapper.avatars).some(id => !ids.includes(id) || wrapper.avatars[id] !== null)) fail(400, "Nieprawidłowy spis portretów.");
              for (const id of ids) {
                const dataUrl = await avatarStorage.get(id);
                if (!dataUrl || avatarImage(dataUrl, hashSecret).id !== id) fail(400, "Brakuje obrazu portretu.");
              }
              if (own(wrapper, "maps")) {
                const mapReferences = mapIds(wrapperState);
                if (!isObject(wrapper.maps) || Object.keys(wrapper.maps).length !== mapReferences.length || Object.keys(wrapper.maps).some(id => !mapReferences.includes(id) || wrapper.maps[id] !== null)) fail(400, "Nieprawidłowy spis map.");
                for (const { id, thumbnail } of mapRoles(wrapperState)) {
                  const dataUrl = await mapStorage.get(id);
                  if (!dataUrl || mapImage(dataUrl, hashSecret, thumbnail).id !== id) fail(400, "Brakuje obrazu mapy.");
                }
              } else if (mapIds(wrapperState).length) fail(400, "Brakuje obrazów map.");
            } else {
              if (ids.length) fail(400, "Brakuje obrazów portretów.");
              if (mapIds(wrapperState).length) fail(400, "Brakuje obrazów map.");
            }
            args[0] = wrapper.state;
            if (!own(args[0], "mapLibrary")) args[0].mapLibrary = clone(doc.state.mapLibrary || []);
            doc.rolls = restoredRolls(wrapper.rolls, uid);
            doc.rollEpoch = (doc.rollEpoch || 0) + 1;
            if (wrapper.version === 2 && Object.hasOwn(wrapper, "notebook")) {
              try { doc.notebook = normalizeNotebook(wrapper.notebook); } catch (error) { fail(400, error.message); }
              doc.notebookVersion = (doc.notebookVersion || 0) + 1;
            }
          }
          if (request.method === "restoreBackup" && (!isObject(request.args[0]) || request.args[0].format !== "onejournal") && avatarIds(args[0]).length) fail(400, "Brakuje obrazów portretów.");
          if (request.method === "restoreBackup" && (!isObject(request.args[0]) || request.args[0].format !== "onejournal")) {
            if (!isObject(args[0])) fail(400, "Nieprawidłowa kopia.");
            if (!own(args[0], "mapLibrary")) args[0].mapLibrary = clone(doc.state.mapLibrary || []);
          }
          if (request.method === "restoreBackup") await verifyMapReferences(args[0]);
          if (request.method === "setMap" && args[0]?.kind === "image") {
            if (typeof args[0].imageId !== "string" || !/^[a-f0-9]{64}$/.test(args[0].imageId)) fail(400, "Nieprawidłowy obraz mapy.");
            const dataUrl = await mapStorage.get(args[0].imageId);
            if (!dataUrl || mapImage(dataUrl, hashSecret).id !== args[0].imageId) fail(400, "Brakuje poprawnego obrazu mapy.");
          }
          if (request.method === "loadMap") {
            const selected = doc.state.mapLibrary?.find(m => m.id === args[0]);
            if (!selected) fail(400, "Nieznana mapa.");
            const dataUrl = await mapStorage.get(selected.imageId);
            if (!dataUrl || mapImage(dataUrl, hashSecret).id !== selected.imageId) fail(400, "Brakuje poprawnego obrazu mapy.");
          }
          if (request.method === "saveHero" && access.role === "gm" && args[0].id && !doc.state.heroes.some(h => h.id === args[0].id)) delete args[0].id;
          try { output = resultOf(request.method, args, doc); }
          catch (error) { fail(400, error.message || "Nieprawidłowa komenda."); }
          if (request.method === "saveHero") {
            const id = output.id;
            doc.heroVersions[id] = (doc.heroVersions[id] || 0) + 1;
          }
          if (["adjustResource", "toggleDefeated"].includes(request.method)) {
            const participant = oldState.heroParticipants.find(p => p.id === request.args[0]);
            if (participant) doc.heroVersions[participant.heroId] = (doc.heroVersions[participant.heroId] || 0) + 1;
          }
          if (request.method === "restoreBackup") {
            const versions = {};
            doc.state.heroes.forEach(h => { versions[h.id] = (doc.heroVersions[h.id] || 0) + 1; });
            doc.heroVersions = versions;
          }
          if (request.method === "deleteHero" || request.method === "restoreBackup") {
            const ids = new Set(doc.state.heroes.map(h => h.id));
            doc.links.forEach(l => { if (l.role === "player" && !ids.has(l.heroId)) { l.active = false; l.version++; } });
            doc.grants = doc.grants.filter(g => g.role === "gm" || ids.has(g.heroId));
          }
          if (request.method === "deleteHero") delete doc.heroVersions[request.args[0]];
          publicChange = !["addLibrary", "removeLibrary", "importLibrary", "removeMap", "setEnemyWound", "setEnemyWeary", "setEnemyNotes"].includes(request.method);
          if (request.method === "setEnemyWound") {
            const before = oldState.battle.find(enemy => enemy.id === request.args[0]);
            const after = doc.state.battle.find(enemy => enemy.id === request.args[0]);
            publicChange = !!before && !!after && (!!before.defeated !== !!after.defeated);
          }
          if (request.method === "adjustResource" || request.method === "removeParticipant" || request.method === "moveToken") {
            const target = request.args[0];
            publicChange = !!oldState.heroParticipants.some(p => p.id === target) || request.method === "moveToken" || request.method === "removeParticipant";
          }
        } else if (request.action === "rotateLink" || request.action === "revokeLink") {
          if (access.role !== "gm") fail(403, "Brak uprawnień.");
          const heroId = request.heroId;
          if (typeof heroId !== "string" || !doc.state.heroes.some(h => h.id === heroId)) fail(400, "Nieznany bohater.");
          let link = doc.links.find(l => l.role === "player" && l.heroId === heroId);
          if (request.action === "revokeLink") {
            if (link) { link.active = false; link.version++; }
            output = null;
          } else {
            const secret = randomSecret();
            if (link) { link.secretHash = hashSecret(secret); link.encryptedSecret = encryptSecret(secret); link.version++; link.active = true; }
            else { link = { id: randomSecret(), role: "player", heroId, secretHash: hashSecret(secret), encryptedSecret: encryptSecret(secret), version: 1, active: true }; doc.links.push(link); }
            output = { heroId, secret, active: true };
          }
          publicChange = false;
        } else if (request.action === "clearRolls") {
          if (access.role !== "gm") fail(403, "Brak uprawnień.");
          doc.rolls = [];
          doc.rollEpoch = (doc.rollEpoch || 0) + 1;
        } else if (request.action === "roll") {
          if (typeof request.id !== "string" || !/^[\w-]{8,80}$/.test(request.id)) fail(400, "Nieprawidłowe ID rzutu.");
          const config = cleanConfig(request.config);
          const enemyId = request.enemyId == null ? null : request.enemyId;
          if (enemyId !== null && (typeof enemyId !== "string" || !enemyId || enemyId.length > 100)) fail(400, "Nieprawidłowy przeciwnik rzutu.");
          if (enemyId && (access.role !== "gm" || config.actor !== "enemy")) fail(403, "Rzut przypisanego przeciwnika może wykonać tylko MG.");
          if (access.role === "player" && (config.actor !== "hero" || request.heroId !== access.heroId)) fail(403, "Brak uprawnień do rzutu.");
          if (access.role === "player" && config.privateRoll === true) fail(403, "Rzuty graczy są publiczne.");
          if (access.role === "player" && !doc.state.heroes.some(h => h.id === access.heroId)) fail(403, "Brak dostępu do bohatera.");
          const boundHeroId = request.boundHeroId == null ? null : request.boundHeroId;
          if (boundHeroId !== null && (typeof boundHeroId !== "string" || !boundHeroId || boundHeroId.length > 100)) fail(400, "Nieprawidłowy bohater rzutu.");
          if (boundHeroId && (access.role !== "gm" || config.actor !== "hero" || enemyId)) fail(403, "Rzut przypisanego bohatera może wykonać tylko MG w trybie bohatera.");
          const heroId = access.role === "player" ? access.heroId : boundHeroId;
          let interpretation;
          try { interpretation = DiceRules.interpretRoll(config, request.raw); } catch (error) { fail(400, error.message); }
          const rawDice = { feat: request.raw.feat.slice(), success: request.raw.success.slice() };
          // Legacy GM heroId remains generic; only explicit boundHeroId binds a sheet.
          // Preserve old payloads so retries from earlier clients still match.
          const payloadHeroId = access.role === "player" ? heroId : request.heroId || null;
          const payload = JSON.stringify({ heroId: payloadHeroId, config, raw: rawDice, ...(enemyId ? { enemyId } : {}), ...(boundHeroId ? { boundHeroId } : {}) });
          const prior = doc.rolls.find(r => r.id === request.id);
          if (prior) {
            if (prior.uid !== uid || prior.payload !== payload) fail(409, "ID rzutu jest już użyte.");
            return project(doc, access);
          }
          if ((request.rollEpoch ?? 0) !== (doc.rollEpoch || 0)) fail(409, "Dziennik został wyczyszczony. Ten rzut nie może zostać opublikowany; przygotuj nowy.");
          if (doc.rolls.length >= MAX_ROLLS) fail(409, "Dziennik osiągnął limit 10 000 rzutów. Wyeksportuj kopię przed dalszą grą.");
          const hero = heroId ? doc.state.heroes.find(h => h.id === heroId) : null;
          const enemy = enemyId ? doc.state.battle.find(e => e.id === enemyId) : null;
          if (boundHeroId && !hero) fail(409, "Bohater został usunięty. Otwórz panel kości ponownie.");
          if (enemyId && !enemy) fail(409, "Przeciwnik zniknął z potyczki. Otwórz panel kości ponownie.");
          if (enemy && config.enemyResource) {
            if (enemy.hate < 1) fail(409, "Brak Nienawiści lub Determinacji — nie zapisano rzutu ani nie wydano zasobu.");
            enemy.hate -= 1;
          }
          if (hero && config.hope) {
            if (hero.hope < 1) fail(409, "Brak Nadziei — nie zapisano rzutu ani nie wydano zasobu.");
            hero.hope -= 1;
            doc.heroVersions[heroId] = (doc.heroVersions[heroId] || 0) + 1;
          }
          const createdAt = now();
          const heroName = hero ? hero.name : null;
          const name = config.actor === "npc" ? "NPC" : config.actor === "enemy" ? enemy?.name || "MG" : heroName || (access.role === "gm" ? "MG" : "Bohater");
          const visibility = rollVisibility(config, access.role);
          const entry = { id: request.id, heroId, heroName, ...(enemyId ? { enemyId } : {}), name, actor: config.actor, authorRole: access.role, config, visibility, raw: rawDice, result: interpretation, createdAt, at: createdAt };
          doc.rolls.push({ id: request.id, uid, payload, visibility, entry });
          publicChange = visibility === "public" || !!(hero && config.hope);
        } else fail(400, "Nieznane działanie.");
      }
      doc.revision = expected + 1;
      if (publicChange) doc.publicRevision++;
      if (await repository.compareAndSwap(expected, doc, publicChange)) {
        if (request.action === "rotateLink") return output;
        const response = project(doc, access);
        if (request.action === "command") response.result = output === undefined ? null : output;
        if (request.action === "avatarSet" || request.action === "mapUpload") response.result = output;
        return response;
      }
    }
    fail(409, "Stan gry zmienił się. Spróbuj ponownie.");
  }
  return { defaultDocument, snapshot, handle(uid, request) {
    if (typeof uid !== "string" || !uid || !isObject(request)) fail(400, "Nieprawidłowe żądanie.");
    if (["snapshot", "export", "links"].includes(request.action)) return read(uid, request.action, request);
    if (["avatarGet", "avatarStage", "mapGet", "mapStage"].includes(request.action)) return (async () => {
      const doc = await repository.get();
      const access = accessFor(doc, uid);
      if (request.action === "mapStage") {
        if (access.role !== "gm") fail(403, "Brak uprawnień.");
        const image = mapImage(request.dataUrl, hashSecret, request.thumbnail === true);
        await mapStorage.put(image.id, image.dataUrl);
        return { imageId: image.id };
      }
      if (request.action === "mapGet") {
        const imageId = request.imageId;
        if (typeof imageId !== "string" || !/^[a-f0-9]{64}$/.test(imageId)) fail(400, "Nieprawidłowy obraz mapy.");
        const allowed = access.role === "gm" ? mapIds(doc.state).includes(imageId) : doc.state.map?.kind === "image" && doc.state.map.imageId === imageId;
        if (!allowed) fail(409, "Obraz mapy nie jest już dostępny.");
        const dataUrl = await mapStorage.get(imageId);
        const thumbnail = doc.state.mapLibrary?.some(m => m.thumbnailId === imageId && m.imageId !== imageId);
        if (!dataUrl || mapImage(dataUrl, hashSecret, thumbnail).id !== imageId) fail(500, "Brakuje obrazu mapy.");
        const current = await repository.get();
        const currentAccess = accessFor(current, uid);
        const stillAllowed = currentAccess.role === "gm" ? mapIds(current.state).includes(imageId) : current.state.map?.kind === "image" && current.state.map.imageId === imageId;
        if (!stillAllowed) fail(409, "Obraz mapy został zmieniony.");
        return { imageId, dataUrl };
      }
      if (request.action === "avatarStage") {
        if (access.role !== "gm") fail(403, "Brak uprawnień.");
        const image = avatarImage(request.dataUrl, hashSecret);
        await avatarStorage.put(image.id, image.dataUrl);
        return { avatarId: image.id };
      }
      const hero = doc.state.heroes.find(h => h.id === request.heroId);
      if (!hero) fail(400, "Nieznany bohater.");
      if (access.role !== "gm" && access.heroId !== hero.id) fail(403, "Brak uprawnień do bohatera.");
      const avatarId = hero.avatarId || null;
      if (!avatarId) return { avatarId: null, dataUrl: null };
      const dataUrl = await avatarStorage.get(avatarId);
      if (!dataUrl || avatarImage(dataUrl, hashSecret).id !== avatarId) fail(500, "Brakuje obrazu portretu.");
      const current = await repository.get();
      const currentAccess = accessFor(current, uid);
      if (currentAccess.role !== "gm" && currentAccess.heroId !== hero.id) fail(403, "Brak uprawnień do bohatera.");
      if (!current.state.heroes.some(h => h.id === hero.id && h.avatarId === avatarId)) fail(409, "Portret został zmieniony.");
      return { avatarId, dataUrl };
    })();
    return mutate(uid, request);
  } };
}
if (typeof module === "object" && module.exports) module.exports = { createServerCore, defaultDocument };
if (typeof globalThis !== "undefined") globalThis.OnejournalCore = { createServerCore, defaultDocument };
