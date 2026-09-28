/* Explicit public artifact: never publish the repository root or server files. */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const files = ['index.html','config.js','state.js','cloud-store.js','supabase-adapter.js','bootstrap.js','heroes.js','map.js','app.js','dice-rules.js','dice-engine.js','dice-roller.js','journal.js','settings.js','style.css','overrides.css','heroes.css','map.css','dice-roller.css','online.css','manifest.webmanifest','service-worker.js','icons','vendor'];
for (const path of files) await cp(resolve(root,path), resolve(output,path), { recursive: true, filter: source => !source.endsWith('.DS_Store') });
await writeFile(resolve(output,'.nojekyll'), '');
console.log('Public application prepared in dist/');
