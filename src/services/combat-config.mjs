const DEFAULT_COMBAT_WIN_RATE_THRESHOLD = 90;

let winRateThreshold = DEFAULT_COMBAT_WIN_RATE_THRESHOLD;

function normalizeThreshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_COMBAT_WIN_RATE_THRESHOLD;
  return Math.min(100, Math.max(0, Math.floor(n)));
}

export function loadCombatConfig(config) {
  winRateThreshold = normalizeThreshold(config?.combat?.winRateThreshold);
}

export function getCombatWinRateThreshold() {
  return winRateThreshold;
}

export function _resetForTests() {
  winRateThreshold = DEFAULT_COMBAT_WIN_RATE_THRESHOLD;
}

export { DEFAULT_COMBAT_WIN_RATE_THRESHOLD };
