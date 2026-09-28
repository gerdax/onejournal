/* Copy shared browser/server rules into the Edge Function deployment directory. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'supabase/functions/onejournal/_shared');
await mkdir(target, { recursive: true });
for (const name of ['state.js', 'dice-rules.js', 'server-core.js']) {
  await writeFile(resolve(target, name), await readFile(resolve(root, name)));
  console.log(`Copied ${name}`);
}
