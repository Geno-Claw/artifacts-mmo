#!/usr/bin/env node
/**
 * Quick status check — character info + server status
 */
import { getMyCharacters, getServerStatus } from './api.mjs';

const server = await getServerStatus();
console.log(`🌐 Artifacts v${server.version} | ${server.characters_online} online | Season: ${server.season.name}`);
console.log();

const chars = await getMyCharacters();
for (const c of chars) {
  console.log(`⚔️  ${c.name} (Lv${c.level}, ${c.xp}/${c.max_xp} XP)`);
  console.log(`   ❤️  ${c.hp}/${c.max_hp} HP | 💰 ${c.gold}g | 📍 (${c.x},${c.y}) ${c.layer}`);
  console.log(`   🔨 Mining:${c.mining_level} Wood:${c.woodcutting_level} Fish:${c.fishing_level} Cook:${c.cooking_level}`);
  console.log(`   ⚒️  Weapon:${c.weaponcrafting_level} Gear:${c.gearcrafting_level} Jewel:${c.jewelrycrafting_level} Alch:${c.alchemy_level}`);
  if (c.task) console.log(`   📋 Task: ${c.task} (${c.task_progress}/${c.task_total})`);
  const equipped = [c.weapon_slot, c.shield_slot, c.helmet_slot, c.body_armor_slot, c.leg_armor_slot, c.boots_slot].filter(Boolean);
  if (equipped.length) console.log(`   🎽 Equipped: ${equipped.join(', ')}`);
  const items = c.inventory.filter(s => s.code).map(s => `${s.code}×${s.quantity}`);
  if (items.length) console.log(`   🎒 Inventory: ${items.join(', ')}`);
  console.log();
}
