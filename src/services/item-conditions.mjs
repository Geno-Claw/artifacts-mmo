/**
 * Helpers for evaluating API item condition rules against character stats.
 */

const OPS = {
  gt: (left, right) => left > right,
  gte: (left, right) => left >= right,
  ge: (left, right) => left >= right,
  lt: (left, right) => left < right,
  lte: (left, right) => left <= right,
  le: (left, right) => left <= right,
  eq: (left, right) => left === right,
  ne: (left, right) => left !== right,
};

function getCharacterValue(character, code) {
  if (!character || !code) return null;

  if (Object.prototype.hasOwnProperty.call(character, code)) {
    return character[code];
  }

  const levelKey = `${code}_level`;
  if (Object.prototype.hasOwnProperty.call(character, levelKey)) {
    return character[levelKey];
  }

  return null;
}

export function meetsCondition(character, condition) {
  if (!condition?.code) return true;

  const left = getCharacterValue(character, condition.code);
  if (left === null || left === undefined) return false;

  const operator = OPS[`${condition.operator || 'eq'}`.toLowerCase()];
  if (!operator) return false;

  return operator(left, condition.value);
}

export function meetsConditions(character, conditions = []) {
  const list = Array.isArray(conditions) ? conditions : [];
  for (const condition of list) {
    if (!meetsCondition(character, condition)) return false;
  }
  return true;
}

export function canUseItem(item, character) {
  return meetsConditions(character, item?.conditions || []);
}
