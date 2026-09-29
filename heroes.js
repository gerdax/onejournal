(function () {
  "use strict";
  const loadParts = ["weapon0Load", "weapon1Load", "weapon2Load", "weapon3Load", "armourLoad", "helmLoad", "shieldLoad", "treasure"];
  function resourceNumber(value) {
    if (value == null || String(value).trim() === "") return 0;
    const number = Number(String(value).trim().replace(",", "."));
    return Number.isFinite(number) ? number : NaN;
  }
  function getResourceWarnings(person) {
    const endurance = resourceNumber(person.endurance), load = resourceNumber(person.load);
    const fatigue = resourceNumber(person.fatigue), hope = resourceNumber(person.hope), shadow = resourceNumber(person.shadow);
    const expectedLoad = loadParts.reduce((sum, field) => sum + resourceNumber(person[field]), 0);
    return {
      endurance: !person.weary && Number.isFinite(endurance) && Number.isFinite(load + fatigue) && endurance <= load + fatigue,
      hope: !person.miserable && Number.isFinite(hope) && Number.isFinite(shadow) && hope <= shadow,
      load: Number.isFinite(load) && Number.isFinite(expectedLoad) && Math.abs(load - expectedLoad) > 1e-9,
      weary: !!person.weary && Number.isFinite(endurance) && Number.isFinite(load + fatigue) && endurance > load + fatigue,
      miserable: !!person.miserable && Number.isFinite(hope) && Number.isFinite(shadow) && hope > shadow,
      expectedLoad
    };
  }
  function updateResourceWarnings(editor) {
    const person = {};
    for (const field of ["endurance", "load", "fatigue", "hope", "shadow", ...loadParts]) person[field] = editor.elements[field].value;
    person.weary = editor.elements.weary.checked;
    person.miserable = editor.elements.miserable.checked;
    const warnings = getResourceWarnings(person);
    for (const field of ["endurance", "hope", "load"]) editor.elements[field].classList.toggle("is-resource-warning", warnings[field]);
    for (const field of ["weary", "miserable"]) editor.elements[field].closest("label").querySelector("span").classList.toggle("is-resource-warning", warnings[field]);
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { getResourceWarnings, updateResourceWarnings };
  const store = typeof window !== "undefined" && window.OneRingStore;
  const host = typeof document !== "undefined" && document.getElementById("heroes"), battleList = typeof document !== "undefined" && document.getElementById("hero-battle-list");
  if (!host || !battleList || !store) return;
  const fields = ["name", "culture", "strength", "heart", "wits", "strengthTN", "heartTN", "witsTN", "endurance", "maxEndurance", "hope", "maxHope", "shadow", "load", "fatigue", "parry", "armour", "weapons", "proficiencies", "stance", "conditions", "notes"];
  const numeric = new Set(["strength", "heart", "wits", "strengthTN", "heartTN", "witsTN", "endurance", "maxEndurance", "hope", "maxHope", "shadow", "load", "fatigue", "parry", "armour"]);
  const skillGroups = [
    [["Awareness", "Czujność"], ["Song", "Pieśni"], ["Hunting", "Polowanie"], ["Awe", "Respekt"], ["Craft", "Rzemiosło"], ["Athletics", "Zwinność"]],
    [["Insight", "Przenikliwość"], ["Courtesy", "Uprzejmość"], ["Healing", "Uzdrawianie"], ["Enhearten", "Inspiracja"], ["Battle", "Wojaczka"], ["Travel", "Wędrówka"]],
    [["Scan", "Szukanie"], ["Riddle", "Zagadki"], ["Explore", "Rekonesans"], ["Persuade", "Przekonywanie"], ["Lore", "Wiedza"], ["Stealth", "Skradanie"]]
  ];
  const booleans = new Set(["weary", "miserable", "wounded"]);
  fields.push("age", "treasure", "calling", "culturalBlessing", "distinctiveFeatures", "flaws", "patron", "shadowPath", "injury", "rewards", "virtues", "equipment", "standardOfLiving", "armourName", "helmName", "shieldName");
  ["shadowScars", "valour", "wisdom", "adventurePoints", "skillPoints", "fellowship", "helmProtection", "armourLoad", "helmLoad", "shieldParry", "shieldLoad", "combatBows", "combatSwords", "combatAxes", "combatSpears"].forEach(name => { fields.push(name); numeric.add(name); });
  skillGroups.flat().forEach(([key]) => { const name = "skill" + key; fields.push(name); numeric.add(name); booleans.add(name + "Favoured"); });
  fields.push(...booleans);
  for (let i = 0; i < 4; i++) ["Name", "Damage", "Injury", "Load", "Notes"].forEach(key => fields.push(`weapon${i}${key}`));
  let editingId = null, draftDirty = false, draftVersion = null;
  const dirtyFields = new Set(), conflictFields = new Set();
  const listCards = new Map();
  // View preferences belong to the editor, not to individual hero records.
  const sectionOpen = { character: true, attributes: true, gear: true, equipment: true };
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
  const heroById = id => store.getState().heroes.find(h => h.id === id);
  const isPlayer = () => store.access?.role === "player";
  const canSave = () => store.connection === "online" && store.canWrite;
  const saveError = error => error?.message || "Nie udało się zapisać zmiany.";
  const conflictStatus = "Konflikt zapisu. Zmiany zachowano; edytuj pole, aby zapisać swoją wersję.";

  host.innerHTML = `<div class="section-heading hero-heading"><div><h2>Drużyna</h2></div><button type="button" class="text-button" data-hero-action="new">+ Nowy bohater</button></div><div class="heroes-layout"><div id="hero-list" class="hero-list" role="tablist" aria-label="Arkusze bohaterów"></div><div id="hero-empty-panel" class="hero-empty" hidden>Nie ma jeszcze bohaterów. Użyj „Nowy bohater”, aby utworzyć pierwszy arkusz.</div><form id="hero-editor" class="paper form-card hero-editor" role="tabpanel" aria-label="Arkusz bohatera" novalidate></form></div>`;
  const list = host.querySelector("#hero-list"), form = host.querySelector("#hero-editor");

  function field(label, name, type = "text", extra = "") { return `<label>${label}<input name="${name}" type="${type}" ${extra}></label>`; }
  const displayValue = (control, value) => value == null || value === "" ? (control.type === "number" ? "0" : "") : String(value);
  function drawEditor(hero, target = form, preferences = sectionOpen, embedded = false) {
    const form = target, sectionOpen = preferences;
    form.querySelectorAll('[data-sheet-section]').forEach(section => {
      sectionOpen[section.dataset.sheetSection] = section.open;
    });
    const value = name => hero && hero[name] != null ? hero[name] : (numeric.has(name) ? 0 : name === "stance" ? "Wyważona" : "");
    const input = name => String(!hero && numeric.has(name) ? 0 : value(name)).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const textField = (label, name, cls = "") => `<div class="${cls}">${field(label, name, "text", `maxlength="300" value="${input(name)}"`)}</div>`;
    const numberField = (label, name) => field(label, name, "number", `min="0" value="${input(name) || 0}"`);
    const area = (label, name, rows = 3) => `<label>${label}<textarea name="${name}" rows="${rows}" maxlength="4000"></textarea></label>`;
    const check = (label, name) => `<label class="sheet-check"><input type="checkbox" name="${name}" ${value(name) ? "checked" : ""}><span>${label}</span></label>`;
    const rating = (label, name, favoured = false) => `<div class="skill-row">${favoured ? `<input type="checkbox" name="${name}Favoured" aria-label="${label}: umiejętność ulubiona" ${value(name + "Favoured") ? "checked" : ""}>` : ""}<span id="${form.id}-label-${name}">${label}</span><select class="skill-rating" name="${name}" aria-labelledby="${form.id}-label-${name}">${Array.from({length: 7}, (_, n) => `<option value="${n}">${n ? "◆".repeat(n) : "—"}</option>`).join("")}</select></div>`;
    const attributes = [["Siła", "strength", "strengthTN", "Max wytrz.", "maxEndurance"], ["Serce", "heart", "heartTN", "Max nadzieja", "maxHope"], ["Rozum", "wits", "witsTN", "Obrona", "parry"]];
    form.innerHTML = `<div class="hero-editor-top"><div class="hero-editor-actions"></div></div>
      <div class="sheet-top">
        <section class="sheet-identity" aria-label="Tożsamość bohatera">
          <div class="sheet-name-row"><div class="sheet-seal" aria-hidden="true">✧</div>${textField("Imię", "name", "sheet-name")}${textField("Wiek", "age")}${numberField("Skarb", "treasure")}</div>
          <div class="sheet-background">${textField("Rodzima kultura", "culture")}${textField("Powołanie", "calling")}${textField("Rodzima korzyść", "culturalBlessing", "sheet-wide")}${textField("Wyróżniki", "distinctiveFeatures", "sheet-wide")}${textField("Przywary", "flaws", "sheet-wide")}${textField("Patron", "patron")}${textField("Ścieżka Cienia", "shadowPath")}</div>
        </section>
        <section class="sheet-vitals" aria-label="Zasoby i ograniczenia">
          <div class="sheet-resources"><div><h3>Wytrzymałość</h3><div class="sheet-current">${numberField("Wytrzymałość", "endurance")}</div><div class="sheet-pair">${numberField("Obciążenie", "load")}${numberField("Znużenie", "fatigue")}</div></div><div><h3>Nadzieja</h3><div class="sheet-current">${numberField("Nadzieja", "hope")}</div><div class="sheet-pair">${numberField("Cień", "shadow")}${numberField("Piętno Cienia", "shadowScars")}</div></div></div>
          <div class="sheet-conditions"><h3>Ograniczenia</h3><div class="sheet-pair"><div>${check("Wyczerpanie", "weary")}${check("Przygnębienie", "miserable")}${check("Rana", "wounded")}</div>${textField("Stopień rany", "injury")}</div></div>
        </section>
      </div>
      <div class="sheet-columns">${attributes.map(([label, key, tn, resource, max], i) => `<section class="sheet-column"><h3>${label}</h3><div class="sheet-attribute">${numberField("Wartość", key)}${numberField("PT", tn)}${numberField(resource, max)}</div><h4>Umiejętności</h4><div class="sheet-skills">${skillGroups[i].map(([key, label]) => rating(label, "skill" + key, true)).join("")}</div><section class="sheet-column-bottom">${i === 0 ? `<h3>Biegłości bojowe</h3>${[["Łuki", "Bows"], ["Miecze", "Swords"], ["Topory", "Axes"], ["Włócznie", "Spears"]].map(([label, key]) => rating(label, "combat" + key)).join("")}` : `<div class="sheet-section-heading"><h3>${i === 1 ? "Nagrody" : "Przymioty"}</h3>${numberField(i === 1 ? "Męstwo" : "Mądrość", i === 1 ? "valour" : "wisdom")}</div>${area(i === 1 ? "Zdobyte nagrody" : "Posiadane przymioty", i === 1 ? "rewards" : "virtues", 4)}`}</section></section>`).join("")}</div>
      <section class="sheet-gear"><h3>Rynsztunek</h3><div class="sheet-gear-grid"><div class="sheet-weapons">${Array.from({length: 4}, (_, i) => `<div class="sheet-weapon-row">${[["Broń", "Name"], ["Obrażenia", "Damage"], ["Przebicie", "Injury"], ["Obciążenie", "Load"], ["Uwagi", "Notes"]].map(([label, key]) => (["Damage", "Load"].includes(key) ? numberField(label, `weapon${i}${key}`) : textField(label, `weapon${i}${key}`))).join("")}</div>`).join("")}</div><div class="sheet-armour">${[["Zbroja", "armourName", "Pancerz (k)", "armour", "armourLoad"], ["Hełm", "helmName", "Pancerz (k)", "helmProtection", "helmLoad"], ["Tarcza", "shieldName", "Obrona", "shieldParry", "shieldLoad"]].map(([label, name, protection, key, load]) => `<div>${textField(label, name)}${numberField(protection, key)}${numberField("Obciążenie", load)}</div>`).join("")}</div></div></section>
      <div class="sheet-bottom"><section><h3>Ekwipunek</h3>${area("Przedmioty i wyposażenie", "equipment", 5)}</section><section class="sheet-progress">${textField("Poziom życia", "standardOfLiving")}<div class="sheet-points">${numberField("Punkty przygody", "adventurePoints")}${numberField("Punkty umiejętności", "skillPoints")}${numberField("Poziom zażyłości", "fellowship")}</div></section></div>
      <details class="sheet-extra sheet-disclosure"><summary>Notatki</summary><div>${area("Notatki bohatera", "notes")}</div></details>
      <div class="form-actions hero-editor-footer"><div class="hero-editor-footer-actions"></div><span class="hero-save-status" role="status" aria-live="polite">Zapisano</span></div>`;
    [
      ["character", ".sheet-top", "Postać"],
      ["attributes", ".sheet-columns", "Cechy i umiejętności"],
      ["gear", ".sheet-gear", "Rynsztunek"],
      ["equipment", ".sheet-bottom", "Ekwipunek"]
    ].forEach(([key, selector, label]) => {
      const content = form.querySelector(selector);
      const section = el("details", "sheet-disclosure");
      section.dataset.sheetSection = key;
      section.open = sectionOpen[key];
      const summary = el("summary", "", label);
      section.append(summary);
      if (key === "character") {
        section.classList.add("sheet-character");
        summary.replaceChildren(el("span", "sheet-character-title", label), form.querySelector(".hero-editor-actions"));
        form.querySelector(".hero-editor-top").remove();
      }
      // The disclosure title replaces the old heading for these two sections.
      if (key === "gear") content.querySelector(":scope > h3").remove();
      if (key === "equipment") content.querySelector(":scope > section > h3").remove();
      content.before(section);
      section.append(content);
    });
    fields.forEach(name => { const control = form.elements[name]; if (!control) return; if (booleans.has(name)) control.checked = !!value(name); else control.value = displayValue(control, value(name)); });
    form.elements.shadow.min = String(hero ? hero.shadowScars : 0);
    syncInjury(form, hero);
    updateResourceWarnings(form);
    form.elements.name.required = true;
    form.elements.name.maxLength = 80;
    if (hero && !embedded && !isPlayer()) { const actions = form.querySelector(".hero-editor-actions"), footer = form.querySelector(".hero-editor-footer-actions"), inBattle = store.getState().heroParticipants.some(p => p.heroId === hero.id); const battle = el("button", "text-button", inBattle ? "Usuń z potyczki" : "Dodaj do potyczki"); battle.type = "button"; battle.dataset.heroAction = "battle"; battle.dataset.id = hero.id;  actions.append(battle); const remove = el("button", "text-button danger", "Usuń bohatera"); remove.type = "button"; remove.dataset.heroAction = "delete"; remove.dataset.id = hero.id; footer.append(remove); }
    if (!embedded) { draftDirty = false; draftVersion = null; dirtyFields.clear(); conflictFields.clear(); }
  }
  function syncInjury(editor, hero, dirty) {
    const injury = editor.elements.injury;
    injury.disabled = !(dirty?.has("wounded") ? editor.elements.wounded.checked : hero?.wounded);
    if (injury.disabled) { injury.value = ""; if (dirty) dirty.delete("injury"); }
  }
  // Each cached sheet keeps its draft; disclosures reset when selection changes.
  // The same renderer serves both views; only saved fields go through the shared store.
  let embeddedSheetSequence = 0;
  window.OneRingHeroSheet = {
    getResourceWarnings,
    mount(container) {
      const sheets = new Map();
      store.subscribe(() => { for (const sheet of sheets.values()) sheet.sync(); });
      return {
        show(id) {
          for (const [key] of sheets) if (!heroById(key)) sheets.delete(key);
          const hero = id && heroById(id);
          container.hidden = !hero;
          if (!hero) { container.replaceChildren(); return; }
          let sheet = sheets.get(id);
          if (!sheet) {
            const editor = el("form", "paper form-card hero-editor");
            editor.id = "map-hero-editor-" + (++embeddedSheetSequence);
            editor.noValidate = true;
            editor.setAttribute("aria-label", "Arkusz wybranego bohatera");
            const dirty = new Set(), conflicts = new Set();
            let baseVersion = null, saving = false, timer = null;
            const status = text => { editor.querySelector(".hero-save-status").textContent = text; };
            const schedule = (delay = 500) => { clearTimeout(timer); timer = setTimeout(save, delay); };
            const save = async () => {
              if (saving || !dirty.size) return;
              if (!canSave()) { status("Brak połączenia. Zmiany czekają na zapis."); return; }
              const name = [...dirty].find(field => !conflicts.has(field));
              if (!name) { status(conflictStatus); return; }
              if (!validForm([name], editor)) { status("Popraw zaznaczone pole."); return; }
              const control = editor.elements[name];
              const value = booleans.has(name) ? control.checked : numeric.has(name) ? Number(control.value) : control.value.trim();
              const sent = booleans.has(name) ? control.checked : control.value;
              saving = true; let succeeded = false; status("Zapisywanie…");
              try {
                await store.saveHero({id, [name]:value}, baseVersion);
                succeeded = true;
                if ((booleans.has(name) ? control.checked : control.value) === sent) dirty.delete(name);
                baseVersion = dirty.size ? store.heroVersions?.[id] ?? null : null;
                sync(); status(conflicts.size ? conflictStatus : dirty.size ? "Niezapisane zmiany" : "Zapisano");
              } catch (error) {
                if (error?.status === 409) { for (const field of dirty) conflicts.add(field); status(conflictStatus); }
                else status("Zapis nie powiódł się. Zmiany czekają na połączenie.");
              } finally { saving = false; if (succeeded && dirty.size && canSave() && [...dirty].some(field => !conflicts.has(field))) schedule(500); }
            };
            const sync = () => {
              const current = heroById(id);
              if (!current) return;
              syncInjury(editor, current, dirty);
              editor.elements.shadow.min = String(current.shadowScars);
              fields.forEach(name => {
                const control = editor.elements[name];
                if (!control || dirty.has(name) || (name === "injury" && !current.wounded)) return;
                if (booleans.has(name)) control.checked = !!current[name];
                else {
                  const value = displayValue(control, current[name]);
                  if (control.value !== value) control.value = value;
                }
              });
              updateResourceWarnings(editor);
              if (dirty.size && !saving && canSave() && [...dirty].some(field => !conflicts.has(field))) schedule(200);
            };
            drawEditor(hero, editor, {character:false, attributes:false, gear:false, equipment:false}, true);
            const changed = event => {
              const name = event.target.name;
              if (!fields.includes(name) || event.isComposing) return;
              if (!dirty.size || conflicts.size) baseVersion = store.heroVersions?.[id] ?? null;
              conflicts.delete(name); dirty.add(name);
              syncInjury(editor, heroById(id), dirty); updateResourceWarnings(editor);
              status("Niezapisane zmiany"); schedule();
            };
            editor.addEventListener("input", changed);
            editor.addEventListener("change", event => {
              if (fields.includes(event.target.name) && !dirty.has(event.target.name)) changed(event);
              if (!conflicts.has(event.target.name)) schedule(0);
            });
            editor.addEventListener("compositionend", changed);
            editor.addEventListener("submit", event => { event.preventDefault(); if (editor.contains(document.activeElement)) document.activeElement.blur(); });
            sheet = {editor, sync};
            sheets.set(id, sheet);
          }
          sheet.sync();
          if (container.firstElementChild !== sheet.editor) {
            sheet.editor.querySelectorAll('details').forEach(section => { section.open = false; });
            container.replaceChildren(sheet.editor);
          }
        }
      };
    }
  };
  function status(text) { const target = form.querySelector(".hero-save-status"); if (target) target.textContent = text; }
  function edit(id) { const hero = heroById(id); if (!hero) return; editingId = id; drawEditor(hero); renderList(); }
  function restoreEditor() { const hero = heroById(editingId); if (hero) drawEditor(hero); }
  async function createHero() { if (isPlayer() || !mayDiscard()) return; try { if (!canSave()) throw new Error("Brak połączenia."); const saved = await store.saveHero({ name: "Bohater" }); editingId = saved.id; drawEditor(saved); renderList(); } catch (error) { const prior = host.querySelector(".hero-create-status"); if (prior) prior.remove(); host.querySelector(".hero-heading").append(el("span", "hero-create-status", saveError(error))); } }
  function mayDiscard() { return !draftDirty || confirm("Niezapisany szkic zostanie porzucony."); }
  function discardDraft() { restoreEditor(); }
  function validForm(names, target = form) {
    const form = target;
    for (const name of names) {
      const control = form.elements[name]; if (!control) continue;
      if (/^(weapon[0-3](Damage|Load)|treasure)$/.test(name) && !control.checkValidity()) { control.reportValidity(); return false; }
      if (numeric.has(name) && (!control.value.trim() || !Number.isFinite(Number(control.value)) || Number(control.value) < 0)) { control.setCustomValidity("Podaj liczbę równą zero lub większą."); control.reportValidity(); control.setCustomValidity(""); return false; }
      if (name === "name" && !control.value.trim()) { control.setCustomValidity("Podaj imię bohatera."); control.reportValidity(); control.setCustomValidity(""); return false; }
    }
    return true;
  }
  function syncEditor() {
    if (!editingId) return;
    const hero = heroById(editingId);
    if (!hero) { editingId = null; draftDirty = false; dirtyFields.clear(); return; }
    syncInjury(form, hero, dirtyFields);
    draftDirty = dirtyFields.size > 0;
    form.elements.shadow.min = String(hero.shadowScars);
    fields.forEach(name => { const control = form.elements[name]; if (!control || dirtyFields.has(name) || (name === "injury" && form.elements.injury.disabled)) return; if (booleans.has(name)) { control.checked = !!hero[name]; return; } const next = displayValue(control, hero[name]); if (control.value !== next) control.value = next; });
    updateResourceWarnings(form);
  }
  function renderList() {
    const state = store.getState(), ids = new Set(state.heroes.map(hero => hero.id));
    listCards.forEach((card, id) => { if (!ids.has(id)) { card.remove(); listCards.delete(id); } });
    list.hidden = isPlayer();
    if (isPlayer()) document.querySelector('[data-tab="heroes"]').textContent = state.heroes.find(hero => hero.id === store.access.heroId)?.name || "Bez imienia";
    host.querySelector(".hero-heading h2").textContent = isPlayer() ? "Mój bohater" : "Drużyna";
    form.setAttribute("role", isPlayer() ? "form" : "tabpanel");
    const emptyPanel = host.querySelector("#hero-empty-panel");
    host.querySelector('[data-hero-action="new"]').hidden = isPlayer();
    if (!state.heroes.length) { form.hidden = true; emptyPanel.hidden = false; emptyPanel.textContent = isPlayer() ? "Nie przypisano arkusza bohatera." : "Nie ma jeszcze bohaterów. Użyj „Nowy bohater”, aby utworzyć pierwszy arkusz."; return; }
    form.hidden = false; emptyPanel.hidden = true;
    if (!editingId) { editingId = state.heroes[0].id; drawEditor(state.heroes[0]); }
    if (isPlayer()) { list.replaceChildren(); listCards.clear(); return; }
    state.heroes.forEach(hero => {
      let card = listCards.get(hero.id);
      if (!card) { card = el("button", "hero-list-card"); card.type = "button"; card.role = "tab"; card.id = "hero-tab-" + hero.id; card.dataset.heroAction = "edit"; card.dataset.id = hero.id; card.setAttribute("aria-controls", "hero-editor"); listCards.set(hero.id, card); list.append(card); }
      const selected = hero.id === editingId; card.classList.toggle("is-editing", selected); card.textContent = hero.name || "Bez imienia"; card.setAttribute("aria-selected", String(selected)); card.tabIndex = selected ? 0 : -1;
    });
  }
  function renderBattle() {
    const participants = store.getParticipants().filter(p => p.type === "hero"); battleList.replaceChildren();
    participants.filter(hero => !isPlayer() || hero.heroId === store.access?.heroId).forEach(hero => {
      const card = el("article", "battle-card hero-battle-card" + (hero.defeated ? " defeated-card" : "")); card.dataset.id = hero.id;
      const top = el("div", "card-top"), title = el("div"); title.append(el("p", "enemy-tier", hero.culture || "BOHATER"), el("h3", "enemy-name", hero.name || "Bez imienia"), el("p", "enemy-kind", `${hero.stance === "Ostrożna" ? "Defensywna" : hero.stance || "Wyważona"}${hero.conditions ? " · " + hero.conditions : ""}`));
      const actions = el("div", "card-actions"); (isPlayer() ? [["Edytuj arkusz", "edit"]] : [["Edytuj arkusz", "edit"], ["×", "remove"]]).forEach(([label, action]) => { const b = el("button", action === "remove" ? "icon-button" : "text-button", label); b.type = "button"; b.dataset.heroAction = action; b.dataset.id = hero.id; b.title = action === "remove" ? "Usuń ze starcia" : "Edytuj arkusz"; actions.append(b); }); top.append(title, actions); card.append(top);
      const meters = el("div", "combat-stats"); [["WYTRZYMAŁOŚĆ", "endurance", hero.maxEndurance], ["NADZIEJA", "hope", hero.maxHope]].forEach(([label, field, max]) => { const meter = el("div", "meter"), controls = el("div", "adjusters"); meter.append(el("p", "", label), el("strong", "", `${hero[field]}/${max}`)); [-5, -1, 1, 5].forEach(delta => { const b = el("button", "", (delta > 0 ? "+" : "") + delta); b.type = "button"; b.dataset.heroResource = field; b.dataset.change = delta; b.dataset.id = hero.id; controls.append(b); }); meter.append(controls); meters.append(meter); }); card.append(meters);
      card.append(el("p", "detail", `Cień ${hero.shadow} · Obciążenie ${hero.load} · Znużenie ${hero.fatigue} · Obrona ${hero.parry} · Pancerz ${hero.armour}`));
      const weapons = Array.from({ length: 4 }, (_, i) => { const name = hero[`weapon${i}Name`]; if (!name) return ""; return name + [ ["obrażenia", "Damage"], ["przebicie", "Injury"] ].map(([label, key]) => hero[`weapon${i}${key}`] ? ` · ${label} ${hero[`weapon${i}${key}`]}` : "").join(""); }).filter(Boolean);
      if (weapons.length) card.append(el("p", "detail", `Rynsztunek: ${weapons.join("; ")}`));
      const ratings = [["Łuki", "combatBows"], ["Miecze", "combatSwords"], ["Topory", "combatAxes"], ["Włócznie", "combatSpears"]].filter(([, key]) => hero[key] > 0).map(([label, key]) => `${label} ${hero[key]}`);
      if (ratings.length) card.append(el("p", "detail", `Biegłości: ${ratings.join(" · ")}`));
      const conditions = [["Wyczerpanie", "weary"], ["Przygnębienie", "miserable"], ["Rana", "wounded"]].filter(([, key]) => hero[key]).map(([label]) => label);
      if (conditions.length) card.append(el("p", "detail", conditions.join(" · ")));
      if (hero.weapons) card.append(el("p", "detail", `Bronie: ${hero.weapons}`));
      if (hero.proficiencies) card.append(el("p", "detail", `Biegłości bojowe: ${hero.proficiencies}`));
      if (!isPlayer()) { const defeated = el("button", "defeated", hero.defeated ? "Przywróć do walki" : "Oznacz jako pokonanego"); defeated.type = "button"; defeated.dataset.heroAction = "defeated"; defeated.dataset.id = hero.id; card.append(defeated); } battleList.append(card);
    });
  }
  function render() { const layout = host.querySelector(".heroes-layout"), priorError = host.querySelector(".hero-error"); if (store.loadError) { layout.hidden = true; if (!priorError) host.querySelector(".hero-heading").append(el("p", "hero-error", "Nie można odczytać zapisanych danych bohaterów. Przywróć poprawną pełną kopię.")); return; } layout.hidden = false; if (priorError) priorError.remove(); syncEditor(); renderList(); syncHeader(); renderBattle(); if (draftDirty && canSave() && !savingField && [...dirtyFields].some(field => !conflictFields.has(field))) scheduleSave(200); }
  host.addEventListener("click", async event => { const button = event.target.closest("[data-hero-action]"); if (!button) return; const { heroAction: action, id } = button.dataset; if (action === "new") return createHero(); if (action === "edit") { if (isPlayer() && id !== store.access?.heroId) return; if (!mayDiscard()) return; edit(id); return; } if (isPlayer() || !canSave()) { status("Brak uprawnień lub połączenia."); return; } try { if (action === "battle") { const inBattle = store.getState().heroParticipants.some(p => p.heroId === id); if (inBattle) { if (confirm("Usunąć bohatera z potyczki? Arkusz bohatera zostanie zachowany.")) await store.removeParticipant("hero:" + id); } else await store.addHero(id); } else if (action === "delete" && confirm("Usunąć bohatera oraz jego udział w walce?")) { const heroes = store.getState().heroes, index = heroes.findIndex(hero => hero.id === id), next = heroes[index + 1] || heroes[index - 1]; await store.deleteHero(id); if (editingId === id) { editingId = next ? next.id : null; draftDirty = false; dirtyFields.clear(); if (editingId) edit(editingId); } } } catch (error) { status(saveError(error)); } });
  list.addEventListener("keydown", event => { const tabs = [...listCards.values()]; if (!tabs.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const current = tabs.indexOf(event.target.closest('[role="tab"]')); let index = current; if (event.key === "Home") index = 0; else if (event.key === "End") index = tabs.length - 1; else index = (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; const target = tabs[index]; if (target && mayDiscard()) { edit(target.dataset.id); target.focus(); } });
  battleList.addEventListener("click", async event => { const button = event.target.closest("button"); if (!button) return; const id = button.dataset.id; if (button.dataset.heroAction === "edit") { if (!mayDiscard()) return; document.querySelector('[data-tab="heroes"]').click(); edit(id.replace(/^hero:/, "")); return; } if (isPlayer() || !canSave()) return; try { if (button.dataset.heroResource) await store.adjustResource(id, button.dataset.heroResource, Number(button.dataset.change)); else if (button.dataset.heroAction === "remove") await store.removeParticipant(id); else if (button.dataset.heroAction === "defeated") await store.toggleDefeated(id); } catch (error) { status(saveError(error)); } });
  let savingField = false, saveTimer = null;
  function scheduleSave(delay = 500) { clearTimeout(saveTimer); saveTimer = setTimeout(saveField, delay); }
  function changedField(event) {
    const name = event.target.name;
    if (!fields.includes(name) || event.isComposing) return;
    if (!draftDirty || conflictFields.size) draftVersion = store.heroVersions?.[editingId] ?? null;
    conflictFields.delete(name); draftDirty = true; dirtyFields.add(name);
    syncInjury(form, heroById(editingId), dirtyFields); updateResourceWarnings(form);
    status("Niezapisane zmiany"); scheduleSave();
  }
  form.addEventListener("input", changedField);
  form.addEventListener("change", event => { if (!fields.includes(event.target.name)) return; if (!dirtyFields.has(event.target.name)) changedField(event); if (!conflictFields.has(event.target.name)) scheduleSave(0); });
  form.addEventListener("compositionend", changedField);
  async function saveField() {
    if (!editingId || savingField || !dirtyFields.size) return;
    if (!canSave()) { status("Brak połączenia. Zmiany czekają na zapis."); return; }
    const name = [...dirtyFields].find(field => !conflictFields.has(field));
    if (!name) { status(conflictStatus); return; }
    if (!validForm([name])) { status("Popraw zaznaczone pole."); return; }
    const id = editingId, control = form.elements[name];
    const value = booleans.has(name) ? control.checked : numeric.has(name) ? Number(control.value) : control.value.trim();
    const sent = booleans.has(name) ? control.checked : control.value;
    savingField = true; let succeeded = false; status("Zapisywanie…");
    try {
      await store.saveHero({ id, [name]: value }, draftVersion);
      succeeded = true;
      if (editingId !== id) return;
      if ((booleans.has(name) ? control.checked : control.value) === sent) dirtyFields.delete(name);
      draftDirty = dirtyFields.size > 0;
      draftVersion = draftDirty ? store.heroVersions?.[id] ?? null : null;
      syncEditor(); status(conflictFields.size ? conflictStatus : draftDirty ? "Niezapisane zmiany" : "Zapisano");
    } catch (error) {
      if (editingId !== id) return;
      if (error?.status === 409) { for (const field of dirtyFields) conflictFields.add(field); status(conflictStatus); }
      else status("Zapis nie powiódł się. Zmiany czekają na połączenie.");
    } finally {
      savingField = false;
      if (succeeded && dirtyFields.size && canSave() && [...dirtyFields].some(field => !conflictFields.has(field))) scheduleSave(500);
    }
  }
  form.addEventListener("submit", event => { event.preventDefault(); const active = document.activeElement; if (active && form.contains(active) && typeof active.blur === "function") active.blur(); });
  function syncHeader() { const hero = heroById(editingId), button = form.querySelector('[data-hero-action="battle"]'); if (!hero || !button) return; const inBattle = store.getState().heroParticipants.some(p => p.heroId === hero.id); button.textContent = inBattle ? "Usuń z potyczki" : "Dodaj do potyczki";  }
  document.querySelector(".tabs").addEventListener("click", event => {
    const tab = event.target.closest("[data-tab]");
    if (tab && tab.dataset.tab === "heroes") { syncEditor(); syncHeader(); }
  }, true);
  store.subscribe(render); render();
})();
