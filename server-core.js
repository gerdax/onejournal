/* Portable, dependency-injected Onejournal command processor. */
"use strict";

const { createStore } = typeof require === "function" ? require("./state.js") : globalThis.OneRingState;
const DiceRules = typeof require === "function" ? require("./dice-rules.js") : globalThis.DiceRules;
const MAX_ROLLS = 10000;
const GM_METHODS = new Set(["addEnemy", "removeParticipant", "clearBattle", "clearEncounter", "toggleDefeated", "setEnemyWound", "adjustResource", "reorderEnemies", "addLibrary", "removeLibrary", "importLibrary", "saveHero", "deleteHero", "addHero", "setMap", "moveToken", "restoreBackup", "selectToken"]);
const own = (x, key) => Object.prototype.hasOwnProperty.call(x, key);
const clone = x => JSON.parse(JSON.stringify(x));
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
const isObject = x => x !== null && typeof x === "object" && !Array.isArray(x);
const finiteInt = x => Number.isInteger(x) && x >= 0;
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
  return { actor: config.actor, baseDice: config.baseDice, bonus: config.bonus, featMode: config.featMode, target,
    hope: config.hope, inspired: config.inspired, enemyResource: config.enemyResource, miserable: config.miserable, exhausted: config.exhausted };
};
const defaultDocument = () => ({ state: createStore(storageFor(null)).getState(), revision: 0, publicRevision: 0, heroVersions: {}, selection: null, rolls: [], links: [], grants: [] });
const publicMap = map => map ? {
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
  const state = gm ? clone(doc.state) : { version: 2, library: [], battle: [], heroes: doc.state.heroes.filter(h => h.id === access.heroId).map(clone), heroParticipants: doc.state.heroParticipants.filter(p => p.heroId === access.heroId).map(clone), map: publicMap(doc.state.map) };
  const versions = gm ? clone(doc.heroVersions) : { [access.heroId]: doc.heroVersions[access.heroId] || 0 };
  const publicParticipants = participantList(doc.state);
  const fullParticipants = createStore(storageFor(doc.state)).getParticipants();
  const participants = gm ? fullParticipants : publicParticipants.map(p =>
    p.type === "hero" && p.heroId === access.heroId ? fullParticipants.find(full => full.id === p.id) : p);
  return { state, participants, access, revision: gm ? doc.revision : doc.publicRevision, heroVersions: versions, selection: doc.selection, rolls: doc.rolls.filter(r => gm || r.visibility === "public").map(r => clone(r.entry)) };
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
    const name = config.actor === "npc" ? "NPC" : config.actor === "enemy" ? "Przeciwnik" : heroName || "Bohater";
    const entry = { id: item.id, heroId, heroName, name, actor: config.actor,
      authorRole: item.authorRole, config, raw: rawDice, result, createdAt, at: createdAt };
    return { id: item.id, uid, payload: JSON.stringify({ restored: entry }), visibility: config.actor === "hero" ? "public" : "private", entry };
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
    if (Object.keys(args[0]).some(key => key !== "id" && (key === "defeated" || !own(assigned, key)))) fail(403, "To pole może zmieniać tylko mistrz gry.");
  }
  if (method === "saveHero") {
    const id = args[0] && args[0].id;
    if (!isObject(args[0]) || typeof args[0].name !== "string" && !id) fail(400, "Nieprawidłowy bohater.");
    if (id && doc.state.heroes.some(h => h.id === id) && heroVersion !== (doc.heroVersions[id] || 0)) fail(409, "Arkusz bohatera został zmieniony. Zachowaj szkic i odśwież dane.");
  }
  if (method === "restoreBackup" && access.role !== "gm") fail(403, "Brak uprawnień.");
}
function createServerCore({ repository, hashSecret, randomSecret, encryptSecret, decryptSecret, catalog = [], now = () => new Date().toISOString() }) {
  if (!repository || !hashSecret || !randomSecret || !encryptSecret || !decryptSecret) throw new Error("Missing server dependency");
  const project = (doc, access) => {
    const response = snapshot(doc, access);
    if (access.role === "gm") response.catalog = clone(catalog);
    return response;
  };
  async function read(uid, action) {
    const doc = await repository.get();
    const access = accessFor(doc, uid);
    if (action === "snapshot") return project(doc, access);
    if (action === "export") {
      if (access.role !== "gm") fail(403, "Brak uprawnień.");
      return { format: "onejournal", version: 1, state: clone(doc.state), rolls: doc.rolls.map(r => clone(r.entry)) };
    }
    if (action === "links") {
      if (access.role !== "gm") fail(403, "Brak uprawnień.");
      return doc.links.map(l => ({ heroId: l.heroId, role: l.role, secret: decryptSecret(l.encryptedSecret), active: l.active }));
    }
    fail(400, "Nieznane działanie.");
  }
  async function mutate(uid, request) {
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
        if (request.action === "command") {
          validateMethodInput(request.method, request.args, access, doc, request.heroVersion);
          const oldState = doc.state;
          const args = clone(request.args);
          if (request.method === "restoreBackup" && isObject(args[0]) && args[0].format === "onejournal") {
            if (args[0].version !== 1 || !Array.isArray(args[0].rolls)) fail(400, "Nieprawidłowa kopia.");
            const wrapper = args[0];
            args[0] = wrapper.state;
            doc.rolls = restoredRolls(wrapper.rolls, uid);
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
          publicChange = !["addLibrary", "removeLibrary", "importLibrary", "setEnemyWound"].includes(request.method);
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
        } else if (request.action === "roll") {
          if (typeof request.id !== "string" || !/^[\w-]{8,80}$/.test(request.id)) fail(400, "Nieprawidłowe ID rzutu.");
          const config = cleanConfig(request.config);
          if (access.role === "player" && (config.actor !== "hero" || request.heroId !== access.heroId)) fail(403, "Brak uprawnień do rzutu.");
          if (access.role === "player" && !doc.state.heroes.some(h => h.id === access.heroId)) fail(403, "Brak dostępu do bohatera.");
          const heroId = access.role === "player" ? access.heroId : null;
          let interpretation;
          try { interpretation = DiceRules.interpretRoll(config, request.raw); } catch (error) { fail(400, error.message); }
          const rawDice = { feat: request.raw.feat.slice(), success: request.raw.success.slice() };
          // Keep the request's legacy GM heroId in the idempotency key even though
          // newly stored GM hero rolls are generic and do not bind a sheet.
          const payloadHeroId = access.role === "player" ? heroId : request.heroId || null;
          const payload = JSON.stringify({ heroId: payloadHeroId, config, raw: rawDice });
          const prior = doc.rolls.find(r => r.id === request.id);
          if (prior) {
            if (prior.uid !== uid || prior.payload !== payload) fail(409, "ID rzutu jest już użyte.");
            return project(doc, access);
          }
          if (doc.rolls.length >= MAX_ROLLS) fail(409, "Dziennik osiągnął limit 10 000 rzutów. Wyeksportuj kopię przed dalszą grą.");
          const hero = heroId ? doc.state.heroes.find(h => h.id === heroId) : null;
          const createdAt = now();
          const heroName = hero ? hero.name : null;
          const name = config.actor === "npc" ? "NPC" : config.actor === "enemy" ? "Przeciwnik" : heroName || "Bohater";
          const entry = { id: request.id, heroId, heroName, name, actor: config.actor, authorRole: access.role, config, raw: rawDice, result: interpretation, createdAt, at: createdAt };
          doc.rolls.push({ id: request.id, uid, payload, visibility: config.actor === "hero" ? "public" : "private", entry });
          publicChange = config.actor === "hero";
        } else fail(400, "Nieznane działanie.");
      }
      doc.revision = expected + 1;
      if (publicChange) doc.publicRevision++;
      if (await repository.compareAndSwap(expected, doc, publicChange)) {
        if (request.action === "rotateLink") return output;
        const response = project(doc, access);
        if (request.action === "command") response.result = output === undefined ? null : output;
        return response;
      }
    }
    fail(409, "Stan gry zmienił się. Spróbuj ponownie.");
  }
  return { defaultDocument, snapshot, handle(uid, request) {
    if (typeof uid !== "string" || !uid || !isObject(request)) fail(400, "Nieprawidłowe żądanie.");
    if (["snapshot", "export", "links"].includes(request.action)) return read(uid, request.action);
    return mutate(uid, request);
  } };
}
if (typeof module === "object" && module.exports) module.exports = { createServerCore, defaultDocument };
if (typeof globalThis !== "undefined") globalThis.OnejournalCore = { createServerCore, defaultDocument };
