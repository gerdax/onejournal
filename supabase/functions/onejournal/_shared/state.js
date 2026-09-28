/* Shared, persistent state for the One Ring encounter tools. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.OneRingState = api;
    // The online app installs its authenticated store during bootstrap. Never
    // read bestiary's localStorage merely by opening onejournal.
  }
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const KEY = "one-ring-state"; // Legacy backup/memory engine; never browser storage.
  const CATEGORIES = { Ork: "Orkowie", Goblin: "Orkowie", Bestia: "Wilki i bestie", Upiór: "Upiory", Człowiek: "Źli ludzie" };
  const TERRAIN_KINDS = new Set(["tree", "shrub", "log", "boulder", "grass", "wall", "rubble", "pillar", "pool", "crystal", "stalagmite"]);
  const HERO_STRINGS = ["name", "culture", "weapons", "proficiencies", "stance", "conditions", "notes", "age", "treasure", "calling", "culturalBlessing", "distinctiveFeatures", "flaws", "patron", "shadowPath", "injury", "rewards", "virtues", "equipment", "standardOfLiving", "armourName", "helmName", "shieldName"];
  const HERO_NUMBERS = ["strength", "heart", "wits", "strengthTN", "heartTN", "witsTN", "endurance", "maxEndurance", "hope", "maxHope", "shadow", "load", "fatigue", "parry", "armour", "shadowScars", "valour", "wisdom", "adventurePoints", "skillPoints", "fellowship", "helmProtection", "armourLoad", "helmLoad", "shieldParry", "shieldLoad"];
  const HERO_BOOLEANS = ["weary", "miserable", "wounded"];
  const HERO_SKILLS = ["Awareness", "Song", "Hunting", "Awe", "Craft", "Athletics", "Insight", "Courtesy", "Healing", "Enhearten", "Battle", "Travel", "Scan", "Riddle", "Explore", "Persuade", "Lore", "Stealth"];
  const HERO_COMBAT = ["combatBows", "combatSwords", "combatAxes", "combatSpears"];
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const copy = value => JSON.parse(JSON.stringify(value));
  const id = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const blank = () => ({ version: 2, library: [], battle: [], heroes: [], heroParticipants: [], map: null });

  function enemy(raw, battleEntry) {
    if (!object(raw) || typeof raw.name !== "string" || !raw.name.trim()) throw new Error("Przeciwnik musi mieć nazwę.");
    const kind = raw.kind || "Bestia";
    const maxEndurance = Math.max(0, number(raw.maxEndurance, number(raw.endurance, 0)));
    const maxHate = Math.max(0, number(raw.maxHate, number(raw.hate, 0)));
    const result = Object.assign({}, raw, {
      id: typeof raw.id === "string" && raw.id ? raw.id : id(), kind,
      notes: typeof raw.notes === "string" ? raw.notes : "",
      resourceType: ["hate", "determination"].includes(raw.resourceType) ? raw.resourceType : (kind === "Człowiek" ? "determination" : "hate"),
      category: raw.category || CATEGORIES[kind] || "Własne", source: raw.source === "Mój szablon" ? "Własne" : (raw.source || "Własne"),
      fierceness: number(raw.fierceness, 3), might: number(raw.might, 1), maxEndurance, maxHate,
      endurance: clamp(number(raw.endurance, maxEndurance), 0, maxEndurance),
      hate: clamp(number(raw.hate, maxHate), 0, maxHate), defeated: !!raw.defeated
    });
    if (battleEntry) {
      const count = clamp(Math.floor(result.might), 0, 10);
      result.wounds = Array.from({ length: count }, (_, index) => !!(Array.isArray(raw.wounds) && raw.wounds[index]));
    } else delete result.wounds;
    return result;
  }

  function hero(raw) {
    if (!object(raw) || typeof raw.name !== "string" || !raw.name.trim()) throw new Error("Bohater musi mieć imię.");
    const result = { id: typeof raw.id === "string" && raw.id ? raw.id : id() };
    HERO_STRINGS.forEach(field => { result[field] = raw[field] == null ? (field === "stance" ? "Wyważona" : "") : String(raw[field]); });
    HERO_NUMBERS.forEach(field => { result[field] = Math.max(0, number(raw[field], 0)); });
    result.shadow = Math.max(result.shadow, result.shadowScars);
    HERO_BOOLEANS.forEach(field => { result[field] = !!raw[field]; });
    HERO_SKILLS.forEach(name => {
      result["skill" + name] = clamp(Math.trunc(number(raw["skill" + name], 0)), 0, 6);
      result["skill" + name + "Favoured"] = !!raw["skill" + name + "Favoured"];
    });
    HERO_COMBAT.forEach(field => { result[field] = clamp(Math.trunc(number(raw[field], 0)), 0, 6); });
    for (let index = 0; index < 4; index++) {
      ["Name", "Damage", "Injury", "Load", "Notes"].forEach(suffix => {
        const field = "weapon" + index + suffix;
        result[field] = raw[field] == null ? "" : String(raw[field]);
      });
    }
    result.endurance = clamp(result.endurance, 0, result.maxEndurance);
    result.hope = clamp(result.hope, 0, result.maxHope);
    result.defeated = !!raw.defeated;
    return result;
  }

  function mapShape(raw, participants) {
    if (raw === null) return null;
    if (!object(raw) || !["forest", "clearing", "ruins", "cave", "forest_clearing", "forest_crossroads", "road", "river", "river_ford", "marsh", "ravine"].includes(raw.scene) || !["small", "medium", "large"].includes(raw.size) || !(typeof raw.seed === "string" || Number.isFinite(raw.seed)) || !Number.isInteger(raw.width) || !Number.isInteger(raw.height) || raw.width < 65 || raw.height < 65 || !Array.isArray(raw.terrain) || !object(raw.positions)) throw new Error("Invalid map");
    const allowed = new Set(participants);
    const positions = {};
    Object.keys(raw.positions).forEach(pid => {
      const p = raw.positions[pid];
      if (!allowed.has(pid) || !object(p) || !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0 || p.x >= raw.width || p.y >= raw.height) throw new Error("Invalid map position");
      positions[pid] = { x: p.x, y: p.y };
    });
    const terrain = raw.terrain.map(tile => {
      if (!object(tile) || !TERRAIN_KINDS.has(tile.kind) || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) || !Number.isInteger(tile.r) || !Number.isInteger(tile.rotation) || !Number.isInteger(tile.variant) || tile.x < 0 || tile.x >= raw.width || tile.y < 0 || tile.y >= raw.height || tile.r < 0 || tile.variant < 0) throw new Error("Invalid terrain");
      return copy(tile);
    });
    const result = { scene: raw.scene, size: raw.size, seed: raw.seed, width: raw.width, height: raw.height, terrain, positions };
    if (Object.hasOwn(raw, "features")) {
      if (!Array.isArray(raw.features) || raw.features.length > 64) throw new Error("Invalid map features");
      result.features = raw.features.map(feature => {
        if (!object(feature) || !["trail", "river", "ford"].includes(feature.kind) || !Number.isInteger(feature.width) || feature.width <= 0 || feature.width > Math.max(raw.width, raw.height) || !Array.isArray(feature.points) || feature.points.length < 2 || feature.points.length > 64) throw new Error("Invalid map feature");
        const points = feature.points.map(point => {
          if (!object(point) || !Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.y < 0 || point.x >= raw.width || point.y >= raw.height) throw new Error("Invalid map feature point");
          return { x: point.x, y: point.y };
        });
        return { kind: feature.kind, width: feature.width, points };
      });
    }
    return result;
  }

  function validate(raw) {
    if (!object(raw) || raw.version !== 2 || !Array.isArray(raw.library) || !Array.isArray(raw.battle) || !Array.isArray(raw.heroes) || !Array.isArray(raw.heroParticipants)) throw new Error("Unsupported or invalid backup");
    const result = blank();
    result.library = raw.library.map(x => enemy(x, false));
    result.battle = raw.battle.map(x => enemy(x, true));
    result.heroes = raw.heroes.map(hero);
    const unique = (items, label) => { const all = new Set(); items.forEach(x => { if (all.has(x.id)) throw new Error("Duplicate " + label + " id"); all.add(x.id); }); return all; };
    const libraryIds = unique(result.library, "library"); const battleIds = unique(result.battle, "battle"); const heroIds = unique(result.heroes, "hero");
    battleIds.forEach(x => { if (libraryIds.has(x) || heroIds.has(x)) throw new Error("Duplicate entity id"); });
    heroIds.forEach(x => { if (libraryIds.has(x)) throw new Error("Duplicate entity id"); });
    const participantIds = new Set();
    result.heroParticipants = raw.heroParticipants.map(p => {
      if (!object(p) || typeof p.id !== "string" || typeof p.heroId !== "string" || p.id !== "hero:" + p.heroId || !heroIds.has(p.heroId) || participantIds.has(p.id)) throw new Error("Invalid hero participant");
      participantIds.add(p.id); return { id: p.id, heroId: p.heroId };
    });
    battleIds.forEach(x => { if (participantIds.has(x)) throw new Error("Duplicate participant id"); participantIds.add(x); });
    result.map = mapShape(raw.map == null ? null : raw.map, participantIds);
    return result;
  }

  function createStore(storage) {
    const safeStorage = storage && typeof storage.getItem === "function" && typeof storage.setItem === "function" ? storage : null;
    let state = blank(), listeners = [], loadError = null;
    const read = key => safeStorage ? safeStorage.getItem(key) : null;
    const parse = key => { const text = read(key); if (text === null) return { found: false, value: null }; try { return { found: true, value: JSON.parse(text) }; } catch (error) { return { found: true, error }; } };
    const current = parse(KEY);
    if (current.found) { try { if (current.error) throw current.error; state = validate(current.value); } catch (error) { state = blank(); loadError = error instanceof Error ? error : new Error("Invalid saved state"); } }
    else {
      const legacyBattle = parse("one-ring-battle"), legacyLibrary = parse("one-ring-library");
      if (legacyBattle.found || legacyLibrary.found) {
        try {
          if (legacyBattle.error || legacyLibrary.error || (legacyBattle.found && !Array.isArray(legacyBattle.value)) || (legacyLibrary.found && !Array.isArray(legacyLibrary.value))) throw new Error("Malformed legacy state");
          state.battle = (legacyBattle.value || []).map(x => enemy(x, true));
          state.library = (legacyLibrary.value || []).map(x => enemy(x, false));
        } catch (error) { state = blank(); loadError = error instanceof Error ? error : new Error("Malformed legacy state"); }
      }
    }
    const participantIds = () => new Set(state.battle.map(x => x.id).concat(state.heroParticipants.map(x => x.id)));
    function stage() {
      if (!state.map) return;
      const positions = {}, occupied = new Set(); let heroSlot = 0, enemySlot = 0;
      const heroIds = new Set(state.heroParticipants.map(x => x.id));
      const ordered = state.heroParticipants.map(x => x.id).concat(state.battle.map(x => x.id));
      ordered.forEach(pid => { const p = state.map.positions[pid]; if (p) occupied.add(p.x + ":" + p.y); });
      ordered.forEach(pid => {
        const prior = state.map.positions[pid];
        if (prior) { const p = { x: clamp(prior.x, 0, state.map.width - 1), y: clamp(prior.y, 0, state.map.height - 1) }; positions[pid] = p; occupied.add(p.x + ":" + p.y); return; }
        const enemySide = !heroIds.has(pid);
        let slot = enemySide ? enemySlot++ : heroSlot++, candidate, attempts = 0;
        const capacity = Math.max(1, Math.ceil(state.map.width / 72) * Math.ceil(state.map.height / 72));
        do {
          const column = Math.floor(slot / Math.max(1, Math.floor((state.map.height - 128) / 72) + 1));
          const row = slot % Math.max(1, Math.floor((state.map.height - 128) / 72) + 1);
          const center = Math.round(state.map.height / 2), offset = row === 0 ? 0 : (row % 2 ? Math.ceil(row / 2) : -row / 2) * 72;
          candidate = { x: clamp(enemySide ? state.map.width - 64 - column * 72 : 64 + column * 72, 32, state.map.width - 33), y: clamp(center + offset, 32, state.map.height - 33) };
          slot++;
        } while (occupied.has(candidate.x + ":" + candidate.y) && ++attempts < capacity);
        if (enemySide) enemySlot = Math.max(enemySlot, slot); else heroSlot = Math.max(heroSlot, slot);
        positions[pid] = candidate; occupied.add(candidate.x + ":" + candidate.y);
      });
      state.map.positions = positions;
    }
    function commit() { stage(); if (safeStorage) safeStorage.setItem(KEY, JSON.stringify(state)); const snapshot = copy(state); listeners.slice().forEach(fn => { try { fn(snapshot); } catch (error) { console.error("State observer failed", error); } }); }
    function mutate(fn) { if (loadError) throw new Error("Saved state is malformed; use restoreBackup() to recover", { cause: loadError }); const previous = copy(state); try { const result = fn(); commit(); return result; } catch (error) { state = previous; throw error; } }
    return {
      get loadError() { return loadError; },
      getState: () => copy(state),
      getParticipants: () => state.battle.map(x => Object.assign({}, copy(x), { type: "enemy" })).concat(state.heroParticipants.map(p => { const h = state.heroes.find(x => x.id === p.heroId); return Object.assign({}, copy(h), { id: p.id, heroId: h.id, type: "hero" }); })),
      subscribe(fn) { if (typeof fn !== "function") throw new TypeError("Listener must be a function"); listeners.push(fn); return () => { listeners = listeners.filter(x => x !== fn); }; },
      addEnemy(raw) { return mutate(() => { const e = enemy(raw, true); e.id = id(); e.endurance = e.maxEndurance; e.hate = e.maxHate; e.defeated = false; e.wounds.fill(false); state.battle.push(e); return copy(e); }); },
      removeParticipant(pid) { return mutate(() => { const before = state.battle.length + state.heroParticipants.length; state.battle = state.battle.filter(x => x.id !== pid); state.heroParticipants = state.heroParticipants.filter(x => x.id !== pid); return before !== state.battle.length + state.heroParticipants.length; }); },
      clearEncounter() { return mutate(() => { state.battle = []; state.heroParticipants = []; state.map = null; }); },
      clearBattle() { return mutate(() => { state.battle = []; state.heroParticipants = []; }); },
      toggleDefeated(pid) { return mutate(() => { const e = state.battle.find(x => x.id === pid); if (e) e.defeated = !e.defeated; else { const p = state.heroParticipants.find(x => x.id === pid), h = p && state.heroes.find(x => x.id === p.heroId); if (h) h.defeated = !h.defeated; } }); },
      setEnemyWound(pid, index, checked) { return mutate(() => { if (!Number.isInteger(index) || index < 0) throw new RangeError("Invalid enemy wound index"); if (typeof checked !== "boolean") throw new TypeError("Enemy wound value must be boolean"); const e = state.battle.find(x => x.id === pid); if (!e) return; if (index >= e.wounds.length) throw new RangeError("Invalid enemy wound index"); const newlyChecked = checked && !e.wounds[index]; e.wounds[index] = checked; if (newlyChecked && e.wounds.every(Boolean)) e.defeated = true; }); },
      adjustResource(pid, field, delta) { return mutate(() => { const e = state.battle.find(x => x.id === pid); const p = state.heroParticipants.find(x => x.id === pid); const target = e || (p && state.heroes.find(x => x.id === p.heroId)); if (!target) return; const maxima = { endurance: "maxEndurance", hate: "maxHate", hope: "maxHope" }; if (!(field in maxima) || !Number.isFinite(Number(delta)) || !(field in target)) return; target[field] = clamp(number(target[field], 0) + Number(delta), 0, number(target[maxima[field]], 0)); }); },
      reorderEnemies(ids) { return mutate(() => { if (!Array.isArray(ids) || ids.length !== state.battle.length || new Set(ids).size !== ids.length || ids.some(x => !state.battle.some(e => e.id === x))) throw new Error("Invalid enemy order"); state.battle.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); }); },
      saveHero(data) { return mutate(() => { const input = Object.assign({}, data); const existing = input.id && state.heroes.find(x => x.id === input.id); if (input.wounded === false || (Object.hasOwn(input, "injury") && !(Object.hasOwn(input, "wounded") ? input.wounded : existing && existing.wounded))) input.injury = ""; const saved = hero(Object.assign({}, existing || {}, input, { id: existing ? existing.id : (input.id || id()) })); const index = state.heroes.findIndex(x => x.id === saved.id); if (index >= 0) state.heroes[index] = saved; else state.heroes.push(saved); return copy(saved); }); },
      deleteHero(heroId) { return mutate(() => { state.heroes = state.heroes.filter(x => x.id !== heroId); state.heroParticipants = state.heroParticipants.filter(x => x.heroId !== heroId); }); },
      addHero(heroId) { return mutate(() => { if (!state.heroes.some(x => x.id === heroId)) throw new Error("Unknown hero"); const pid = "hero:" + heroId; if (!state.heroParticipants.some(x => x.id === pid)) state.heroParticipants.push({ id: pid, heroId }); return { id: pid, heroId }; }); },
      setMap(raw) { return mutate(() => { state.map = mapShape(raw, participantIds()); if (state.map) state.map.positions = {}; }); },
      moveToken(pid, x, y) { return mutate(() => { if (!state.map || !participantIds().has(pid) || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return; state.map.positions[pid] = { x: clamp(Math.round(Number(x)), 32, state.map.width - 33), y: clamp(Math.round(Number(y)), 32, state.map.height - 33) }; }); },
      addLibrary(raw) { return mutate(() => { const e = enemy(raw, false); if (state.library.some(x => x.id === e.id)) e.id = id(); state.library.push(e); return copy(e); }); },
      removeLibrary(libraryId) { return mutate(() => { state.library = state.library.filter(x => x.id !== libraryId); }); },
      importLibrary(data) { return mutate(() => { const entries = Array.isArray(data) ? data : data && data.library; if (!Array.isArray(entries)) throw new Error("Invalid library import"); let added = 0; entries.forEach(raw => { if (!object(raw) || !String(raw.name || "").trim()) return; const e = enemy(raw, false); e.source = "Własne"; const duplicate = state.library.some(x => x.name === e.name && x.kind === e.kind && x.maxEndurance === e.maxEndurance && x.maxHate === e.maxHate && x.attack === e.attack && x.traits === e.traits && x.notes === e.notes); if (!duplicate) { if (state.library.some(x => x.id === e.id)) e.id = id(); state.library.push(e); added++; } }); return added; }); },
      exportBackup: () => copy(state),
      restoreBackup(data) { const checked = validate(data), previous = state, previousError = loadError; try { state = checked; loadError = null; commit(); } catch (error) { state = previous; loadError = previousError; throw error; } }
    };
  }
  return { createStore };
});
