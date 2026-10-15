/**
 * History worker pool (WP-13 §3.2, A.3, F.15): one `worker_threads` worker per Claude config dir.
 * The SDK reads `CLAUDE_CONFIG_DIR` from `process.env` on every history call, so profiles with
 * different config dirs need different environments – each worker gets the profile env as its own
 * `process.env`; the main process env is never changed (no race between parallel lookups).
 *
 * - Worker = eval'd source string (workerSource.ts) that imports the SDK from a file: URL
 *   (`sdkModuleUrl`, default: the installed sdk.mjs) – no second bundle entry (ADR-004).
 * - Replies are checked with zod; results stay raw (`unknown`) – history/parse.ts maps them.
 * - A request that takes longer than `timeoutMs` (30 s) rejects and the worker is replaced on the
 *   next request; after `idleMs` (60 s) without requests the worker ends; a dying worker rejects
 *   its pending requests. Idle workers are unref'd (they never keep the process alive).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { windowsPathKey } from '@shared/paths';
import type { LaunchSpec } from '../../claude/ports';
import { logger } from '../../lib/logger';
import { getEnvVar } from '../../lib/windows';
import { HISTORY_WORKER_SOURCE } from './workerSource';

const log = logger.child({ module: 'backend/history' });

export type HistoryOp =
  | { op: 'messages'; sessionId: string }
  | { op: 'subagents'; sessionId: string }
  | { op: 'subagentMessages'; sessionId: string; agentId: string }
  | { op: 'info'; sessionId: string }
  | { op: 'rename'; sessionId: string; title: string };

export interface HistoryPool {
  /** Raw SDK result (`getSessionInfo` → null when unknown, `renameSession` → null). */
  run(launch: LaunchSpec, op: HistoryOp): Promise<unknown>;
  /** Ends every worker; pending requests reject, later `run` calls reject. */
  dispose(): Promise<void>;
}

export interface HistoryPoolOptions {
  /** URL of the SDK module the worker imports (tests: a data: URL fake). */
  sdkModuleUrl?: string;
  idleMs?: number;
  timeoutMs?: number;
}

export const HISTORY_TIMEOUT_MS = 30_000;
export const HISTORY_IDLE_MS = 60_000;
/** Pool key of profiles without an own config dir (`~/.claude`). */
export const DEFAULT_CONFIG_DIR_KEY = '<default>';

/** file: URL of the installed SDK (`exports['.'].default` → sdk.mjs), also from dist/server.js. */
export function defaultSdkModuleUrl(): string {
  return pathToFileURL(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')).href;
}

/**
 * One worker per effective config dir, compared like Windows paths (case-insensitive, `/` = `\`).
 * The env value wins – it is what the worker's SDK reads; `configDir` is the fallback.
 */
export function historyWorkerKey(launch: LaunchSpec): string {
  const dir = getEnvVar(launch.env, 'CLAUDE_CONFIG_DIR') ?? launch.configDir;
  return dir === null || dir.trim() === '' ? DEFAULT_CONFIG_DIR_KEY : windowsPathKey(dir);
}

const replySchema = z.discriminatedUnion('ok', [
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.number().int(),
    ok: z.literal(false),
    error: z.object({ name: z.string(), message: z.string() }),
  }),
]);

interface Job {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface Slot {
  key: string;
  worker: Worker;
  jobs: Map<number, Job>;
  idleTimer: NodeJS.Timeout | null;
  retired: boolean;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function remoteError(error: { name: string; message: string }): Error {
  const err = new Error(error.message);
  err.name = error.name;
  return err;
}

export function createHistoryPool(
  opts: HistoryPoolOptions = {},
): HistoryPool & { /** Live workers (tests). */ readonly size: number } {
  const timeoutMs = opts.timeoutMs ?? HISTORY_TIMEOUT_MS;
  const idleMs = opts.idleMs ?? HISTORY_IDLE_MS;
  let sdkUrl = opts.sdkModuleUrl;
  const slots = new Map<string, Slot>();
  let nextId = 0;
  let disposed = false;

  /** Detaches a slot: rejects its jobs, forgets it. The caller terminates the worker if needed. */
  const retire = (slot: Slot, reason: Error): void => {
    if (slot.retired) return;
    slot.retired = true;
    if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    for (const job of slot.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(reason);
    }
    slot.jobs.clear();
    if (slots.get(slot.key) === slot) slots.delete(slot.key);
  };

  const stop = async (slot: Slot, reason: Error): Promise<void> => {
    retire(slot, reason);
    try {
      await slot.worker.terminate();
    } catch (error) {
      log.warn({ err: error }, 'terminating a history worker failed');
    }
  };

  const armIdle = (slot: Slot): void => {
    slot.worker.unref();
    if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
      void stop(slot, new Error('history worker ended after idling'));
    }, idleMs);
    slot.idleTimer.unref();
  };

  const onReply = (slot: Slot, raw: unknown): void => {
    const parsed = replySchema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues.length }, 'invalid history worker reply ignored');
      return;
    }
    const reply = parsed.data;
    const job = slot.jobs.get(reply.id);
    if (job === undefined) return;
    slot.jobs.delete(reply.id);
    clearTimeout(job.timer);
    if (reply.ok) job.resolve(reply.result);
    else job.reject(remoteError(reply.error));
    if (slot.jobs.size === 0 && !slot.retired) armIdle(slot);
  };

  const spawnSlot = (key: string, env: Record<string, string>): Slot => {
    sdkUrl ??= defaultSdkModuleUrl();
    const worker = new Worker(HISTORY_WORKER_SOURCE, {
      eval: true,
      env: { ...env },
      workerData: { sdkUrl },
      // No inherited loader/inspector flags of the parent (tsx, Vitest): the worker only imports sdk.mjs.
      execArgv: [],
    });
    const slot: Slot = { key, worker, jobs: new Map(), idleTimer: null, retired: false };
    worker.on('message', (raw: unknown) => {
      onReply(slot, raw);
    });
    worker.on('error', (error: unknown) => {
      log.warn({ err: error }, 'history worker failed');
      void stop(slot, new Error(`history worker failed: ${toError(error).message}`));
    });
    worker.on('exit', (code) => {
      retire(slot, new Error(`history worker exited (code ${code})`));
    });
    slots.set(key, slot);
    return slot;
  };

  return {
    get size() {
      return slots.size;
    },

    run(launch, op) {
      if (disposed) return Promise.reject(new Error('history pool disposed'));
      const key = historyWorkerKey(launch);
      let slot: Slot;
      try {
        slot = slots.get(key) ?? spawnSlot(key, launch.env);
      } catch (error) {
        return Promise.reject(toError(error));
      }
      nextId += 1;
      const id = nextId;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!slot.jobs.delete(id)) return;
          log.warn({ op: op.op, timeoutMs }, 'history request timed out; the worker is replaced');
          reject(new Error(`history ${op.op} timed out after ${timeoutMs} ms`));
          void stop(slot, new Error('history worker replaced after a timeout'));
        }, timeoutMs);
        slot.jobs.set(id, { resolve, reject, timer });
        if (slot.idleTimer !== null) {
          clearTimeout(slot.idleTimer);
          slot.idleTimer = null;
        }
        slot.worker.ref();
        try {
          slot.worker.postMessage({ id, op });
        } catch (error) {
          clearTimeout(timer);
          slot.jobs.delete(id);
          reject(toError(error));
          if (slot.jobs.size === 0 && !slot.retired) armIdle(slot);
        }
      });
    },

    async dispose() {
      disposed = true;
      await Promise.all([...slots.values()].map((slot) => stop(slot, new Error('history pool disposed'))));
    },
  };
}
