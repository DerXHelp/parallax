/**
 * Server start (WP-13 §3.5.13; A.10, R0-17, B "Windows-Prozesse", C.8): status facts from the
 * registry, tool calls of an interrupted turn, orphans of a hard abort. Pure helpers plus the
 * orphan cleanup (process lookups injected).
 */
import type { Entry, ToolCallItem, TranscriptItem } from '@shared/model';
import { INITIAL_STATUS_FACTS, type StatusFacts } from '@shared/status';
import type { ProcessFilter, ProcessInfo, ProcessQueryResult } from '../lib/process';
import type { ProcessChild, ProcessRecord } from './processStore';

/** Facts before `server_restart` (R0-17: runState, unread and errorCode from the registry). */
export function registryFacts(entry: Entry): StatusFacts {
  return {
    ...INITIAL_STATUS_FACTS,
    decisions: { ...INITIAL_STATUS_FACTS.decisions },
    runState: entry.lastRunState,
    unread: entry.unread,
    errorCode: entry.lastRunState === 'error' ? (entry.lastError?.code ?? 'CLAUDE_PROCESS_CRASHED') : null,
  };
}

/** The previous server ended while this entry worked (its open tool calls were cut off). */
export function wasActive(entry: Entry): boolean {
  return entry.lastRunState === 'starting' || entry.lastRunState === 'working';
}

const OPEN_TOOL_STATUSES: ReadonlySet<ToolCallItem['status']> = new Set([
  'pending',
  'awaiting_decision',
  'running',
  'background',
]);

/**
 * The persisted counterpart of `finalizeOpen('process_exit')`: open tool calls → `interrupted`,
 * an open decision ref → outcome `expired`. Returns only changed items (copies).
 */
export function interruptedToolCalls(items: readonly TranscriptItem[]): ToolCallItem[] {
  const out: ToolCallItem[] = [];
  for (const item of items) {
    if (item.kind !== 'tool_call' || !OPEN_TOOL_STATUSES.has(item.status)) continue;
    out.push({
      ...item,
      status: 'interrupted',
      decision:
        item.decision !== null && item.decision.outcome === null
          ? { ...item.decision, outcome: { type: 'expired' } }
          : item.decision,
    });
  }
  return out;
}

/** |process start − recorded start| allowed for the identity check (the spawn time is taken in-process). */
export const ORPHAN_START_TOLERANCE_MS = 5_000;

export interface OrphanDeps {
  /** Instant pre-filter (lib/process.ts): a dead PID needs no PowerShell at all. */
  isProcessAlive(pid: number): boolean;
  /** ONE bundled CIM query for all live PIDs (lib/process.ts `queryProcesses`, 60-s timeout). */
  queryProcesses(filter: ProcessFilter): Promise<ProcessQueryResult>;
  killProcessTree(pid: number): Promise<void>;
  log: {
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

/**
 * - `killed`: the recorded claude.exe still ran (same image + start time) and/or processes of its
 *   last snapshot still ran exactly as recorded (WP22-06) – their trees were ended;
 * - `gone`: the PID is dead (or no longer exists in the query), nothing of the snapshot runs;
 * - `not_ours`: the PID belongs to another process now (PID reuse) – untouched;
 * - `unknown`: the query failed or timed out – untouched, the record is KEPT (R2-02);
 * - `failed`: taskkill failed – the process may still run, the record is KEPT.
 */
export type OrphanResult = 'killed' | 'gone' | 'not_ours' | 'unknown' | 'failed';

/** Results that keep the record in processes.json for the next server start. */
export function keepsOrphanRecord(result: OrphanResult): boolean {
  return result === 'unknown' || result === 'failed';
}

function sameImage(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The PIDs of a record that the liveness pre-filter still sees (the root and its snapshot). */
function livePids(record: ProcessRecord, isProcessAlive: (pid: number) => boolean): number[] {
  return [record.pid, ...record.children.map((c) => c.pid)].filter((pid) => isProcessAlive(pid));
}

/**
 * Dead records need no query (R2-02 pre-filter): neither the claude.exe nor any process of its
 * last snapshot (WP22-06) is alive. The rest goes into one bundled check.
 */
export function splitOrphanRecords(
  records: readonly ProcessRecord[],
  isProcessAlive: (pid: number) => boolean,
): { alive: ProcessRecord[]; dead: ProcessRecord[] } {
  const alive: ProcessRecord[] = [];
  const dead: ProcessRecord[] = [];
  for (const record of records) (livePids(record, isProcessAlive).length > 0 ? alive : dead).push(record);
  return { alive, dead };
}

/** Exactly the process of the snapshot: same PID (looked up), image (case-insensitive) and start time. */
function matchesExactly(info: ProcessInfo, child: ProcessChild): boolean {
  return sameImage(info.name, child.image) && info.startedAt.getTime() === Date.parse(child.startedAt);
}

async function kill(
  deps: OrphanDeps,
  pid: number,
  context: Record<string, unknown>,
  what: string,
): Promise<'killed' | 'failed'> {
  deps.log.warn({ ...context, pid }, `ending orphaned ${what}`);
  try {
    await deps.killProcessTree(pid);
    return 'killed';
  } catch (error) {
    deps.log.error({ err: error, ...context, pid }, `ending an orphaned ${what} failed`);
    return 'failed';
  }
}

async function checkRecord(
  record: ProcessRecord,
  processes: ReadonlyMap<number, ProcessInfo>,
  deps: OrphanDeps,
): Promise<OrphanResult> {
  const context = { entryId: record.entryId, rootPid: record.pid };
  const outcomes: ('killed' | 'failed')[] = [];
  // 1. The claude.exe root: same image and start time (± 5 s, the spawn time is taken in-process).
  const root = processes.get(record.pid);
  let rootResult: 'gone' | 'not_ours' = 'gone';
  if (root !== undefined) {
    const sameStart =
      Math.abs(root.startedAt.getTime() - Date.parse(record.startedAt)) <= ORPHAN_START_TOLERANCE_MS;
    if (sameImage(root.name, record.image) && sameStart) {
      outcomes.push(await kill(deps, record.pid, context, 'claude process tree'));
    } else {
      rootResult = 'not_ours';
    }
  }
  // 2. WP22-06: every process of the last snapshot that still runs EXACTLY as recorded (PID,
  //    image, start time) – e.g. a tool shell whose claude.exe ended itself after the abort. A
  //    process the snapshot did not see (started after `aliveAt`) is never touched.
  for (const child of record.children) {
    const info = processes.get(child.pid);
    if (info === undefined || !matchesExactly(info, child)) continue;
    outcomes.push(await kill(deps, child.pid, { ...context, image: child.image }, 'child process tree'));
  }
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('killed')) return 'killed';
  return rootResult;
}

/**
 * Records of processes.json with a live PID (C.8): ONE query for all of them; ended with
 * `taskkill /T /F` (the whole tree) are
 *  - the claude.exe itself when it still runs with the recorded image and start time (± 5 s);
 *  - WP22-06 (R2-03 follow-up): every process of the record's last heartbeat snapshot that still
 *    runs with exactly the recorded PID, image and start time. A PID reused by another program
 *    never matches (its start time differs) and stays untouched (`not_ours`); processes started
 *    after the last snapshot are unknown and stay too.
 * A failed/slow query is `unknown` – nothing is killed, the records stay for the next start
 * (R2-02). Resolves per record (same order as `records`); never rejects.
 */
export function cleanupOrphans(records: readonly ProcessRecord[], deps: OrphanDeps): Promise<OrphanResult>[] {
  if (records.length === 0) return [];
  const pids = [...new Set(records.flatMap((r) => livePids(r, (pid) => deps.isProcessAlive(pid))))];
  const query = deps
    .queryProcesses({ pids: pids.length > 0 ? pids : records.map((r) => r.pid) })
    .catch((error: unknown): ProcessQueryResult => ({
      kind: 'unknown',
      reason: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }));
  // Records one after the other: a root's `taskkill /T` may already end processes of a later one.
  let previous: Promise<unknown> = Promise.resolve();
  return records.map((record) => {
    const before = previous;
    const done = (async (): Promise<OrphanResult> => {
      const result = await query;
      await before.catch(() => undefined);
      if (result.kind === 'unknown') {
        deps.log.warn(
          { entryId: record.entryId, pid: record.pid, reason: result.reason, detail: result.detail },
          'orphan check inconclusive – process left alone, record kept for the next start',
        );
        return 'unknown';
      }
      return checkRecord(record, new Map(result.processes.map((p) => [p.pid, p])), deps);
    })();
    previous = done;
    return done;
  });
}
