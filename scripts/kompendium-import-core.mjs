import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function assertTextLayer(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('PDF nie zawiera stron.');
  const frequencies = new Map();
  for (const page of pages) for (const line of new Set(page.text.split('\n').map(s => s.trim()).filter(s => s && s.length < 150))) frequencies.set(line, (frequencies.get(line) || 0) + 1);
  const repeated = new Set([...frequencies].filter(([, count]) => pages.length >= 5 && count >= pages.length * .8).map(([line]) => line));
  const sparse = pages.filter(page => page.text.split('\n').map(s => s.trim()).filter(s => !repeated.has(s)).join(' ').trim().length < 30);
  if (sparse.length > pages.length / 2) throw new Error('PDF nie ma użytecznej warstwy tekstowej (puste strony lub powtarzający się znak wodny). Wymagany OCR albo przeszukiwalny PDF.');
}

export function validatePages(pages, pageCount) {
  if (!Array.isArray(pages) || pages.length !== pageCount || !pageCount) throw new Error('Mapa musi zawierać każdą stronę PDF.');
  return pages.map((page, index) => {
    if (page.pdfPage !== index + 1 || typeof page.text !== 'string' || page.text.length > 100000) throw new Error('Nieprawidłowa strona lub tekst.');
    if (page.bookPage !== null && (typeof page.bookPage !== 'string' || page.bookPage.length > 32)) throw new Error('Numer drukowany musi być tekstem albo null.');
    if (typeof page.section !== 'string' || page.section.length > 200) throw new Error('Nieprawidłowa sekcja.');
    if (typeof page.exclude !== 'boolean') throw new Error('Każda strona wymaga pola exclude.');
    if (!page.exclude && page.text.trim().length < 30) throw new Error(`Strona ${page.pdfPage}: brak tekstu; popraw ekstrakcję lub jawnie wyklucz stronę.`);
    return page;
  });
}

export function chunkPages(pages, tokenizer, size = 550, overlap = 100) {
  const chunks = [];
  if (!Number.isInteger(size) || size < 400 || size > 700 || overlap < 0 || overlap >= size) throw new Error('Nieprawidłowy rozmiar fragmentu.');
  for (const page of pages) {
    if (page.exclude) continue;
    const tokens = tokenizer.encode(page.text);
    for (let start = 0; start < tokens.length; start += size - overlap) {
      // A token boundary may fall inside a multibyte Polish character. Expand
      // by a few tokens rather than introducing U+FFFD into the source passage.
      let from = start, end = Math.min(start + size, tokens.length);
      while (from > 0 && tokenizer.decode(tokens.slice(from, end)).startsWith('\ufffd')) from--;
      while (end < tokens.length && tokenizer.decode(tokens.slice(from, end)).endsWith('\ufffd')) end++;
      const content = tokenizer.decode(tokens.slice(from, end)).trim();
      if (content) chunks.push({ ordinal: chunks.length, content, pdfPage: page.pdfPage, bookPage: page.bookPage, section: page.section });
      if (start + size >= tokens.length) break;
    }
  }
  if (!chunks.length) throw new Error('Brak fragmentów do indeksowania.');
  return chunks;
}

export function validatePrepared(prepared, pdf) {
  if (prepared.format !== 'onejournal-kompendium-import' || prepared.version !== 1 || prepared.pdfSha256 !== sha256(pdf)) throw new Error('Plik PDF nie odpowiada przygotowanemu importowi.');
  if (typeof prepared.title !== 'string' || !prepared.title.trim() || prepared.title.length > 200) throw new Error('Nieprawidłowy tytuł.');
  const pages = validatePages(prepared.pages, prepared.pageCount);
  assertTextLayer(pages.filter(page => !page.exclude));
  return pages;
}

export function safeTarget(url, expectedRef) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== `${expectedRef}.supabase.co` || target.pathname !== '/' || target.search || target.hash || target.username || target.password) {
    throw new Error('Adres musi odpowiadać jawnie wskazanemu projektowi Supabase.');
  }
  return target.origin;
}
