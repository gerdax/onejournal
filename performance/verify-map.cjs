/* Validate saved audit samples without repeating the browser benchmark. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = path.join(__dirname, 'artifacts');
const report = JSON.parse(fs.readFileSync(path.join(dir, 'map-summary.json')));
let samples = 0;
for (const tokens of [10, 50]) for (const delay of [0, 150, 600]) {
  for (const file of [`map-${tokens}-${delay}-true.json`, `map-${tokens}-${delay}-false.json`, `fast-drop-${tokens}-${delay}.json`]) {
    const runs = JSON.parse(fs.readFileSync(path.join(dir, file)));
    assert.equal(runs.length, report.environment.repetitions);
    for (const run of runs) {
      const move = run.events.find(event => event.type === 'call' && event.method === 'moveToken');
      assert.ok(move?.done, file + ': movement must settle');
      assert.equal(move.error, undefined, file + ': movement must succeed');
      const snapshot = run.events.filter(event => event.type === 'snapshot').at(-1);
      assert.deepEqual(snapshot.positions[move.args[0]], { x: move.args[1], y: move.args[2] }, file + ': final position must match movement');
      assert.equal(run.backwardFrames, 0, file + ': no backward frames');
      assert.ok(run.frames.length > 0, file + ': sampled visible frames');
      assert.ok(run.frames.every(frame => frame.originalConnected), file + ': original token stays attached');
      samples++;
    }
  }
}
console.log(`Validated ${samples} successful movements without backward frames or detached tokens, and confirmed final positions.`);
