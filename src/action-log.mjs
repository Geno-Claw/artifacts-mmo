function safeText(value) {
  const text = `${value ?? ''}`.trim();
  return text || '';
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeDrops(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const code = safeText(item?.code ?? item?.item);
      const qty = Math.max(0, toNumber(item?.qty ?? item?.quantity, 0));
      if (!code || qty <= 0) return null;
      return { code, qty };
    })
    .filter(Boolean);
}

function itemList(items) {
  if (!items?.length) return '';
  return items.map(item => `${item.code}x${item.qty}`).join(', ');
}

function normalizeActionType(action) {
  switch (safeText(action)) {
    case 'fight':
      return 'fight';
    case 'gathering':
      return 'gathering';
    case 'crafting':
      return 'crafting';
    case 'move':
      return 'movement';
    case 'use':
      return 'use';
    case 'rest':
      return 'rest';
    case 'bank/deposit/item':
      return 'deposit_item';
    case 'bank/deposit/gold':
      return 'deposit_gold';
    case 'bank/withdraw/item':
      return 'withdraw_item';
    case 'bank/withdraw/gold':
      return 'withdraw_gold';
    case 'equip':
      return 'equip';
    case 'unequip':
      return 'unequip';
    default:
      return safeText(action) || null;
  }
}

function pickCharacterFightResult(characters, characterName = '') {
  if (!Array.isArray(characters) || characters.length === 0) return {};
  const wanted = safeText(characterName).toLowerCase();
  if (!wanted) return characters[0] || {};
  return characters.find((row) => safeText(row?.character_name).toLowerCase() === wanted) || characters[0] || {};
}

function parseMonsterFromDescription(description) {
  const text = safeText(description).replace(/\s+/g, ' ');
  if (!text) return '';

  const patterns = [
    /\b(?:won|lost)\s+(?:vs\.?|against)\s+([A-Za-z0-9_-]+)/i,
    /\bagainst\s+([A-Za-z0-9_-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return safeText(match[1]);
  }

  return '';
}

function resolveMonsterLabel(fight, description = '') {
  return safeText(
    fight?.monster?.code
    || fight?.opponent
    || fight?.monster_code
    || fight?.monster?.name
    || fight?.monster_name
    || parseMonsterFromDescription(description),
  );
}

function summarizeFightResult(detail) {
  const won = safeText(detail?.result).toLowerCase() === 'win';
  const parts = [won ? `Won vs ${detail?.monster || '?'}` : `Lost vs ${detail?.monster || '?'}`];
  if (detail?.xp) parts.push(`+${detail.xp}xp`);
  if (detail?.gold) parts.push(`+${detail.gold}g`);
  const drops = itemList(detail?.drops);
  if (drops) parts.push(drops);
  return parts.join(' ');
}

function summarizeGatheringResult(detail) {
  const parts = [];
  if (detail?.skill) parts.push(detail.skill);
  if (detail?.resource) parts.push(detail.resource);
  if (detail?.xp) parts.push(`+${detail.xp}xp`);
  const drops = itemList(detail?.drops);
  if (drops) parts.push(drops);
  return parts.join(' ') || 'Gathered';
}

function summarizeCraftingResult(detail) {
  const parts = [`Crafted ${detail?.item || '?'}`];
  if ((detail?.quantity || 0) > 1) parts[0] += ` x${detail.quantity}`;
  if (detail?.xp) parts.push(`+${detail.xp}xp`);
  return parts.join(' ');
}

function summarizeMovementResult(detail) {
  if (detail?.x != null || detail?.y != null) {
    return `→ ${detail?.map || '?'} (${detail?.x ?? '?'},${detail?.y ?? '?'})`;
  }
  return `→ ${detail?.map || '?'}`;
}

function summarizeItemTransfer(prefix, items) {
  const summary = itemList(items);
  return `${prefix} ${summary || 'items'}`;
}

export function summarizeActionDetail(type, detail) {
  const normalizedType = normalizeActionType(type);
  if (!detail) return normalizedType ? `${normalizedType} completed` : 'Action completed';
  switch (normalizedType) {
    case 'fight':
      return summarizeFightResult(detail);
    case 'gathering':
      return summarizeGatheringResult(detail);
    case 'crafting':
      return summarizeCraftingResult(detail);
    case 'movement':
      return summarizeMovementResult(detail);
    case 'use':
      return `Used ${detail?.item || '?'}`;
    case 'rest':
      return `Rested +${detail?.hpRestored || 0}HP`;
    case 'deposit_item':
      return summarizeItemTransfer('Deposited', detail?.items);
    case 'deposit_gold':
      return `Deposited ${detail?.gold || 0}g`;
    case 'withdraw_item':
      return summarizeItemTransfer('Withdrew', detail?.items);
    case 'withdraw_gold':
      return `Withdrew ${detail?.gold || 0}g`;
    case 'equip':
      return `Equipped ${detail?.item || '?'} → ${detail?.slot || '?'}`;
    case 'unequip':
      return `Unequipped ${detail?.item || '?'} ← ${detail?.slot || '?'}`;
    default:
      return normalizedType ? `${normalizedType} completed` : 'Action completed';
  }
}

export function extractAccountLogDetail(type, content, { characterName = '', description = '' } = {}) {
  const normalizedType = normalizeActionType(type);
  if (!content || !normalizedType) return null;

  switch (normalizedType) {
    case 'fight': {
      const fight = content?.fight;
      if (!fight) return null;
      const row = pickCharacterFightResult(fight.characters, characterName);
      return {
        result: safeText(fight.result),
        monster: resolveMonsterLabel(fight, description) || null,
        xp: Math.max(0, toNumber(row?.xp, 0)),
        gold: Math.max(0, toNumber(row?.gold, 0)),
        drops: normalizeDrops(row?.drops),
        turns: Array.isArray(fight.turns) ? fight.turns : [],
      };
    }
    case 'gathering': {
      const gathering = content?.gathering;
      return {
        resource: safeText(gathering?.resource?.code ?? gathering?.resource_code) || null,
        skill: safeText(gathering?.skill) || null,
        xp: Math.max(0, toNumber(gathering?.xp, 0)),
        drops: normalizeDrops(content?.drops),
      };
    }
    case 'crafting':
      return {
        item: safeText(content?.item?.code) || null,
        quantity: Math.max(0, toNumber(content?.quantity, 0)),
        skill: safeText(content?.skill) || null,
        xp: Math.max(0, toNumber(content?.xp_gained, 0)),
      };
    case 'movement':
      return {
        map: safeText(content?.map?.name) || null,
        x: content?.map?.x ?? null,
        y: content?.map?.y ?? null,
        path: Array.isArray(content?.path) ? content.path : [],
      };
    case 'use':
      return {
        item: safeText(content?.item?.code) || null,
        quantity: Math.max(0, toNumber(content?.quantity, 0)),
      };
    case 'rest':
      return { hpRestored: Math.max(0, toNumber(content?.hp_restored, 0)) };
    case 'deposit_item':
    case 'withdraw_item':
      return { items: normalizeDrops(content?.items) };
    case 'deposit_gold':
    case 'withdraw_gold':
      return { gold: Math.max(0, toNumber(content?.gold, 0)) };
    case 'equip':
    case 'unequip':
      return {
        item: safeText(content?.item?.code) || null,
        slot: safeText(content?.slot) || null,
      };
    default:
      return null;
  }
}

export function extractActionResultDetail(action, result, { characterName = '', requestBody = null } = {}) {
  const normalizedType = normalizeActionType(action);
  if (!result || !normalizedType) return null;

  switch (normalizedType) {
    case 'fight': {
      const fight = result?.fight;
      if (!fight) return null;
      const row = pickCharacterFightResult(fight.characters, characterName);
      return {
        result: safeText(fight.result),
        monster: resolveMonsterLabel(fight) || null,
        xp: Math.max(0, toNumber(row?.xp, 0)),
        gold: Math.max(0, toNumber(row?.gold, 0)),
        drops: normalizeDrops(row?.drops),
        turns: [],
      };
    }
    case 'gathering':
      return {
        resource: safeText(result?.resource?.code ?? result?.details?.resource?.code) || null,
        skill: safeText(result?.skill ?? result?.details?.skill) || null,
        xp: Math.max(0, toNumber(result?.details?.xp ?? result?.xp, 0)),
        drops: normalizeDrops(result?.details?.items ?? result?.items ?? result?.drops),
      };
    case 'crafting': {
      const items = normalizeDrops(result?.details?.items ?? result?.items);
      const craftedQty = Math.max(
        0,
        toNumber(requestBody?.quantity, 0),
      ) || items.reduce((sum, item) => sum + item.qty, 0);
      return {
        item: safeText(requestBody?.code ?? result?.item?.code ?? items[0]?.code) || null,
        quantity: craftedQty,
        skill: safeText(result?.details?.skill ?? result?.skill) || null,
        xp: Math.max(0, toNumber(result?.details?.xp ?? result?.xp_gained, 0)),
      };
    }
    case 'movement':
      return {
        map: safeText(result?.destination?.name) || null,
        x: result?.destination?.x ?? result?.character?.x ?? null,
        y: result?.destination?.y ?? result?.character?.y ?? null,
        path: Array.isArray(result?.path) ? result.path : [],
      };
    case 'use':
      return {
        item: safeText(result?.item?.code ?? requestBody?.code) || null,
        quantity: Math.max(0, toNumber(requestBody?.quantity ?? result?.quantity, 0)),
      };
    case 'rest':
      return {
        hpRestored: Math.max(0, toNumber(result?.hp_restored, 0)),
      };
    case 'deposit_item':
    case 'withdraw_item':
      return {
        items: normalizeDrops(result?.items ?? [requestBody]),
      };
    case 'deposit_gold':
    case 'withdraw_gold':
      return {
        gold: Math.max(0, toNumber(requestBody?.quantity ?? result?.gold ?? result?.bank?.gold, 0)),
      };
    case 'equip':
    case 'unequip':
      return {
        item: safeText(result?.item?.code ?? requestBody?.code) || null,
        slot: safeText(result?.slot ?? requestBody?.slot) || null,
      };
    default:
      return null;
  }
}

export function describeActionResult(action, result, options = {}) {
  const type = normalizeActionType(action);
  if (!type) return null;
  const detail = extractActionResultDetail(action, result, options);
  return {
    type,
    detail,
    summary: summarizeActionDetail(type, detail),
  };
}
