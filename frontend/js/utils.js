function formatLogTime(atMs) {
  if (!atMs) return '';
  const d = new Date(atMs);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function itemList(items) {
  if (!items?.length) return '';
  return items.map(i => `${i.code || i.item}x${i.qty || i.quantity}`).join(', ');
}

function formatLogSummary(type, d) {
  if (!d) return null;
  switch (type) {
    case 'fight': {
      const won = d.result === 'win';
      const base = won ? `Won vs ${d.monster || '?'}` : `Lost vs ${d.monster || '?'}`;
      const parts = [base];
      if (d.xp) parts.push(`+${d.xp}xp`);
      if (d.gold) parts.push(`+${d.gold}g`);
      const drops = itemList(d.drops);
      if (drops) parts.push(drops);
      return parts.join(' ');
    }
    case 'gathering': {
      const parts = [];
      if (d.skill) parts.push(d.skill);
      if (d.resource) parts.push(d.resource);
      if (d.xp) parts.push(`+${d.xp}xp`);
      const drops = itemList(d.drops);
      if (drops) parts.push(drops);
      return parts.join(' ') || null;
    }
    case 'crafting': {
      const parts = [`Crafted ${d.item || '?'}`];
      if (d.quantity > 1) parts[0] += ` x${d.quantity}`;
      if (d.xp) parts.push(`+${d.xp}xp`);
      return parts.join(' ');
    }
    case 'movement':
      return `\u2192 ${d.map || '?'} (${d.x},${d.y})`;
    case 'use':
      return `Used ${d.item || '?'}`;
    case 'rest':
      return `Rested +${d.hpRestored || 0}HP`;
    case 'deposit_item':
      return `Deposited ${d.items?.length || 0} item type${d.items?.length !== 1 ? 's' : ''}`;
    case 'deposit_gold':
      return `Deposited ${d.gold || 0}g`;
    case 'withdraw_item': {
      const summary = itemList(d.items);
      return `Withdrew ${summary || 'items'}`;
    }
    case 'withdraw_gold':
      return `Withdrew ${d.gold || 0}g`;
    case 'equip':
      return `Equipped ${d.item || '?'} \u2192 ${d.slot || '?'}`;
    case 'unequip':
      return `Unequipped ${d.item || '?'} \u2190 ${d.slot || '?'}`;
    default:
      return null;
  }
}

function formatLogTooltip(type, d, description) {
  if (!d) return description || '';
  const lines = [description || ''];

  if (type === 'fight' && Array.isArray(d.turns) && d.turns.length) {
    lines.push('');
    for (let i = 0; i < d.turns.length; i++) {
      const t = d.turns[i];
      if (!t) continue;
      const atk = t.attacker_name || 'Attacker';
      const def = t.defender_name || 'Defender';
      const dmg = t.damage ?? '?';
      const parts = [`T${i + 1}: ${atk} \u2192 ${def} ${dmg}dmg`];
      if (t.ability) parts.push(`(${t.ability})`);
      lines.push(parts.join(' '));
    }
  }

  if (type === 'movement' && Array.isArray(d.path) && d.path.length > 2) {
    lines.push('');
    lines.push('Path: ' + d.path.map(p => `(${p[0]},${p[1]})`).join(' \u2192 '));
  }

  if ((type === 'deposit_item' || type === 'withdraw_item') && d.items?.length) {
    lines.push('');
    lines.push('Items: ' + itemList(d.items));
  }

  return lines.join('\n');
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function safeText(text, fallback = '') {
  const str = `${text ?? ''}`.trim();
  return str.length > 0 ? str : fallback;
}

function hashPortraitType(name) {
  let hash = 0;
  const value = `${name || ''}`;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % 3;
  if (idx === 0) return 'warrior';
  if (idx === 1) return 'mage';
  return 'gatherer';
}

function escapeHtml(value) {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumberish(value, fallback = '--') {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString() : fallback;
}

function formatTime(value) {
  const ms = toNumber(value, 0);
  if (ms <= 0) return '--';
  const date = new Date(ms);
  return Number.isNaN(date.getTime())
    ? '--'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatUpperToken(value, fallback = '--') {
  const text = safeText(value, '');
  if (!text) return fallback;
  return text.replace(/[_-]+/g, ' ').toUpperCase();
}

function formatGold(value) {
  if (value == null || !Number.isFinite(value)) return '--';
  return value.toLocaleString();
}

function hasMeaningfulStatValue(value) {
  const text = safeText(value, '');
  if (!text) return false;
  if (text === '--') return false;
  if (text === '-- / --') return false;
  if (text.startsWith('--, --')) return false;
  return true;
}

function closestFromEventTarget(event, selector) {
  const rawTarget = event?.target;
  if (rawTarget instanceof Element) {
    return rawTarget.closest(selector);
  }
  const parent = rawTarget?.parentElement;
  if (parent instanceof Element) {
    return parent.closest(selector);
  }
  return null;
}

function extractApiData(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

function toBoolLike(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  const text = safeText(value, '').toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'completed' || text === 'done';
}
