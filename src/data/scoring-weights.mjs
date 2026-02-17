/**
 * Equipment scoring weights — single source of truth.
 *
 * High-variance stats (initiative 50–700, prospecting, wisdom) are weighted
 * much lower than combat stats (2–80 range) to prevent them dominating scores.
 */
export const SCORING_WEIGHTS = {
  haste: 4,
  attack_fire: 3, attack_earth: 3, attack_water: 3, attack_air: 3,
  dmg: 2, dmg_fire: 2, dmg_earth: 2, dmg_water: 2, dmg_air: 2,
  res_fire: 1.5, res_earth: 1.5, res_water: 1.5, res_air: 1.5,
  hp: 0.5,
  initiative: 0.2,
  prospecting: 0.1,
  wisdom: 0.2,
};

export function getWeight(name) {
  if (SCORING_WEIGHTS[name] !== undefined) return SCORING_WEIGHTS[name];
  if (name.startsWith('attack_')) return 3;
  if (name.startsWith('dmg_')) return 2;
  if (name.startsWith('res_')) return 1.5;
  return 1;
}
