'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), output = path.join(__dirname, 'artifacts');
fs.mkdirSync(output, { recursive: true });
const results = [];
for (const file of ['online.cjs', 'dice-online.cjs', 'map-desktop-online.cjs', 'map-touch-online.cjs', 'map-deselect-online.cjs', 'dice-tabs-online.cjs', 'dice-memory-online.cjs', 'map-disclosures-online.cjs', 'enemy-notes-online.cjs', 'map-library-online.cjs']) {
  const start = performance.now();
  const result = spawnSync(process.execPath, ['-r', './performance/local-only.cjs', 'tests/' + file], { cwd: root, encoding: 'utf8', timeout: 180000 });
  fs.writeFileSync(path.join(output, file + '.log'), (result.stdout || '') + (result.stderr || '') + (result.error ? '\n' + result.error.stack : ''));
  const record = { file, status: result.status, signal: result.signal, elapsedMs: performance.now() - start, error: result.error?.message };
  results.push(record); console.log(JSON.stringify(record));
}
fs.writeFileSync(path.join(output, 'regressions.json'), JSON.stringify(results, null, 2));
if (results.some(result => result.status !== 0)) process.exitCode = 1;
