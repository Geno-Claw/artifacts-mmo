/**
 * World locations — monsters, resources, banks, etc.
 * Coordinates from Season 6. Use GET /maps?content_type=X&content_code=Y to verify.
 */

export const MONSTERS = {
  chicken:      { x: 0, y: 1, level: 1 },
  cow:          { x: 0, y: 2, level: 3 },
  blue_slime:   { x: 0, y: -2, level: 2 },
  yellow_slime: { x: 1, y: -2, level: 4 },
  pig:          { x: -3, y: -3, level: 5 },
  wolf:         { x: -3, y: 0, level: 5 },
  red_slime:    { x: 2, y: -2, level: 6 },
  mushmush:     { x: 5, y: 3, level: 7 },
  green_slime:  { x: 3, y: -2, level: 8 },
  goblin:       { x: 6, y: -2, level: 10 },
  sheep:        { x: 5, y: 12, level: 10 },
  spider:       { x: -3, y: 12, level: 12 },
};

export const RESOURCES = {
  // Mining
  copper_ore:  { x: 2, y: 0, skill: 'mining', level: 1 },
  iron_ore:    { x: 1, y: 7, skill: 'mining', level: 10 },
  // Woodcutting
  ash_tree:    { x: -1, y: 0, skill: 'woodcutting', level: 1 },
  spruce_tree: { x: 2, y: 6, skill: 'woodcutting', level: 10 },
  // Fishing
  gudgeon:     { x: 4, y: 2, skill: 'fishing', level: 1 },
  shrimp:      { x: 5, y: 2, skill: 'fishing', level: 10 },
};

export const BANK = { x: 4, y: 1 };

export const TASKS_MASTER = {
  monsters: { x: 1, y: 2 },
  items:    { x: 4, y: 13 },
};
