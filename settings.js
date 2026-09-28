(function () {
  'use strict';
  const store = window.OneRingStore;
  if (store.access.role !== 'gm') return;
  const host = document.getElementById('access-links'), status = document.getElementById('settings-status');
  let generation = 0;
  const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  async function render() {
    const token = ++generation;
    try {
      const response = await store.listLinks();
      if (token !== generation || store.access.role !== 'gm') return;
      const links = Array.isArray(response) ? response : response.links;
      host.replaceChildren();
      for (const hero of store.getState().heroes) {
        const grant = links.find(item => item.heroId === hero.id), row = el('article'); row.className = 'access-link';
        row.append(el('h3', hero.name));
        if (grant?.active && grant.secret) {
          const url = new URL(location.pathname, location.origin); url.hash = 'access=' + grant.secret;
          const input = el('input'); input.readOnly = true; input.value = url.href; input.setAttribute('aria-label', 'Link bohatera ' + hero.name);
          const copy = el('button', 'Kopiuj link'); copy.type = 'button'; copy.onclick = async () => { try { await navigator.clipboard.writeText(url.href); status.textContent = 'Skopiowano link.'; } catch (_) { input.select(); status.textContent = 'Zaznaczono link — skopiuj go ręcznie.'; } };
          row.append(input, copy);
          const revoke = el('button', 'Unieważnij'); revoke.type = 'button';
          revoke.onclick = () => act(() => store.revokeLink(hero.id), 'Unieważnić link i odebrać dostęp otwartym urządzeniom?');
          row.append(revoke);
        } else row.append(el('p', 'Brak aktywnego linku'));
        const rotate = el('button', grant?.active ? 'Wygeneruj nowy link' : 'Utwórz link'); rotate.type = 'button';
        rotate.onclick = () => act(() => store.rotateLink(hero.id), grant?.active ? 'Zastąpić link? Poprzedni link oraz jego sesje przestaną działać.' : null);
        row.append(rotate); host.append(row);
      }
      if (!store.getState().heroes.length) host.append(el('p', 'Najpierw utwórz bohatera w Drużynie.'));
    } catch (error) { status.textContent = error.message; }
  }
  async function act(fn, question) {
    if (question && !confirm(question)) return;
    host.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await fn(); status.textContent = 'Zapisano zmianę dostępu.'; await render(); }
    catch (error) { status.textContent = error.message; }
    finally { host.querySelectorAll('button').forEach(button => { button.disabled = !store.canWrite; }); }
  }
  document.addEventListener('one-ring:tab', event => { if (event.detail === 'settings') render(); });
  store.subscribe(() => { if (store.access.role !== 'gm') host.replaceChildren(); host.querySelectorAll('button').forEach(button => { button.disabled = !store.canWrite; }); });
})();
