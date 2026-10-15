/**
 * In-memory `SessionPublisher` (WP-13 §3.6) for engine and WP-20 tests: records everything the
 * engine publishes and – by default – validates like the hub in test mode (WP-10 Punkt 4): every
 * op, summary, host state and notification must survive `parse` UNCHANGED (no `undefined` where
 * the schema has a default, no missing default, no extra key), otherwise it throws.
 */
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import type { ClientId, EntryId } from '@shared/common';
import { hostStateSchema, sessionSummarySchema, type HostState, type SessionSummary } from '@shared/model';
import { notifySchema, sessionOpSchema, type Notification, type SessionOp } from '@shared/protocol';
import { applySessionOp, type SessionViewState } from '@shared/sync';
import { realSetImmediate } from '../../lib/async';
import type { ClientPresence, SessionPublisher } from '../../sync/ports';

export interface MemoryPublisherOptions {
  /** Hub-like validation of everything published (default true). */
  validate?: boolean;
}

export interface PublishedOp {
  entryId: EntryId;
  op: SessionOp;
}

export interface MemoryPublisher extends SessionPublisher {
  /** Ops per entry in publish order. */
  readonly ops: ReadonlyMap<EntryId, readonly SessionOp[]>;
  /** All ops of all entries in publish order. */
  readonly allOps: readonly PublishedOp[];
  readonly summaries: readonly { summary: SessionSummary; urgent: boolean }[];
  readonly removedSummaries: readonly EntryId[];
  readonly hostStates: readonly HostState[];
  readonly notifications: readonly { clientId: ClientId; notification: Notification }[];
  readonly cleared: readonly EntryId[];
  readonly closedWith: readonly number[];
  opsOf(entryId: EntryId): SessionOp[];
  /** Last published summary of an entry (null if none or removed). */
  summaryOf(entryId: EntryId): SessionSummary | null;
  /** What presence() returns. */
  setPresence(list: readonly ClientPresence[]): void;
  /** Start state of `view(entryId)`; every op published afterwards is applied to it. */
  setViewBase(entryId: EntryId, base: SessionViewState): void;
  /** The base with all later ops applied (applySessionOp, like the hub); null without base. */
  view(entryId: EntryId): SessionViewState | null;
  /** Resolves once `predicate()` holds (checked after every publish and every macrotask). */
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
}

function check<T>(schema: z.ZodType<T>, value: T, what: string): void {
  const parsed = schema.safeParse(value);
  if (parsed.success && isDeepStrictEqual(parsed.data, value)) return;
  const detail = parsed.success
    ? 'value changes under parse (undefined instead of null, missing default or extra key)'
    : `${parsed.error.issues[0]?.path.map(String).join('.') ?? ''}: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
  throw new Error(`MemoryPublisher: invalid ${what} – ${detail}`);
}

export function createMemoryPublisher(options: MemoryPublisherOptions = {}): MemoryPublisher {
  const validate = options.validate ?? true;
  const ops = new Map<EntryId, SessionOp[]>();
  const allOps: PublishedOp[] = [];
  const summaries: { summary: SessionSummary; urgent: boolean }[] = [];
  const latest = new Map<EntryId, SessionSummary>();
  const removedSummaries: EntryId[] = [];
  const hostStates: HostState[] = [];
  const notifications: { clientId: ClientId; notification: Notification }[] = [];
  const cleared: EntryId[] = [];
  const closedWith: number[] = [];
  const views = new Map<EntryId, SessionViewState>();
  const listeners = new Set<() => void>();
  let presence: readonly ClientPresence[] = [];

  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    ops,
    allOps,
    summaries,
    removedSummaries,
    hostStates,
    notifications,
    cleared,
    closedWith,

    publishOps(entryId, published) {
      for (const op of published) {
        if (validate) check(sessionOpSchema, op, `op ${op.op} of ${entryId}`);
      }
      const list = ops.get(entryId) ?? [];
      for (const op of published) {
        list.push(op);
        allOps.push({ entryId, op });
        const view = views.get(entryId);
        if (view !== undefined) views.set(entryId, applySessionOp(view, op));
      }
      ops.set(entryId, list);
      changed();
    },

    publishSummary(summary, urgent) {
      if (validate) check(sessionSummarySchema, summary, `summary ${summary.entryId}`);
      summaries.push({ summary, urgent });
      latest.set(summary.entryId, summary);
      changed();
    },

    removeSummary(entryId) {
      removedSummaries.push(entryId);
      latest.delete(entryId);
      changed();
    },

    publishHostState(host) {
      if (validate) check(hostStateSchema, host, 'host state');
      hostStates.push(host);
      changed();
    },

    notify(clientId, notification) {
      if (validate) check(notifySchema, { type: 'notify', notification }, 'notification');
      notifications.push({ clientId, notification });
      changed();
    },

    clearNotification(entryId) {
      cleared.push(entryId);
      changed();
    },

    presence: () => presence,

    closeAll(code) {
      closedWith.push(code);
      changed();
    },

    opsOf: (entryId) => [...(ops.get(entryId) ?? [])],
    summaryOf: (entryId) => latest.get(entryId) ?? null,

    setPresence(list) {
      presence = [...list];
    },

    setViewBase(entryId, base) {
      views.set(entryId, base);
    },

    view: (entryId) => views.get(entryId) ?? null,

    waitFor(predicate, timeoutMs = 2000) {
      return new Promise<void>((resolve, reject) => {
        if (predicate()) {
          resolve();
          return;
        }
        // process.hrtime is not faked by Vitest's fake timers (Date and setTimeout are).
        const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
        let done = false;
        const finish = (error: Error | null): void => {
          if (done) return;
          done = true;
          listeners.delete(onChange);
          if (error === null) resolve();
          else reject(error);
        };
        const onChange = (): void => {
          if (predicate()) finish(null);
        };
        const poll = (): void => {
          if (done) return;
          if (predicate()) finish(null);
          else if (process.hrtime.bigint() > deadline)
            finish(new Error(`MemoryPublisher.waitFor: timeout after ${String(timeoutMs)} ms`));
          else realSetImmediate(poll);
        };
        listeners.add(onChange);
        realSetImmediate(poll);
      });
    },
  };
}
