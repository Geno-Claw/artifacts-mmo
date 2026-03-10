import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { resolve } from 'path';

const DEFAULT_BOT_CONFIG_PATH = './config/characters.json';
const DEFAULT_SCHEMA_PATH = './config/characters.schema.json';

export const MANAGED_ROUTINE_ORDER = Object.freeze([
  'rest',
  'depositBank',
  'bankExpansion',
  'event',
  'bossFight',
  'completeTask',
  'orderFulfillment',
  'skillRotation',
]);

export const TOGGLEABLE_ROUTINE_TYPES = Object.freeze([
  'event',
  'orderFulfillment',
  'skillRotation',
]);

const TOGGLEABLE_ROUTINE_TYPE_SET = new Set(TOGGLEABLE_ROUTINE_TYPES);

export const CONFIG_EDITOR_SKILL_NAMES = Object.freeze([
  'mining',
  'woodcutting',
  'fishing',
  'cooking',
  'alchemy',
  'weaponcrafting',
  'gearcrafting',
  'jewelrycrafting',
  'combat',
  'npc_task',
  'item_task',
  'achievement',
]);

export const CONFIG_EDITOR_ACHIEVEMENT_TYPES = Object.freeze([
  'combat_kill',
  'gathering',
  'crafting',
  'combat_drop',
  'use',
  'recycling',
  'task',
  'npc_buy',
  'npc_sell',
]);

export const ROUTINE_EDITOR_METADATA = Object.freeze([
  { type: 'rest', label: 'Rest', toggleable: false, readOnly: false },
  { type: 'depositBank', label: 'Deposit Bank', toggleable: false, readOnly: false },
  { type: 'bankExpansion', label: 'Bank Expansion', toggleable: false, readOnly: false },
  { type: 'event', label: 'Events', toggleable: true, readOnly: false },
  { type: 'bossFight', label: 'Boss Fight', toggleable: false, readOnly: false },
  { type: 'completeTask', label: 'Complete Task', toggleable: false, readOnly: true },
  { type: 'orderFulfillment', label: 'Order Fulfillment', toggleable: true, readOnly: false },
  { type: 'skillRotation', label: 'Skill Rotation', toggleable: true, readOnly: false },
]);

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export class ConfigStoreError extends Error {
  constructor(
    message,
    { status = 500, error = 'config_error', code = error, detail = message, errors = null } = {},
  ) {
    super(message);
    this.name = 'ConfigStoreError';
    this.status = status;
    this.error = error;
    this.code = code;
    this.detail = detail;
    if (Array.isArray(errors)) this.errors = errors;
  }
}

function sortedValue(value) {
  if (Array.isArray(value)) {
    return value.map(entry => sortedValue(entry));
  }

  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortedValue(value[key]);
    }
    return out;
  }

  return value;
}

export function toCanonicalJsonText(value) {
  return JSON.stringify(sortedValue(value));
}

export function hashCanonicalJson(value) {
  return createHash('sha256').update(toCanonicalJsonText(value)).digest('hex');
}

export function getBotConfigPaths({ cwd = process.cwd(), botConfigPath = process.env.BOT_CONFIG } = {}) {
  const raw = `${botConfigPath || DEFAULT_BOT_CONFIG_PATH}`.trim() || DEFAULT_BOT_CONFIG_PATH;
  return {
    path: raw,
    resolvedPath: resolve(cwd, raw),
  };
}

function getSchemaPath({ cwd = process.cwd(), schemaPath = DEFAULT_SCHEMA_PATH } = {}) {
  return resolve(cwd, schemaPath);
}

async function readJsonFile(filePath, { readCode, parseCode, parseError = 'bad_json' }) {
  let text = '';

  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new ConfigStoreError(`Failed to read JSON file at ${filePath}`, {
      status: 500,
      error: 'config_io_failed',
      code: readCode,
      detail: err?.message || 'File read failed',
    });
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigStoreError(`Invalid JSON file at ${filePath}`, {
      status: 500,
      error: parseError,
      code: parseCode,
      detail: err?.message || 'JSON parse failed',
    });
  }
}

let cachedSchemaPath = null;
let cachedSchema = null;

async function loadCharactersSchema(options = {}) {
  const schemaPath = getSchemaPath(options);
  if (cachedSchema && cachedSchemaPath === schemaPath) {
    return cachedSchema;
  }

  const schema = await readJsonFile(schemaPath, {
    readCode: 'schema_read_failed',
    parseCode: 'schema_bad_json',
    parseError: 'schema_bad_json',
  });

  cachedSchemaPath = schemaPath;
  cachedSchema = schema;
  return schema;
}

export async function getCharactersSchema(options = {}) {
  return loadCharactersSchema(options);
}

function decodeJsonPointerSegment(text) {
  return text.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveSchemaRef(rootSchema, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const segments = ref.slice(2).split('/').map(segment => decodeJsonPointerSegment(segment));
  let node = rootSchema;
  for (const segment of segments) {
    if (!node || typeof node !== 'object' || !hasOwn(node, segment)) {
      return null;
    }
    node = node[segment];
  }
  return node;
}

function valuesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isType(value, type) {
  if (type === 'object') return value != null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

function formatPath(parentPath, key) {
  if (typeof key === 'number') return `${parentPath}[${key}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${parentPath}.${key}`;
  return `${parentPath}[${JSON.stringify(key)}]`;
}

function pushError(errors, path, message) {
  errors.push({ path, message });
}

function validateAgainstSchema(value, schema, { rootSchema, path, errors }) {
  let activeSchema = schema;

  if (activeSchema && typeof activeSchema === 'object' && hasOwn(activeSchema, '$ref')) {
    const resolved = resolveSchemaRef(rootSchema, activeSchema.$ref);
    if (!resolved) {
      pushError(errors, path, `Unable to resolve schema ref ${activeSchema.$ref}`);
      return;
    }
    activeSchema = resolved;
  }

  if (!activeSchema || typeof activeSchema !== 'object') return;

  if (Array.isArray(activeSchema.oneOf) && activeSchema.oneOf.length > 0) {
    let matches = 0;

    for (const variant of activeSchema.oneOf) {
      const variantErrors = [];
      validateAgainstSchema(value, variant, { rootSchema, path, errors: variantErrors });
      if (variantErrors.length === 0) matches += 1;
    }

    if (matches !== 1) {
      pushError(
        errors,
        path,
        matches === 0 ? 'must match one allowed schema variant' : 'matches multiple schema variants',
      );
    }
    return;
  }

  if (activeSchema.type) {
    if (!isType(value, activeSchema.type)) {
      pushError(errors, path, `must be of type ${activeSchema.type}`);
      return;
    }
  }

  if (hasOwn(activeSchema, 'const') && !valuesEqual(value, activeSchema.const)) {
    pushError(errors, path, `must equal ${JSON.stringify(activeSchema.const)}`);
    return;
  }

  if (Array.isArray(activeSchema.enum) && !activeSchema.enum.some(entry => valuesEqual(entry, value))) {
    pushError(errors, path, `must be one of: ${activeSchema.enum.map(entry => JSON.stringify(entry)).join(', ')}`);
    return;
  }

  if (activeSchema.type === 'number') {
    if (hasOwn(activeSchema, 'minimum') && value < activeSchema.minimum) {
      pushError(errors, path, `must be >= ${activeSchema.minimum}`);
    }
    if (hasOwn(activeSchema, 'maximum') && value > activeSchema.maximum) {
      pushError(errors, path, `must be <= ${activeSchema.maximum}`);
    }
    return;
  }

  if (activeSchema.type === 'array') {
    if (activeSchema.items && typeof activeSchema.items === 'object') {
      for (let idx = 0; idx < value.length; idx++) {
        validateAgainstSchema(value[idx], activeSchema.items, {
          rootSchema,
          path: formatPath(path, idx),
          errors,
        });
      }
    }
    return;
  }

  if (activeSchema.type === 'object') {
    const obj = value;
    const properties = activeSchema.properties && typeof activeSchema.properties === 'object'
      ? activeSchema.properties
      : {};

    if (Array.isArray(activeSchema.required)) {
      for (const requiredKey of activeSchema.required) {
        if (!hasOwn(obj, requiredKey)) {
          pushError(errors, formatPath(path, requiredKey), 'is required');
        }
      }
    }

    if (activeSchema.propertyNames && typeof activeSchema.propertyNames === 'object') {
      for (const key of Object.keys(obj)) {
        validateAgainstSchema(key, activeSchema.propertyNames, {
          rootSchema,
          path: formatPath(path, key),
          errors,
        });
      }
    }

    for (const key of Object.keys(obj)) {
      const childPath = formatPath(path, key);

      if (hasOwn(properties, key)) {
        validateAgainstSchema(obj[key], properties[key], {
          rootSchema,
          path: childPath,
          errors,
        });
        continue;
      }

      if (activeSchema.additionalProperties === false) {
        pushError(errors, childPath, 'is not allowed');
        continue;
      }

      if (activeSchema.additionalProperties && typeof activeSchema.additionalProperties === 'object') {
        validateAgainstSchema(obj[key], activeSchema.additionalProperties, {
          rootSchema,
          path: childPath,
          errors,
        });
      }
    }
  }
}

function dedupeErrors(errors) {
  const seen = new Set();
  const out = [];
  for (const entry of errors) {
    const key = `${entry.path}::${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export async function validateBotConfig(config, options = {}) {
  const schema = await loadCharactersSchema(options);
  const errors = [];
  validateAgainstSchema(config, schema, {
    rootSchema: schema,
    path: '$',
    errors,
  });

  const finalErrors = dedupeErrors(errors);
  return {
    ok: finalErrors.length === 0,
    errors: finalErrors,
  };
}

function routineItemsSchema(rootSchema) {
  return rootSchema?.properties?.characters?.items?.properties?.routines?.items || null;
}

function buildRoutineFromSchema(type, rootSchema) {
  const itemsSchema = routineItemsSchema(rootSchema);
  if (!itemsSchema) return { type };

  const normalized = applySchemaDefaults({ type }, itemsSchema, rootSchema);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return { type };
  }
  return normalized;
}

function buildManagedRoutinePlaceholder(type, rootSchema) {
  const base = buildRoutineFromSchema(type, rootSchema);
  if (TOGGLEABLE_ROUTINE_TYPE_SET.has(type)) {
    return {
      ...base,
      enabled: false,
    };
  }
  return base;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toRoutineArray(value) {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function cloneJson(value) {
  return structuredClone(value);
}

function materializeCharacterRoutines(characterConfig, rootSchema) {
  const routines = toRoutineArray(characterConfig?.routines);
  const nextManaged = [];
  const extras = [];
  const seenManaged = new Set();

  for (const routine of routines) {
    const type = typeof routine?.type === 'string' ? routine.type : '';
    if (!MANAGED_ROUTINE_ORDER.includes(type) || seenManaged.has(type)) {
      extras.push(cloneJson(routine));
      continue;
    }
    seenManaged.add(type);
    nextManaged.push(cloneJson(routine));
  }

  const byType = new Map(nextManaged.map(routine => [routine.type, routine]));
  const orderedManaged = MANAGED_ROUTINE_ORDER.map((type) => {
    const existing = byType.get(type);
    if (existing) return existing;
    return buildManagedRoutinePlaceholder(type, rootSchema);
  });

  return orderedManaged.concat(extras);
}

export async function getRoutineEditorMetadata(options = {}) {
  const schema = await loadCharactersSchema(options);
  return ROUTINE_EDITOR_METADATA.map((entry) => ({
    ...entry,
    defaultConfig: buildManagedRoutinePlaceholder(entry.type, schema),
  }));
}

export async function prepareConfigForSave(config, options = {}) {
  const schema = await loadCharactersSchema(options);
  const normalizedRoot = applySchemaDefaults(config, schema, schema);
  const next = cloneJson(normalizedRoot);
  const characters = Array.isArray(next?.characters) ? next.characters : [];

  for (let index = 0; index < characters.length; index++) {
    const character = isPlainObject(characters[index]) ? characters[index] : {};
    characters[index] = {
      ...character,
      routines: materializeCharacterRoutines(character, schema),
    };
  }

  return {
    config: next,
    changed: !valuesEqual(config, next),
  };
}

function namesInOrder(config) {
  const characters = Array.isArray(config?.characters) ? config.characters : [];
  return characters.map(char => `${char?.name ?? ''}`.trim()).filter(Boolean);
}

function countsByRoutineType(characterConfig) {
  const counts = new Map();
  for (const routine of toRoutineArray(characterConfig?.routines)) {
    const type = `${routine?.type ?? ''}`.trim();
    if (!type) continue;
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return counts;
}

function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function prioritiesByRoutineType(characterConfig) {
  const priorities = new Map();
  for (const routine of toRoutineArray(characterConfig?.routines)) {
    const type = `${routine?.type ?? ''}`.trim();
    if (!type) continue;
    const bucket = priorities.get(type) || [];
    bucket.push(Number(routine?.priority));
    priorities.set(type, bucket);
  }
  return priorities;
}

function priorityMapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, values] of a) {
    const other = b.get(key);
    if (!Array.isArray(other) || other.length !== values.length) return false;
    for (let index = 0; index < values.length; index++) {
      if (other[index] !== values[index]) return false;
    }
  }
  return true;
}

export function analyzeConfigRestartRequirements(currentConfig, nextConfig) {
  const restartReasons = [];
  const currentNames = namesInOrder(currentConfig);
  const nextNames = namesInOrder(nextConfig);

  if (!valuesEqual(currentNames, nextNames)) {
    restartReasons.push('Character roster changed');
  }

  const currentByName = new Map(
    (Array.isArray(currentConfig?.characters) ? currentConfig.characters : [])
      .filter(isPlainObject)
      .map(character => [`${character.name ?? ''}`.trim(), character]),
  );
  const nextByName = new Map(
    (Array.isArray(nextConfig?.characters) ? nextConfig.characters : [])
      .filter(isPlainObject)
      .map(character => [`${character.name ?? ''}`.trim(), character]),
  );

  for (const name of nextNames) {
    if (!currentByName.has(name) || !nextByName.has(name)) continue;

    const currentChar = currentByName.get(name);
    const nextChar = nextByName.get(name);
    const currentCounts = countsByRoutineType(currentChar);
    const nextCounts = countsByRoutineType(nextChar);
    if (!mapsEqual(currentCounts, nextCounts)) {
      restartReasons.push(`Routine membership changed for ${name}`);
      continue;
    }

    const currentPriorities = prioritiesByRoutineType(currentChar);
    const nextPriorities = prioritiesByRoutineType(nextChar);
    if (!priorityMapsEqual(currentPriorities, nextPriorities)) {
      restartReasons.push(`Routine priority changed for ${name}`);
    }
  }

  return {
    requiresRestart: restartReasons.length > 0,
    restartReasons,
  };
}

// ── Schema-driven config normalization ──────────────────────────────

/**
 * Given a value and a list of oneOf schema variants, find the variant
 * whose properties.type.const matches value.type.
 */
function findOneOfVariant(value, variants, rootSchema) {
  const valueType = value?.type;
  if (typeof valueType !== 'string') return null;

  for (const variant of variants) {
    let resolved = variant;
    if (resolved && hasOwn(resolved, '$ref')) {
      resolved = resolveSchemaRef(rootSchema, resolved.$ref);
      if (!resolved) continue;
    }
    const typeProp = resolved?.properties?.type;
    if (typeProp && hasOwn(typeProp, 'const') && typeProp.const === valueType) {
      return resolved;
    }
  }
  return null;
}

/**
 * Recursively fill missing properties with defaults declared in the JSON
 * Schema.  Returns a new value with defaults applied (never mutates input).
 */
function applySchemaDefaults(value, schema, rootSchema) {
  let activeSchema = schema;

  // Resolve $ref
  if (activeSchema && typeof activeSchema === 'object' && hasOwn(activeSchema, '$ref')) {
    const resolved = resolveSchemaRef(rootSchema, activeSchema.$ref);
    if (!resolved) return value;
    activeSchema = resolved;
  }

  if (!activeSchema || typeof activeSchema !== 'object') return value;

  // Handle oneOf: find the matching variant by type.const, recurse into it
  if (Array.isArray(activeSchema.oneOf) && activeSchema.oneOf.length > 0) {
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      const matched = findOneOfVariant(value, activeSchema.oneOf, rootSchema);
      if (matched) return applySchemaDefaults(value, matched, rootSchema);
    }
    return value;
  }

  // Value is missing — use schema default or synthesize object from property defaults
  if (value === undefined) {
    if (hasOwn(activeSchema, 'default')) {
      return structuredClone(activeSchema.default);
    }
    if (activeSchema.type === 'object' && activeSchema.properties) {
      return applySchemaDefaults({}, activeSchema, rootSchema);
    }
    return undefined;
  }

  // Object: fill missing properties, recurse into existing ones
  if (activeSchema.type === 'object' && value != null && typeof value === 'object' && !Array.isArray(value)) {
    const result = { ...value };
    const properties = activeSchema.properties || {};

    for (const [key, propSchema] of Object.entries(properties)) {
      const normalized = applySchemaDefaults(result[key], propSchema, rootSchema);
      if (normalized !== undefined) {
        result[key] = normalized;
      }
    }

    // Recurse into user-provided keys covered by additionalProperties schema
    if (activeSchema.additionalProperties && typeof activeSchema.additionalProperties === 'object') {
      for (const key of Object.keys(result)) {
        if (hasOwn(properties, key)) continue;
        result[key] = applySchemaDefaults(result[key], activeSchema.additionalProperties, rootSchema);
      }
    }

    // Strip properties not in schema when additionalProperties is false
    // This handles schema migrations where fields are removed
    if (activeSchema.additionalProperties === false) {
      for (const key of Object.keys(result)) {
        if (!hasOwn(properties, key)) {
          delete result[key];
        }
      }
    }

    return result;
  }

  // Array: recurse into each item
  if (activeSchema.type === 'array' && Array.isArray(value) && activeSchema.items) {
    return value.map(item => applySchemaDefaults(item, activeSchema.items, rootSchema));
  }

  // Scalar or type mismatch — return as-is
  return value;
}

/**
 * Apply schema defaults to a bot config object.
 * Returns a new object with all missing fields filled from schema defaults,
 * plus a flag indicating whether anything was added.
 */
export async function normalizeConfig(config, options = {}) {
  const schema = await loadCharactersSchema(options);
  const normalized = applySchemaDefaults(config, schema, schema);
  const changed = !valuesEqual(config, normalized);
  return { config: normalized, changed };
}

export async function loadConfigSnapshot(options = {}) {
  const paths = getBotConfigPaths(options);
  const config = await readJsonFile(paths.resolvedPath, {
    readCode: 'config_read_failed',
    parseCode: 'config_bad_json',
    parseError: 'config_bad_json',
  });

  return {
    path: paths.path,
    resolvedPath: paths.resolvedPath,
    hash: hashCanonicalJson(config),
    config,
  };
}

async function removeFileIfPresent(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // No-op
  }
}

export async function saveConfigAtomically(config, options = {}) {
  const paths = getBotConfigPaths(options);
  const canonical = sortedValue(config);
  const text = `${JSON.stringify(canonical, null, 2)}\n`;
  const tmpPath = `${paths.resolvedPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const savedAtMs = Date.now();

  try {
    await fs.writeFile(tmpPath, text, 'utf-8');
    await fs.rename(tmpPath, paths.resolvedPath);
  } catch (err) {
    await removeFileIfPresent(tmpPath);
    throw new ConfigStoreError(`Failed to persist config at ${paths.resolvedPath}`, {
      status: 500,
      error: 'config_io_failed',
      code: 'config_write_failed',
      detail: err?.message || 'File write failed',
    });
  }

  return {
    path: paths.path,
    resolvedPath: paths.resolvedPath,
    hash: hashCanonicalJson(canonical),
    savedAtMs,
  };
}
