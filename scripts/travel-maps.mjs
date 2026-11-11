/* Administrative atlas preparation/upload. Never included in the public build. */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'private-travel-maps');
const sources = { eriador: 'JP_MAPA-ERIADORU.pdf', podrozy: 'JP_MAPA-PODROZY.pdf' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const command = process.argv[2];
if (command === 'prepare') {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const manifest = { maps: {} };
  for (const [mapId, source] of Object.entries(sources)) {
    const prefix = resolve(output, mapId);
    execFileSync(process.env.PDFTOPPM || 'pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '4096', '-jpeg', '-jpegopt', 'quality=92', resolve(root, 'maps', source), prefix], { stdio: 'inherit' });
    const bytes = await readFile(prefix + '.jpg');
    if (bytes.length > 20 * 1024 * 1024) throw new Error('Obraz przekracza 20 MiB.');
    const version = hash(bytes), path = `${mapId}-${version}.jpg`;
    await rename(prefix + '.jpg', resolve(output, path));
    manifest.maps[mapId] = { version, path };
    console.log(`${mapId}: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB`);
  }
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log('Przygotowano prywatne obrazy. Sprawdź czytelność przed uploadem.');
} else if (command === 'upload') {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Ustaw SUPABASE_URL i SUPABASE_SERVICE_ROLE_KEY w zaufanym terminalu.');
  const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
  const images = [];
  for (const mapId of Object.keys(sources)) {
    const entry = manifest.maps?.[mapId];
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.version) || entry.path !== `${mapId}-${entry.version}.jpg`) throw new Error('Nieprawidłowy manifest.');
    const bytes = await readFile(resolve(output, entry.path));
    if (hash(bytes) !== entry.version || bytes.length > 20 * 1024 * 1024 || bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Obraz nie pasuje do manifestu.');
    images.push({ path: entry.path, bytes });
  }
  async function put(path, bytes, type) {
    const response = await fetch(`${url.replace(/\/$/, '')}/storage/v1/object/onejournal-travel-maps/${path}`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': type, 'x-upsert': 'true', 'Cache-Control': 'no-store' }, body: bytes
    });
    if (!response.ok) throw new Error(`Upload ${path}: HTTP ${response.status}`);
  }
  for (const entry of images) await put(entry.path, entry.bytes, 'image/jpeg');
  // Publish the manifest last: readers always see a complete pair of immutable images.
  await put('manifest.json', JSON.stringify(manifest), 'application/json');
  console.log('Opublikowano prywatne mapy i manifest wersji.');
} else {
  console.error('Użycie: node scripts/travel-maps.mjs prepare|upload');
  process.exitCode = 1;
}
