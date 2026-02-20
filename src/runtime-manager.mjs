import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Scheduler } from './scheduler.mjs';
import { CharacterContext } from './context.mjs';
import { buildRoutines } from './routines/factory.mjs';
import * as log from './log.mjs';
import { toPositiveInt } from './utils.mjs';
import { initialize as initGameData } from './services/game-data.mjs';
import { initialize as initInventoryManager } from './services/inventory-manager.mjs';
import { loadSellRules } from './services/ge-seller.mjs';
import {
  clearOrderBoard,
  flushOrderBoard,
  initializeOrderBoard,
  releaseClaimsForChars,
} from './services/order-board.mjs';
import {
  flushGearState,
  initializeGearState,
  refreshGearState,
  registerContext,
  unregisterContext,
} from './services/gear-state.mjs';
import { createCharacter, subscribeActionEvents } from './api.mjs';
import { initializeUiState, recordCooldown, recordLog } from './services/ui-state.mjs';
import {
  initialize as initWebSocket,
  cleanup as cleanupWebSocket,
  getState as getWebSocketState,
} from './services/websocket-client.mjs';

const DEFAULT_CONFIG_PATH = './config/characters.json';
const DEFAULT_STOP_TIMEOUT_MS = 120_000;
const ORDER_BOARD_ROLLOUT_MARKER = './report/.order-board-v2-rollout';

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise.then((value) => ({ timedOut: false, value }));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ timedOut: true, value: null });
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export class RuntimeManagerError extends Error {
  constructor(
    message,
    {
      status = 500,
      error = 'runtime_error',
      code = error,
      detail = message,
      meta = null,
    } = {},
  ) {
    super(message);
    this.name = 'RuntimeManagerError';
    this.status = status;
    this.error = error;
    this.code = code;
    this.detail = detail;
    if (meta && typeof meta === 'object') {
      Object.assign(this, meta);
    }
  }
}

export class RuntimeOperationConflictError extends RuntimeManagerError {
  constructor(currentOperation, requestedOperation) {
    super(`Control operation "${currentOperation}" is already in progress`, {
      status: 409,
      error: 'operation_conflict',
      code: 'operation_conflict',
      detail: `Operation "${currentOperation}" is already in progress`,
      meta: {
        currentOperation,
        requestedOperation,
      },
    });
    this.name = 'RuntimeOperationConflictError';
  }
}

export class RuntimeManager {
  constructor({ defaultStopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) {
    this.defaultStopTimeoutMs = toPositiveInt(defaultStopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);

    this.state = 'stopped';
    this.lastError = null;
    this.activeOperation = null;
    this.activeRun = null;
    this.updatedAtMs = Date.now();
    this.runSeq = 0;
    this.lastConfigPath = process.env.BOT_CONFIG || DEFAULT_CONFIG_PATH;
  }

  _setState(nextState) {
    this.state = nextState;
    this.updatedAtMs = Date.now();
  }

  _recordError(code, detail) {
    this.lastError = {
      code,
      detail,
      atMs: Date.now(),
    };
    this.updatedAtMs = Date.now();
  }

  _clearError() {
    this.lastError = null;
    this.updatedAtMs = Date.now();
  }

  _wrapRuntimeError(err, fallbackCode, fallbackMessage) {
    if (err instanceof RuntimeManagerError) {
      return err;
    }

    const detail = err?.message || fallbackMessage;
    return new RuntimeManagerError(fallbackMessage || detail, {
      status: 500,
      error: 'runtime_error',
      code: fallbackCode,
      detail,
    });
  }

  _loadRuntimeConfig() {
    const configPath = process.env.BOT_CONFIG || DEFAULT_CONFIG_PATH;
    this.lastConfigPath = configPath;

    let raw;
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch (err) {
      throw new RuntimeManagerError(`Failed to read BOT_CONFIG at "${configPath}"`, {
        status: 500,
        error: 'config_error',
        code: 'config_read_failed',
        detail: err?.message || `Could not read ${configPath}`,
      });
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new RuntimeManagerError(`Failed to parse BOT_CONFIG at "${configPath}"`, {
        status: 500,
        error: 'config_error',
        code: 'config_parse_failed',
        detail: err?.message || `Invalid JSON in ${configPath}`,
      });
    }

    if (!Array.isArray(config.characters)) {
      throw new RuntimeManagerError(`Config "${configPath}" must include a top-level "characters" array`, {
        status: 500,
        error: 'config_error',
        code: 'config_invalid',
      });
    }

    for (const [index, charCfg] of config.characters.entries()) {
      const label = charCfg?.name ? `character "${charCfg.name}"` : `character at index ${index}`;
      if (!Array.isArray(charCfg?.routines)) {
        if (Object.prototype.hasOwnProperty.call(charCfg ?? {}, 'tasks')) {
          throw new RuntimeManagerError(`Config error for ${label}: "tasks" was removed, use "routines"`, {
            status: 500,
            error: 'config_error',
            code: 'config_invalid',
          });
        }
        throw new RuntimeManagerError(`Config error for ${label}: missing required "routines" array`, {
          status: 500,
          error: 'config_error',
          code: 'config_invalid',
        });
      }
    }

    return { configPath, config };
  }

  _buildRunContext(configPath, config) {
    const configuredNames = config.characters
      .map(charCfg => charCfg?.name)
      .filter(Boolean);
    const configuredNameSet = new Set(configuredNames);

    initializeUiState({
      characterNames: configuredNames,
      configPath,
      startedAt: Date.now(),
    });

    const unsubscribeLogEvents = log.subscribeLogEvents((entry) => {
      const match = entry.msg.match(/^\[([^\]]+)\]/);
      if (!match) return;
      const name = match[1];
      if (!configuredNameSet.has(name)) return;

      recordLog(name, {
        level: entry.level,
        line: entry.msg,
        at: entry.at,
      });
    });

    const unsubscribeActionEvents = subscribeActionEvents((entry) => {
      if (!configuredNameSet.has(entry.name)) return;
      const cooldown = entry.cooldown || {};
      recordCooldown(entry.name, {
        action: entry.action,
        totalSeconds: cooldown.total_seconds ?? cooldown.remaining_seconds ?? 0,
        remainingSeconds: cooldown.remaining_seconds ?? cooldown.total_seconds ?? 0,
        observedAt: entry.observedAt,
      });
    });

    return {
      runId: ++this.runSeq,
      configPath,
      characterNames: configuredNames,
      characterConfigs: config.characters,
      schedulerEntries: [],
      loopPromises: [],
      unsubscribeLogEvents,
      unsubscribeActionEvents,
      startedAtMs: Date.now(),
    };
  }

  async _createScheduler(charCfg) {
    const ctx = new CharacterContext(charCfg.name, charCfg.settings || {});
    const routines = buildRoutines(charCfg.routines);

    try {
      await ctx.refresh();
    } catch (err) {
      if (err.code === 404 || err.code === 498) {
        const skin = charCfg.skin || 'men1';
        log.info(`[${charCfg.name}] Character not found - creating with skin "${skin}"`);
        await createCharacter(charCfg.name, skin);
        await ctx.refresh();
      } else {
        throw err;
      }
    }

    const char = ctx.get();
    log.info(`[${char.name}] Lv${char.level} | ${char.hp}/${char.max_hp} HP | ${char.gold}g | (${char.x},${char.y})`);

    return {
      scheduler: new Scheduler(ctx, routines),
      ctx,
    };
  }

  _runOrderBoardRolloutResetIfNeeded() {
    if (existsSync(ORDER_BOARD_ROLLOUT_MARKER)) return;

    clearOrderBoard('rollout_v2_hard_clear');
    mkdirSync(dirname(ORDER_BOARD_ROLLOUT_MARKER), { recursive: true });
    writeFileSync(
      ORDER_BOARD_ROLLOUT_MARKER,
      `${JSON.stringify({ clearedAtMs: Date.now() }, null, 2)}\n`,
      'utf-8',
    );
    log.info('[Runtime] Order-board rollout hard-clear completed');
  }

  _handleSchedulerFailure(runId, charName, err) {
    const run = this.activeRun;
    if (!run || run.runId !== runId) return;
    if (this.state === 'stopping' || this.state === 'stopped') return;

    const detail = err?.message || 'Scheduler loop crashed';
    this._recordError('scheduler_crash', `[${charName}] ${detail}`);
    this._setState('error');
    log.error(`[Runtime] Scheduler loop crashed for ${charName}`, detail);
  }

  async _cleanupRun(run) {
    if (!run) return;

    try {
      releaseClaimsForChars(run.characterNames, 'runtime_cleanup');
    } catch (err) {
      log.warn(`[Runtime] Could not release order claims during cleanup: ${err?.message || String(err)}`);
    }

    try {
      await flushOrderBoard();
    } catch (err) {
      log.warn(`[Runtime] Could not flush order board during cleanup: ${err?.message || String(err)}`);
    }

    try {
      await flushGearState();
    } catch (err) {
      log.warn(`[Runtime] Could not flush gear-state during cleanup: ${err?.message || String(err)}`);
    }

    try {
      await cleanupWebSocket();
    } catch (err) {
      log.warn(`[Runtime] WebSocket cleanup failed: ${err?.message || String(err)}`);
    }

    for (const entry of run.schedulerEntries) {
      unregisterContext(entry.name);
    }

    if (typeof run.unsubscribeActionEvents === 'function') {
      try {
        run.unsubscribeActionEvents();
      } catch {
        // No-op
      }
      run.unsubscribeActionEvents = null;
    }

    if (typeof run.unsubscribeLogEvents === 'function') {
      try {
        run.unsubscribeLogEvents();
      } catch {
        // No-op
      }
      run.unsubscribeLogEvents = null;
    }
  }

  async _startInternal() {
    if (this.activeRun) {
      if (this.state === 'running') {
        return this.getStatus();
      }
      throw new RuntimeManagerError('Runtime is already active', {
        status: 409,
        error: 'operation_conflict',
        code: 'runtime_already_active',
      });
    }

    this._setState('starting');
    let run = null;

    try {
      const { configPath, config } = this._loadRuntimeConfig();
      run = this._buildRunContext(configPath, config);

      log.info(`Bot starting - ${config.characters.length} character(s)`);

      await initGameData();
      await initInventoryManager();
      await initializeOrderBoard();
      this._runOrderBoardRolloutResetIfNeeded();
      await initializeGearState({ characters: config.characters });
      loadSellRules();

      const wsUrl = process.env.WEBSOCKET_URL;
      if (wsUrl) {
        await initWebSocket({ url: wsUrl, token: process.env.ARTIFACTS_TOKEN });
      }

      for (const charCfg of config.characters) {
        const { scheduler, ctx } = await this._createScheduler(charCfg);
        registerContext(ctx);
        run.schedulerEntries.push({
          name: charCfg.name,
          scheduler,
          ctx,
        });
      }

      await refreshGearState({ force: true });

      run.loopPromises = run.schedulerEntries.map((entry) => {
        return entry.scheduler.run().catch((err) => {
          this._handleSchedulerFailure(run.runId, entry.name, err);
        });
      });

      this.activeRun = run;
      this._clearError();
      this._setState('running');
      return this.getStatus();
    } catch (err) {
      if (run) {
        for (const entry of run.schedulerEntries) {
          entry.scheduler.stop();
        }
        await withTimeout(Promise.allSettled(run.loopPromises), this.defaultStopTimeoutMs);
        await this._cleanupRun(run);
      }

      const wrapped = this._wrapRuntimeError(err, 'runtime_start_failed', 'Runtime start failed');
      this._recordError(wrapped.code || 'runtime_start_failed', wrapped.detail || wrapped.message);
      this._setState('error');
      throw wrapped;
    }
  }

  async _stopInternal(gracefulTimeoutMs = this.defaultStopTimeoutMs) {
    const run = this.activeRun;
    const timeoutMs = toPositiveInt(gracefulTimeoutMs, this.defaultStopTimeoutMs);

    if (!run) {
      this._setState('stopped');
      return this.getStatus();
    }

    this._setState('stopping');

    for (const entry of run.schedulerEntries) {
      entry.scheduler.stop();
    }

    const waitResult = await withTimeout(Promise.allSettled(run.loopPromises), timeoutMs);
    if (waitResult.timedOut) {
      const detail = `Graceful stop timed out after ${timeoutMs}ms`;
      this._recordError('graceful_stop_timeout', detail);
      this._setState('error');
      throw new RuntimeManagerError(detail, {
        status: 504,
        error: 'runtime_stop_timeout',
        code: 'graceful_stop_timeout',
        detail,
        meta: {
          statusSnapshot: this.getStatus(),
        },
      });
    }

    await this._cleanupRun(run);
    this.activeRun = null;
    this._setState('stopped');
    return this.getStatus();
  }

  async _restartInternal(gracefulTimeoutMs = this.defaultStopTimeoutMs) {
    if (this.activeRun) {
      await this._stopInternal(gracefulTimeoutMs);
    }
    return this._startInternal();
  }

  async _runOperation(operationName, fn) {
    if (this.activeOperation) {
      throw new RuntimeOperationConflictError(this.activeOperation.name, operationName);
    }

    const op = {
      name: operationName,
      startedAtMs: Date.now(),
    };

    this.activeOperation = op;
    this.updatedAtMs = Date.now();

    try {
      return await fn();
    } finally {
      if (this.activeOperation === op) {
        this.activeOperation = null;
      }
      this.updatedAtMs = Date.now();
    }
  }

  getStatus() {
    const run = this.activeRun;

    return {
      state: this.state,
      operation: this.activeOperation
        ? {
          name: this.activeOperation.name,
          startedAtMs: this.activeOperation.startedAtMs,
        }
        : null,
      runtime: {
        active: !!run,
        runId: run?.runId ?? null,
        startedAtMs: run?.startedAtMs ?? null,
        configPath: run?.configPath || this.lastConfigPath,
        characterCount: run?.characterNames?.length || 0,
        characterNames: run?.characterNames ? [...run.characterNames] : [],
      },
      websocket: getWebSocketState(),
      lastError: this.lastError ? { ...this.lastError } : null,
      updatedAtMs: this.updatedAtMs,
    };
  }

  async start() {
    return this._runOperation('start', () => this._startInternal());
  }

  async stop(gracefulTimeoutMs = this.defaultStopTimeoutMs) {
    return this._runOperation('stop', () => this._stopInternal(gracefulTimeoutMs));
  }

  async reloadConfig() {
    return this._runOperation('reload_config', () => this._restartInternal(this.defaultStopTimeoutMs));
  }

  async restart() {
    return this._runOperation('restart', () => this._restartInternal(this.defaultStopTimeoutMs));
  }
}

export function createRuntimeManager(options = {}) {
  return new RuntimeManager(options);
}
