import * as api from '../api.mjs';
import { moveTo } from '../helpers.mjs';
import { withdrawBankItems, withdrawGoldFromBank } from './bank-ops.mjs';
import { getBankSummary } from './inventory-manager.mjs';

export function carriedCurrencyCount(ctx, currency) {
  if (currency === 'gold') {
    return Math.max(0, Number(ctx.get()?.gold) || 0);
  }
  return Math.max(0, Number(ctx.itemCount(currency)) || 0);
}

export function bankCurrencyCount(currency, bankItems = null) {
  if (currency === 'gold') {
    return Math.max(0, Number(getBankSummary().gold) || 0);
  }
  if (bankItems instanceof Map) {
    return Math.max(0, Number(bankItems.get(currency)) || 0);
  }
  return 0;
}

export async function topUpNpcCurrency(ctx, currency, quantity, { reason = 'npc currency top-up' } = {}) {
  const needed = Math.max(0, Number(quantity) || 0);
  if (needed <= 0) return { attempted: false, withdrawn: 0 };

  const carried = carriedCurrencyCount(ctx, currency);
  if (carried >= needed) return { attempted: false, withdrawn: 0 };

  const missing = needed - carried;
  if (currency === 'gold') {
    try {
      await withdrawGoldFromBank(ctx, missing, { reason });
      return { attempted: true, withdrawn: missing };
    } catch (err) {
      return { attempted: true, withdrawn: 0, error: err };
    }
  }

  try {
    const result = await withdrawBankItems(ctx, [{ code: currency, quantity: missing }], {
      reason,
      mode: 'partial',
      retryStaleOnce: true,
    });
    const withdrawn = result.withdrawn.find(row => row.code === currency)?.quantity || 0;
    return { attempted: true, withdrawn };
  } catch (err) {
    return { attempted: true, withdrawn: 0, error: err };
  }
}

export async function getPreferredNpcTile(npcCode) {
  const npcMaps = await api.getMaps({ content_type: 'npc', content_code: npcCode });
  const npcTiles = Array.isArray(npcMaps) ? npcMaps : [];
  return npcTiles.find((tile) => {
    const conds = tile.access?.conditions;
    return !Array.isArray(conds) || conds.length === 0;
  }) || npcTiles[0] || null;
}

export async function buyItemFromNpc(ctx, { npcCode, itemCode, quantity }) {
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (!npcCode || !itemCode || qty <= 0) {
    return { attempted: false, ok: false, reason: 'invalid_input' };
  }

  const npcTile = await getPreferredNpcTile(npcCode);
  if (!npcTile) {
    return { attempted: false, ok: false, reason: 'npc_not_found' };
  }

  try {
    await moveTo(ctx, npcTile.x, npcTile.y);
  } catch (err) {
    if (err?.status === 496 || err?.code === 496) {
      return { attempted: false, ok: false, reason: 'condition_not_met', error: err };
    }
    throw err;
  }

  const result = await api.npcBuy(itemCode, qty, ctx.name);
  ctx.applyActionResult(result);
  await api.waitForCooldown(result);
  return { attempted: true, ok: true, result };
}
