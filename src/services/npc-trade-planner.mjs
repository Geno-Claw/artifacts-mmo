/**
 * NPC trade planner.
 * Pure helpers for currency-aware NPC purchase planning.
 */
import { toPositiveInt } from '../utils.mjs';

function toNonNegativeInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

function normalizeCurrency(currency) {
  if (typeof currency !== 'string') return '';
  return currency.trim();
}

function normalizeOffer(rawOffer) {
  if (!rawOffer || typeof rawOffer !== 'object') return null;
  const currency = normalizeCurrency(rawOffer.currency);
  const buyPrice = toPositiveInt(rawOffer.buyPrice ?? rawOffer.buy_price ?? rawOffer.price);
  if (!currency || buyPrice <= 0) return null;
  const code = typeof rawOffer.code === 'string' ? rawOffer.code.trim() : '';
  return { code, currency, buyPrice };
}

/**
 * Maximum quantity affordable for a unit price and available budget.
 */
export function maxAffordableQuantity(unitPrice, budget) {
  const price = toPositiveInt(unitPrice);
  if (price <= 0) return 0;
  return Math.floor(toNonNegativeInt(budget) / price);
}

/**
 * Missing currency amount needed to buy `quantity` at `unitPrice`,
 * after accounting for currently carried currency.
 */
export function missingCurrencyForQuantity(quantity, unitPrice, carriedCurrency) {
  const qty = toPositiveInt(quantity);
  const price = toPositiveInt(unitPrice);
  if (qty <= 0 || price <= 0) return 0;
  const required = qty * price;
  const carried = toNonNegativeInt(carriedCurrency);
  return Math.max(0, required - carried);
}

/**
 * Build a currency-aware shopping plan for NPC purchases.
 *
 * @param {Array<{code:string, quantity:number, reason?:string}>} shoppingList
 * @param {{
 *   getOffer?: (itemCode: string) => { code?: string, currency: string, buyPrice?: number, buy_price?: number, price?: number } | null,
 *   getCarried?: (currency: string) => number,
 *   getBank?: (currency: string) => number,
 * }} opts
 * @returns {{
 *   items: Array<{code:string, quantity:number, reason?:string, currency:string, unitPrice:number, totalCost:number}>,
 *   carriedByCurrency: Map<string, number>,
 *   bankByCurrency: Map<string, number>,
 *   spentByCurrency: Map<string, number>,
 *   neededFromBank: Map<string, number>,
 * }}
 */
export function buildNpcCurrencyPlan(shoppingList, opts = {}) {
  const list = Array.isArray(shoppingList) ? shoppingList : [];
  const getOffer = typeof opts.getOffer === 'function' ? opts.getOffer : () => null;
  const getCarried = typeof opts.getCarried === 'function' ? opts.getCarried : () => 0;
  const getBank = typeof opts.getBank === 'function' ? opts.getBank : () => 0;

  const items = [];
  const carriedByCurrency = new Map();
  const bankByCurrency = new Map();
  const remainingByCurrency = new Map();
  const spentByCurrency = new Map();

  for (const row of list) {
    const code = typeof row?.code === 'string' ? row.code.trim() : '';
    const desiredQty = toPositiveInt(row?.quantity);
    if (!code || desiredQty <= 0) continue;

    const offer = normalizeOffer(getOffer(code));
    if (!offer) continue;

    const currency = offer.currency;
    if (!remainingByCurrency.has(currency)) {
      const carried = toNonNegativeInt(getCarried(currency));
      const bank = toNonNegativeInt(getBank(currency));
      carriedByCurrency.set(currency, carried);
      bankByCurrency.set(currency, bank);
      remainingByCurrency.set(currency, carried + bank);
      spentByCurrency.set(currency, 0);
    }

    const remaining = remainingByCurrency.get(currency) || 0;
    const affordable = maxAffordableQuantity(offer.buyPrice, remaining);
    if (affordable <= 0) continue;

    const qty = Math.min(desiredQty, affordable);
    if (qty <= 0) continue;

    const totalCost = qty * offer.buyPrice;
    remainingByCurrency.set(currency, Math.max(0, remaining - totalCost));
    spentByCurrency.set(currency, (spentByCurrency.get(currency) || 0) + totalCost);

    items.push({
      code,
      quantity: qty,
      reason: row?.reason,
      currency,
      unitPrice: offer.buyPrice,
      totalCost,
    });
  }

  const neededFromBank = new Map();
  for (const [currency, spent] of spentByCurrency.entries()) {
    const carried = carriedByCurrency.get(currency) || 0;
    neededFromBank.set(currency, Math.max(0, spent - carried));
  }

  return {
    items,
    carriedByCurrency,
    bankByCurrency,
    spentByCurrency,
    neededFromBank,
  };
}

