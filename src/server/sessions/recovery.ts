/**
 * Server start (WP-13 §3.5.13; A.10, R0-17, B "Windows-Prozesse", C.8): status facts from the
 * registry, tool calls of an interrupted turn, orphans of a hard abort. Pure helpers plus the
 * orphan cleanup (process lookups injected).
 */
import type { Entry, ToolCallItem, TranscriptItem } from '@shared/model';
import { INITIAL_STATUS_FACTS, type StatusFacts } from '@shared/status';
import type { ProcessInfo } from '../lib/process';
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
  processInfo(pid: number): Promise<ProcessInfo | null>;
  killProcessTree(pid: number): Promise<void>;
  /** Direct children of a pid (lib/process.ts `childProcesses`); optional. */
  childProcesses?: (pid: number) => Promise<ProcessInfo[]>;
  /** Start of this server: a child started later cannot belong to the old claude.exe. */
  serverStartedAt: Date;
  log: {
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

export type OrphanResult = 'killed' | 'gone' | 'not_ours' | 'children_killed' | 'failed';

function sameImage(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * One record of processes.json (C.8): the process still runs with the recorded image name and
 * start time (± 5 s) → `taskkill /T /F` of its tree. If it is gone, direct children that started
 * after it and before this server (a child is never older than its parent) are ended – the
 * remains of a hard abort (§6 Nr. 7). A PID reused by another program is never touched.
 */
export async function cleanupOrphan(record: ProcessRecord, deps: OrphanDeps): Promise<OrphanResult> {
  const recordedAt = Date.parse(record.startedAt);
  try {
    const info = await deps.processInfo(record.pid);
    if (info !== null) {
      const sameStart = Math.abs(info.startedAt.getTime() - recordedAt) <= ORPHAN_START_TOLERANCE_MS;
      if (!sameImage(info.name, record.image) || !sameStart) return 'not_ours';
      deps.log.warn({ entryId: record.entryId, pid: record.pid }, 'ending orphaned claude process tree');
      await deps.killProcessTree(record.pid);
      return 'killed';
    }
    if (deps.childProcesses === undefined) return 'gone';
    const children = (await deps.childProcesses(record.pid)).filter((child) => {
      const at = child.startedAt.getTime();
      return at >= recordedAt - ORPHAN_START_TOLERANCE_MS && at <= deps.serverStartedAt.getTime();
    });
    if (children.length === 0) return 'gone';
    for (const child of children) {
      deps.log.warn(
        { entryId: record.entryId, pid: child.pid, name: child.name, parentPid: record.pid },
        'ending orphaned child of a dead claude process',
      );
      await deps.killProcessTree(child.pid);
    }
    return 'children_killed';
  } catch (error) {
    deps.log.error({ err: error, entryId: record.entryId, pid: record.pid }, 'orphan cleanup failed');
    return 'failed';
  }
}
