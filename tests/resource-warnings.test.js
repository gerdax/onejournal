const assert = require('node:assert/strict');
const { getResourceWarnings, updateResourceWarnings } = require('../heroes.js');

const base = {
  endurance: 12, load: 5, fatigue: 6, hope: 4, shadow: 3,
  weapon0Load: '2', weapon1Load: '1', armourLoad: 2,
  weary: false, miserable: false
};

assert.deepEqual(getResourceWarnings(base), {
  endurance: false, hope: false, load: false, weary: false, miserable: false, expectedLoad: 5
});
assert.deepEqual(getResourceWarnings({ ...base, endurance: 11, hope: 3 }), {
  endurance: true, hope: true, load: false, weary: false, miserable: false, expectedLoad: 5
});
assert.deepEqual(getResourceWarnings({ ...base, endurance: 11, hope: 3, weary: true, miserable: true }), {
  endurance: false, hope: false, load: false, weary: false, miserable: false, expectedLoad: 5
});
assert.deepEqual(getResourceWarnings({ ...base, weapon0Load: '1,5', weapon1Load: '', helmLoad: '0,5', treasure: 1 }), {
  endurance: false, hope: false, load: false, weary: false, miserable: false, expectedLoad: 5
});
assert.deepEqual(getResourceWarnings({ ...base, treasure: 1 }), {
  endurance: false, hope: false, load: true, weary: false, miserable: false, expectedLoad: 6
});
assert.equal(getResourceWarnings({ ...base, treasure: 'not a number' }).load, false,
  'invalid unsaved drafts should not trigger a misleading mismatch');

const elements = {};
for (const [field, value] of Object.entries(base)) {
  elements[field] = {
    value: String(value), checked: !!value, classes: new Set(),
    classList: { toggle(name, enabled) { if (enabled) elements[field].classes.add(name); else elements[field].classes.delete(name); } }
  };
}
for (const field of ['weapon2Load', 'weapon3Load', 'helmLoad', 'shieldLoad', 'treasure']) {
  elements[field] = {
    value: '', classes: new Set(),
    classList: { toggle(name, enabled) { if (enabled) elements[field].classes.add(name); else elements[field].classes.delete(name); } }
  };
}
const labelClasses = { weary: new Set(), miserable: new Set() };
for (const field of ['weary', 'miserable']) elements[field].closest = () => ({ querySelector: () => ({ classList: { toggle(name, on) { if (on) labelClasses[field].add(name); else labelClasses[field].delete(name); } } }) });
const editor = { elements };
const warned = field => elements[field].classes.has('is-resource-warning');
updateResourceWarnings(editor);
assert.equal(warned('endurance'), false);
assert.equal(warned('load'), false);
elements.endurance.value = '11';
elements.treasure.value = '1';
updateResourceWarnings(editor);
assert.equal(warned('endurance'), true);
assert.equal(warned('load'), true);
elements.load.value = '6';
updateResourceWarnings(editor);
assert.equal(warned('load'), false);
elements.weary.checked = true;
updateResourceWarnings(editor);
assert.equal(warned('endurance'), false);
elements.hope.value = '3';
updateResourceWarnings(editor);
assert.equal(warned('hope'), true);
elements.miserable.checked = true;
updateResourceWarnings(editor);
assert.equal(warned('hope'), false);

console.log('Hero resource warnings passed: thresholds, load sum, conditions and live toggles.');

elements.endurance.value = '20'; elements.hope.value = '10';
updateResourceWarnings(editor);
assert(labelClasses.weary.has('is-resource-warning'));
assert(labelClasses.miserable.has('is-resource-warning'));
elements.endurance.value = '12'; elements.hope.value = '3';
updateResourceWarnings(editor);
assert(!labelClasses.weary.has('is-resource-warning'));
assert(!labelClasses.miserable.has('is-resource-warning'));
