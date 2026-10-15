/**
 * Server start (WP-13 §3.5.13; A.10, R0-17, B "Windows-Prozesse", C.8): status facts from the
 * registry, tool calls of an interrupted turn, orphans of a hard abort. Pure helpers plus the
 * orphan cleanup (process lookups injected).
 */
import type { Entry, ToolCallItem, TranscriptItem } from '@shared/model';
import { INITIAL_STATUS_FACTS, type StatusFacts } from '@shared/status';
import type { ProcessFilter, ProcessInfo, ProcessQueryResult } from '../lib/process';
import type { ProcessRecord } from './processStore';

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
 * - `killed`: the recorded claude.exe still ran (same image + start time) – its tree was ended;
 * - `gone`: the PID is dead (or no longer exists in the query);
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

/** Dead records need no query (R2-02 pre-filter); the rest goes into one bundled check. */
export function splitOrphanRecords(
  records: readonly ProcessRecord[],
  isProcessAlive: (pid: number) => boolean,
): { alive: ProcessRecord[]; dead: ProcessRecord[] } {
  const alive: ProcessRecord[] = [];
  const dead: ProcessRecord[] = [];
  for (const record of records) (isProcessAlive(record.pid) ? alive : dead).push(record);
  return { alive, dead };
}

async function checkRecord(
  record: ProcessRecord,
  info: ProcessInfo | undefined,
  deps: OrphanDeps,
): Promise<OrphanResult> {
  if (info === undefined) return 'gone';
  const sameStart =
    Math.abs(info.startedAt.getTime() - Date.parse(record.startedAt)) <= ORPHAN_START_TOLERANCE_MS;
  if (!sameImage(info.name, record.image) || !sameStart) return 'not_ours';
  deps.log.warn({ entryId: record.entryId, pid: record.pid }, 'ending orphaned claude process tree');
  try {
    await deps.killProcessTree(record.pid);
    return 'killed';
  } catch (error) {
    deps.log.error({ err: error, entryId: record.entryId, pid: record.pid }, 'ending an orphan failed');
    return 'failed';
  }
}

/**
 * Records of processes.json whose PID is alive (C.8): ONE query for all of them; a process that
 * still runs with the recorded image name and start time (± 5 s) → `taskkill /T /F` of its tree.
 * A PID reused by another program is never touched (`not_ours`). A failed/slow query is `unknown`
 * – nothing is killed, the records stay for the next start (R2-02).
 *
 * R2-03: only the verified claude.exe ROOT is ended. Children of a DEAD claude.exe are not
 * searched any more – without an upper bound for "the old server still lived" a reused PID could
 * hit foreign processes (follow-up after WP-22: heartbeat `aliveAt` in processes.json).
 * Resolves per record (same order as `records`); never rejects.
 */
export function cleanupOrphans(records: readonly ProcessRecord[], deps: OrphanDeps): Promise<OrphanResult>[] {
  if (records.length === 0) return [];
  const query = deps
    .queryProcesses({ pids: records.map((r) => r.pid) })
    .catch((error: unknown): ProcessQueryResult => ({
      kind: 'unknown',
      reason: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }));
  return records.map(async (record) => {
    const result = await query;
    if (result.kind === 'unknown') {
      deps.log.warn(
        { entryId: record.entryId, pid: record.pid, reason: result.reason, detail: result.detail },
        'orphan check inconclusive – process left alone, record kept for the next start',
      );
      return 'unknown';
    }
    return checkRecord(
      record,
      result.processes.find((p) => p.pid === record.pid),
      deps,
    );
  });
}
