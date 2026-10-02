import * as pdfjsLib from './vendor/pdfjs/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.mjs';
const title = document.getElementById('title'), status = document.getElementById('status');
const pageInput = document.getElementById('page'), count = document.getElementById('count');
const prev = document.getElementById('prev'), next = document.getElementById('next'), zoom = document.getElementById('zoom');
const canvas = document.getElementById('pdf-page'), container = document.querySelector('main');
const params = new URLSearchParams(location.hash.slice(1));
const channelId = params.get('channel'), directTicket = params.get('ticket');
history.replaceState(null, '', location.pathname + location.search);
let documentHandle, current = 1, rendering = null, renderSequence = 0;
let displayedPage = null, pendingResetPage = null;
function message(text) { status.textContent = text; }
function requestTicket() {
  if (directTicket) return Promise.resolve(directTicket);
  if (!channelId || !/^[0-9a-f-]{36}$/i.test(channelId) || !window.BroadcastChannel) return Promise.reject(new Error('Brak ważnego odnośnika do źródła.'));
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel('onejournal-reader-' + channelId);
    const timer = setTimeout(() => { channel.close(); reject(new Error('Nie odebrano odnośnika. Otwórz źródło ponownie z Kompendium.')); }, 15000);
    channel.onmessage = event => {
      if (event.data?.type !== 'ticket' && event.data?.type !== 'error') return;
      clearTimeout(timer); channel.close();
      if (event.data.type === 'error') reject(new Error(event.data.error || 'Nie udało się otworzyć źródła.'));
      else resolve(event.data.ticket);
    };
    channel.postMessage({ type: 'ready' });
  });
}
async function render(pageNumber, resetScroll = false) {
  if (!documentHandle) return;
  const sequence = ++renderSequence;
  current = Math.max(1, Math.min(documentHandle.numPages, pageNumber));
  const targetPage = current;
  if (resetScroll) pendingResetPage = targetPage === displayedPage ? null : targetPage;
  pageInput.value = current; prev.disabled = current <= 1; next.disabled = current >= documentHandle.numPages;
  const page = await documentHandle.getPage(current);
  if (sequence !== renderSequence) return;
  if (rendering) {
    rendering.cancel();
    try { await rendering.promise; } catch (_) { /* Cancellation is expected. */ }
    if (sequence !== renderSequence) return;
  }
  const base = page.getViewport({ scale: 1 });
  const factor = zoom.value === 'fit' ? Math.max(.25, (container.clientWidth - 32) / base.width) : Number(zoom.value);
  const ratio = Math.min(window.devicePixelRatio || 1, 2), viewport = page.getViewport({ scale: factor });
  canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`; canvas.style.height = `${Math.floor(viewport.height)}px`;
  const context = canvas.getContext('2d');
  const task = page.render({ canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
  rendering = task;
  try {
    await task.promise;
    if (sequence === renderSequence) {
      if (pendingResetPage === targetPage) { container.scrollTop = 0; pendingResetPage = null; }
      displayedPage = targetPage;
      message(`Strona ${targetPage} z ${documentHandle.numPages}`);
    }
  }
  catch (error) { if (error.name !== 'RenderingCancelledException') message('Nie udało się wyświetlić strony.'); }
  finally { if (rendering === task) rendering = null; }
}
prev.onclick = () => render(current - 1, true); next.onclick = () => render(current + 1, true);
pageInput.onchange = () => render(Number(pageInput.value) || current, true);
zoom.onchange = () => render(current);
let resizeTimer; window.addEventListener('resize', () => { if (zoom.value === 'fit') { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => render(current), 150); } });
try {
  const ticket = await requestTicket();
  if (!window.ONEJOURNAL_CONFIG?.supabaseUrl || !window.ONEJOURNAL_CONFIG?.supabaseAnonKey) throw new Error('Brak konfiguracji zaplecza.');
  const base = new URL(window.ONEJOURNAL_CONFIG.supabaseUrl).href.replace(/\/$/, '');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try { response = await fetch(base + '/functions/v1/kompendium', { method: 'POST', headers: { apikey: window.ONEJOURNAL_CONFIG.supabaseAnonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'redeem', ticket }), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal }); }
  finally { clearTimeout(timeout); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Nie udało się otworzyć źródła.');
  title.textContent = result.title || 'Źródło';
  documentHandle = await pdfjsLib.getDocument({ url: result.url, cMapUrl: './vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/pdfjs/standard_fonts/', wasmUrl: './vendor/pdfjs/wasm/', isEvalSupported: false }).promise;
  pageInput.disabled = false; pageInput.max = documentHandle.numPages; count.textContent = `/ ${documentHandle.numPages}`;
  await render(Number(result.pdfPage) || 1);
} catch (error) { message(error.message || 'Nie udało się otworzyć źródła.'); }
