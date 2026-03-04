import { AsyncLocalStorage } from 'node:async_hooks';

const contextStorage = new AsyncLocalStorage();

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeContext(ctx) {
  if (!isObject(ctx)) return {};
  return { ...ctx };
}

export function getLogContext() {
  return contextStorage.getStore() || {};
}

export function runWithLogContext(ctx, fn) {
  if (typeof fn !== 'function') {
    throw new Error('runWithLogContext(ctx, fn) requires a function');
  }
  const merged = {
    ...getLogContext(),
    ...normalizeContext(ctx),
  };
  return contextStorage.run(merged, fn);
}
