(function (root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  if (root) root.DiceRules = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clamp = (number, min, max) => Math.min(max, Math.max(min, number));

  function calculatePool(config) {
    const base = clamp(Number(config.baseDice) || 0, 0, 6);
    const bonus = clamp(Number(config.bonus) || 0, -6, 6);
    const resource = config.actor === 'enemy' ? (config.enemyResource ? 1 : 0) :
      (config.hope ? (config.inspired ? 2 : 1) : 0);
    return clamp(base + bonus + resource, 0, 14);
  }

  function featValue(actor, face) {
    if (face === 11) return 0; // Oko Saurona
    if (face === 12) return 0; // Runa Gandalfa
    return face;
  }

  function featLabel(face) {
    return face === 11 ? 'Oko Saurona' : face === 12 ? 'Runa Gandalfa' : String(face);
  }

  function interpretRoll(config, raw) {
    const actor = config.actor === 'enemy' ? 'enemy' : 'hero';
    const mode = ['weary', 'normal', 'favoured'].includes(config.featMode) ? config.featMode : 'normal';
    const expectedFeat = mode === 'normal' ? 1 : 2;
    const expectedSuccess = calculatePool(config);
    if (!raw || !Array.isArray(raw.feat) || raw.feat.length !== expectedFeat ||
        !Array.isArray(raw.success) || raw.success.length !== expectedSuccess ||
        raw.feat.some(face => !Number.isInteger(face) || face < 1 || face > 12) ||
        raw.success.some(face => !Number.isInteger(face) || face < 1 || face > 6)) {
      throw new TypeError('Nieprawidłowe wyniki rzutu kośćmi.');
    }

    const featValues = raw.feat.map(face => featValue(actor, face));
    const featRanks = raw.feat.map(face =>
      face === (actor === 'enemy' ? 11 : 12) ? 11 : featValue(actor, face));
    const selectedFeatIndex = mode === 'normal' ? 0 :
      (mode === 'favoured' ? (featRanks[1] > featRanks[0] ? 1 : 0) :
        (featRanks[1] < featRanks[0] ? 1 : 0));
    const selectedFeat = raw.feat[selectedFeatIndex];
    const automaticSuccess = actor === 'enemy' ? selectedFeat === 11 : selectedFeat === 12;
    const automaticFailure = actor === 'hero' && !!config.miserable && selectedFeat === 11;
    const successDice = raw.success.map(face => ({
      raw: face,
      value: config.exhausted && face <= 3 ? 0 : face,
      successMarks: face === 6 ? 1 : 0
    }));
    const sum = featValues[selectedFeatIndex] + successDice.reduce((total, die) => total + die.value, 0);
    const marks = successDice.reduce((total, die) => total + die.successMarks, 0);
    const target = config.target === '' || config.target === null || config.target === undefined ? null : Number(config.target);
    if (target !== null && (!Number.isInteger(target) || target < 0)) throw new TypeError('PT musi być liczbą całkowitą od zera.');
    const passed = automaticSuccess ? true : target === null ? null : automaticFailure ? false : sum >= target;

    return {
      actor, mode, feat: raw.feat.slice(), featValues, selectedFeatIndex,
      selectedFeat, selectedFeatLabel: featLabel(selectedFeat), successDice,
      sum, marks, target, passed, automaticSuccess, automaticFailure,
      pool: expectedSuccess
    };
  }

  return { calculatePool, featValue, featLabel, interpretRoll };
});
