const kinds={Ork:{names:["Snaga Żelazny Ząb","Gorbag z Czerwonej Doliny","Uglúk Czarnoręki"],category:"Orkowie"},Goblin:{names:["Skrzek z Tuneli","Mały Krzywus","Grishka"],category:"Orkowie"},Bestia:{names:["Szary Warg","Dzik z Czarnej Puszczy"],category:"Wilki i bestie"},Upiór:{names:["Cień Kurhanu","Zimny Szept"],category:"Upiory"},Człowiek:{names:["Bereg Łamacz Tarcz","Hild Córka Wrzosów"],category:"Źli ludzie"}};
kinds.Troll={names:["Troll z Gór Mglistych"],category:"Trolle"};
kinds.Wilk={names:["Szary Warg","Wilk z Czarnej Puszczy"],category:"Wilki i bestie"};
const tiers={"Słaby":[2,8,1,2,0,1],"Standardowy":[4,16,1,4,1,2],"Elitarny":[6,24,2,6,2,3],"Przywódca":[8,48,2,8,3,4]};
const store=window.OneRingStore;
const bookCatalog=store.access?.role === "gm" ? (store.catalog || []) : [];
let library=store.getState().library,activeCategory="Orkowie";
const $=s=>document.querySelector(s),resourceName=e=>(e.resourceType||(e.kind==="Człowiek"?"determination":"hate"))==="determination"?"Determinacja":"Nienawiść",uid=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random();
let editorResourceType = "hate";
function setResourceHelp(){let name=resourceName({resourceType:editorResourceType}),help=$("#resource-help");$("#resource-name").textContent=name;help.setAttribute("aria-label","Wyjaśnienie "+name);help.dataset.tooltip=editorResourceType==="determination"?"Mierzy wolę walki i zasób do używania specjalnych zdolności. Można wydać 1 punkt, aby dodać 1k do testu; bez punktów przeciwnik ulega Wyczerpaniu. Ludzie z Determinacją mogą się poddać.":"Mierzy wolę walki i zasób do używania specjalnych zdolności. Można wydać 1 punkt, aby dodać 1k do testu; bez punktów przeciwnik ulega Wyczerpaniu. Sługi Cienia z Nienawiścią nie poddają się."}
function preset(random=true){let k=kinds[$("#kind").value],v=tiers[$("#tier").value];$("#name").value=random&&k?k.names[Math.floor(Math.random()*k.names.length)]:$("#name").value;["fierceness","endurance","might","hate","parry","armour"].forEach((x,i)=>$("#"+x).value=v[[0,1,2,3,4,5][i]]);$("#attack").value="";$("#traits").value="";if(random){$("#enemy-features").value="";$("#enemy-notes").value="";}setResourceHelp()}
function formEnemy(){let k=$("#kind").value.trim();return {id:uid(),name:$("#name").value.trim(),kind:k,resourceType:editorResourceType,category:"Własne",distinctiveFeatures:$("#enemy-features").value.trim(),tier:$("#tier").value,fierceness:+$("#fierceness").value,endurance:+$("#endurance").value,maxEndurance:+$("#endurance").value,might:+$("#might").value,hate:+$("#hate").value,maxHate:+$("#hate").value,parry:+$("#parry").value,armour:+$("#armour").value,attack:$("#attack").value.trim(),traits:$("#traits").value.trim(),notes:$("#enemy-notes").value,source:"Własne",defeated:false}}
const isGM=()=>store.access?.role==="gm",canSave=()=>store.connection==="online"&&store.canWrite;
function showError(error){let warning=document.querySelector(".storage-warning");if(!warning){warning=document.createElement("p");warning.className="storage-warning";warning.setAttribute("role","alert");$(".tabs").before(warning)}warning.textContent=error?.message||"Nie udało się zapisać zmiany."}
async function write(action){if(!isGM()||!canSave()){showError(new Error("Brak połączenia lub uprawnień do zapisu."));return null}try{const result=await action();document.querySelector(".storage-warning")?.remove();return result}catch(error){showError(error);return null}}
async function addToBattle(e){const added=await write(()=>store.addEnemy(e));if(added)window.OneRingMap.selectParticipant(added.id);return added}
function renderMapCount() { $("#map-count").textContent = store.getParticipants().length; }
const escapeHTML=value=>String(value??"—").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let libraryScroll = 0, highlightedEnemyId = null;
function renderLibrary() {
  const q = $("#library-search").value.toLowerCase();
  const items = [...bookCatalog, ...library].filter(e =>
    (activeCategory === null || (activeCategory === "Własne" ? e.source === "Własne" : e.source !== "Własne" && e.category === activeCategory)) &&
    (e.name + " " + e.category + " " + e.kind + " " + (e.distinctiveFeatures || "")).toLowerCase().includes(q));
  $("#category-filters").querySelectorAll("button").forEach(b => {
    const active = b.dataset.category === activeCategory;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  const list = $("#library-list");
  list.innerHTML = "";
  items.forEach(raw => {
    const e = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, escapeHTML(value)]));
    const del = e.source === "Własne" ? '<button class="delete">Usuń</button>' : "";
    list.insertAdjacentHTML("beforeend", `<article class="library-card" data-id="${e.id}" data-source="${e.source}">
      <p class="enemy-tier">${e.kind} · ${e.source}</p>
      <h3><button type="button" class="library-template" title="Otwórz szablon">${e.name}</button></h3>
      <p class="enemy-features">${e.distinctiveFeatures || ''}</p>
      <div class="library-stats">
        <div class="library-primary-stats">
          <div><span>Zajadłość</span><strong>${e.fierceness}</strong></div>
          <div><span>Wytrzymałość</span><strong>${e.maxEndurance}</strong></div>
        </div>
        <div class="library-secondary-stats">
          <div><span>${resourceName(e)}</span><strong>${e.maxHate}</strong></div>
          <div><span>Potęga</span><strong>${e.might}</strong></div>
          <div><span>Obrona</span><strong>${e.parry}</strong></div>
          <div><span>Pancerz</span><strong>${e.armour}</strong></div>
        </div>
      </div>
      <div class="library-actions">${del}<button class="add">Dodaj do potyczki</button></div>
    </article>`);
  });
  list.querySelectorAll(".library-card").forEach(card => card.classList.toggle("is-saved", card.dataset.id === highlightedEnemyId));
  $("#library-empty").hidden = !!items.length;
}
function showEnemyEditor() {
  libraryScroll = window.scrollY;
  $("#library").hidden = true;
  $("#generator").hidden = false;
  window.scrollTo(0, 0);
  $("#name").focus({preventScroll:true});
}
function showEnemyLibrary(savedId = null) {
  $("#generator").hidden = true;
  $("#library").hidden = false;
  if (savedId) {
    highlightedEnemyId = savedId;
    activeCategory = "Własne";
    $("#library-search").value = "";
    renderLibrary();
    const card = Array.from($("#library-list").children).find(node => node.dataset.id === savedId);
    if (card) { card.querySelector(".library-template").focus({preventScroll:true}); card.scrollIntoView({block:"center"}); }
  } else window.scrollTo(0, libraryScroll);
}
$("#create-enemy").onclick = showEnemyEditor;
function loadEditor(e){editorResourceType=e.resourceType||(e.kind==="Człowiek"?"determination":"hate");$("#name").value=e.name;$("#kind").value=e.kind;$("#kind").setCustomValidity("");$("#tier").value=e.tier||"Standardowy";["fierceness","endurance","might","hate","parry","armour"].forEach(x=>$("#"+x).value=x==="endurance"?e.maxEndurance:x==="hate"?e.maxHate:e[x]);$("#attack").value=e.attack;$("#traits").value=e.traits;$("#enemy-features").value=e.distinctiveFeatures||"";$("#enemy-notes").value=e.notes||"";setResourceHelp();showEnemyEditor()}
const kindInput = $("#kind"), kindOptions = $("#enemy-kind-options"), kindToggle = $("#kind-toggle");
const defaultKinds = [...new Set(bookCatalog.map(enemy => enemy.kind))];
let activeKindIndex = -1;
function closeKindOptions() {
  kindOptions.hidden = true;
  kindInput.setAttribute("aria-expanded", "false");
  kindToggle.setAttribute("aria-expanded", "false");
  kindInput.removeAttribute("aria-activedescendant");
}
function highlightKind(index) {
  activeKindIndex = (index + defaultKinds.length) % defaultKinds.length;
  Array.from(kindOptions.children).forEach((option, i) => option.setAttribute("aria-selected", String(i === activeKindIndex)));
  const active = kindOptions.children[activeKindIndex];
  kindInput.setAttribute("aria-activedescendant", active.id);
  active.scrollIntoView({block:"nearest"});
}
function openKindOptions() {
  kindOptions.hidden = false;
  kindInput.setAttribute("aria-expanded", "true");
  kindToggle.setAttribute("aria-expanded", "true");
  highlightKind(Math.max(0, defaultKinds.indexOf(kindInput.value)));
}
function chooseKind(index) {
  kindInput.value = defaultKinds[index];
  editorResourceType = kindInput.value === "Człowiek" ? "determination" : "hate";
  kindInput.dispatchEvent(new Event("input", {bubbles:true}));
  closeKindOptions();
  kindInput.focus({preventScroll:true});
}
defaultKinds.forEach((kind, index) => {
  const option = document.createElement("div");
  option.id = "enemy-kind-option-" + index;
  option.setAttribute("role", "option");
  option.textContent = kind;
  option.addEventListener("pointerdown", event => event.preventDefault());
  option.addEventListener("click", () => chooseKind(index));
  kindOptions.append(option);
});
kindToggle.addEventListener("click", () => {
  const opening = kindOptions.hidden;
  kindInput.focus({preventScroll:true});
  if (opening) openKindOptions(); else closeKindOptions();
});
kindInput.addEventListener("input", closeKindOptions);
kindInput.addEventListener("keydown", event => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (kindOptions.hidden) openKindOptions();
    else highlightKind(activeKindIndex + (event.key === "ArrowDown" ? 1 : -1));
  } else if (event.key === "Enter" && !kindOptions.hidden) {
    event.preventDefault(); chooseKind(activeKindIndex);
  } else if (event.key === "Escape" && !kindOptions.hidden) {
    event.preventDefault(); closeKindOptions();
  } else if (event.key === "Tab") closeKindOptions();
});
document.addEventListener("pointerdown", event => { if (!event.target.closest(".kind-combobox")) closeKindOptions(); });
document.addEventListener("focusin", event => { if (!event.target.closest(".kind-combobox")) closeKindOptions(); });
Object.keys(tiers).forEach(x=>$("#tier").insertAdjacentHTML("beforeend","<option>"+x+"</option>"));[...new Set(bookCatalog.map(x=>x.category)),"Własne"].forEach(x=>$("#category-filters").insertAdjacentHTML("beforeend",'<button data-category="'+x+'">'+(x==="Wilki i bestie"?"Wilki":x)+"</button>"));preset();renderMapCount();renderLibrary();if(!isGM()){["opponents","generator"].forEach(id=>{$("#"+id).hidden=true});$("#export-backup").hidden=true;$("#restore-backup").hidden=true}
$("#tier").onchange=()=>preset(false);$("#kind").oninput=()=>{const kind=$("#kind").value.trim();$("#kind").setCustomValidity(kind?"":"Podaj rodzaj przeciwnika.");setResourceHelp()};$("#randomize").onclick=()=>{let a=[...new Set(bookCatalog.map(e=>e.kind))],b=Object.keys(tiers);$("#kind").value=a[Math.floor(Math.random()*a.length)];editorResourceType=$("#kind").value==="Człowiek"?"determination":"hate";$("#kind").setCustomValidity("");$("#tier").value=b[Math.floor(Math.random()*b.length)];preset()};$("#reset-form").onclick=()=>{showEnemyLibrary();$("#create-enemy").focus({preventScroll:true})};
$("#enemy-form").onsubmit=async e=>{e.preventDefault();if(!isGM())return;let x=formEnemy(),action=e.submitter?.dataset.action||"library";const saved=await write(()=>store.addLibrary(x));if(!saved)return;if(action==="battle"){if(await addToBattle(x))document.querySelector('[data-tab="map"]').click()}else showEnemyLibrary(saved.id)};$(".tabs").onclick=e=>{const tab=e.target.closest(".tab");if(!tab||!tab.dataset.tab||tab.hidden||tab.disabled||!isGM()&&["opponents","generator"].includes(tab.dataset.tab))return;if($("#opponents").classList.contains("active")&&!$("#library").hidden)libraryScroll=window.scrollY;document.querySelectorAll(".tab,.page").forEach(x=>x.classList.remove("active"));tab.classList.add("active");$("#"+tab.dataset.tab).hidden=false;$("#"+tab.dataset.tab).classList.add("active");if(location.hash==="#battle")history.replaceState(null,"",location.pathname+location.search);if(tab.dataset.tab==="opponents")showEnemyLibrary();document.dispatchEvent(new CustomEvent("one-ring:tab",{detail:tab.dataset.tab}))};
$("#category-filters").onclick=e=>{if(e.target.matches("button")){activeCategory=activeCategory===e.target.dataset.category?null:e.target.dataset.category;renderLibrary()}};$("#library-search").oninput=renderLibrary;$("#library-list").onclick=async e=>{if(!isGM())return;let c=e.target.closest(".library-card");if(!c)return;let x=[...bookCatalog,...library].find(v=>v.id===c.dataset.id&&v.source===c.dataset.source);if(!x)return;if(e.target.closest(".add")){if(await addToBattle(x))document.querySelector('[data-tab="map"]').click()}else if(e.target.closest(".delete")){if(confirm(`Czy na pewno usunąć przeciwnika „${x.name}” z biblioteki?`))await write(()=>store.removeLibrary(x.id))}else loadEditor(x)};
function downloadJSON(data,name){const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),a=document.createElement("a"),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
$("#export-backup").onclick=async()=>{if(!isGM())return;try{const data=await store.exportBackup();downloadJSON(data,"srodziemie-pelna-kopia.json")}catch(error){showError(error)}};
$("#restore-backup").onclick=()=>{if(isGM())$("#backup-file").click()};
$("#backup-file").onchange=async e=>{const file=e.target.files[0];if(!file||!isGM())return;try{const data=JSON.parse(await file.text());if(confirm("Zastąpić wszystkie dane pełną kopią? Obecna biblioteka, bohaterowie, walka i mapa zostaną zastąpione.")){await store.restoreBackup(data);document.querySelector(".storage-warning")?.remove();alert("Przywrócono pełną kopię danych.")}}catch(error){showError(error)}finally{e.target.value=""}};
store.subscribe(()=>{library=store.getState().library;renderMapCount();renderLibrary()});
if(store.loadError){const warning=document.createElement("p");warning.className="storage-warning";warning.setAttribute("role","alert");warning.textContent="Nie udało się wczytać zapisu. Oryginalne dane zostały zachowane. "+store.loadError;$(".tabs").before(warning)}
document.addEventListener("pointerdown",e=>{let button=e.target.closest(".help-tooltip"),all=document.querySelectorAll(".help-tooltip");if(e.pointerType==="touch"&&button){let opening=!button.classList.contains("is-open");all.forEach(x=>{x.classList.remove("is-open");x.setAttribute("aria-expanded","false")});if(opening){button.classList.add("is-open");button.setAttribute("aria-expanded","true")}}else if(!button)all.forEach(x=>{x.classList.remove("is-open");x.setAttribute("aria-expanded","false")})});
document.querySelectorAll(".help-tooltip").forEach(button=>{button.addEventListener("pointerenter",e=>{if(e.pointerType==="mouse")button.classList.add("is-hovered")});button.addEventListener("pointerleave",()=>button.classList.remove("is-hovered"))});
if("serviceWorker" in navigator&&location.protocol!=="file:")addEventListener("load",()=>navigator.serviceWorker.register("service-worker.js").catch(()=>{}));

// Old battle links now open the active potyczka map through normal navigation.
function openLegacyBattle() {
  if (location.hash === "#battle") document.querySelector('[data-tab="map"]').click();
}
window.addEventListener("hashchange", openLegacyBattle);
openLegacyBattle();
