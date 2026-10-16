/**
 * Server start (WP-13 §3.5.13; A.10, R0-17, B "Windows-Prozesse", C.8): status facts from the
 * registry, tool calls of an interrupted turn, orphans of a hard abort. Pure helpers plus the
 * orphan cleanup (process lookups injected).
 */
import type { Entry, ToolCallItem, TranscriptItem } from '@shared/model';
import { INITIAL_STATUS_FACTS, type StatusFacts } from '@shared/status';
import type { ProcessFilter, ProcessInfo, ProcessLookup, ProcessQueryResult } from '../lib/process';
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

/** The recorded claude.exe: same image and start time (± 5 s, the spawn time is taken in-process). */
function isRecordedRoot(info: ProcessInfo, record: ProcessRecord): boolean {
  const sameStart =
    Math.abs(info.startedAt.getTime() - Date.parse(record.startedAt)) <= ORPHAN_START_TOLERANCE_MS;
  return sameImage(info.name, record.image) && sameStart;
}

function safeQuery(deps: OrphanDeps, filter: ProcessFilter): Promise<ProcessQueryResult> {
  return deps.queryProcesses(filter).catch((error: unknown): ProcessQueryResult => ({
    kind: 'unknown',
    reason: 'failed',
    detail: error instanceof Error ? error.message : String(error),
  }));
}

/**
 * CR-01: what the last query said about the processes of the records – STALE as soon as anything
 * was killed (a `taskkill /T` frees PIDs that Windows may hand out again at once). So every kill is
 * preceded by a fresh look at exactly that PID: dead now → skipped without PowerShell; alive and
 * nothing killed since the last answer that covered it → that answer; otherwise ONE new bundled
 * query (the PID plus every PID not looked up yet that is still alive).
 */
class ProcessView {
  private answer: Promise<ProcessQueryResult>;
  private covered: ReadonlySet<number>;
  private fresh = true;
  /** PIDs of the records not looked up yet (bundled into the next query). */
  private readonly pending: Set<number>;

  constructor(
    private readonly deps: OrphanDeps,
    allPids: readonly number[],
    queried: readonly number[],
  ) {
    this.pending = new Set(allPids);
    this.covered = new Set(queried);
    this.answer = safeQuery(deps, { pids: queried });
  }

  /** The identity of `pid` right now (three-valued like `processInfo`). */
  async lookup(pid: number): Promise<ProcessLookup> {
    this.pending.delete(pid);
    if (!this.fresh || !this.covered.has(pid)) {
      if (!this.deps.isProcessAlive(pid)) return { kind: 'missing' };
      const pids = [pid, ...[...this.pending].filter((p) => this.deps.isProcessAlive(p))];
      this.answer = safeQuery(this.deps, { pids });
      this.covered = new Set(pids);
      this.fresh = true;
    }
    const result = await this.answer;
    if (result.kind === 'unknown') return result;
    const info = result.processes.find((p) => p.pid === pid);
    return info === undefined ? { kind: 'missing' } : { kind: 'found', info };
  }

  /** A taskkill ran (also a failed one may have ended processes): every answer so far is stale. */
  invalidate(): void {
    this.fresh = false;
  }
}

async function kill(
  deps: OrphanDeps,
  view: ProcessView,
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
  } finally {
    view.invalidate();
  }
}

async function checkRecord(
  record: ProcessRecord,
  view: ProcessView,
  deps: OrphanDeps,
): Promise<OrphanResult> {
  const context = { entryId: record.entryId, rootPid: record.pid };
  const inconclusive = (pid: number, lookup: Extract<ProcessLookup, { kind: 'unknown' }>): void => {
    deps.log.warn(
      { entryId: record.entryId, pid, reason: lookup.reason, detail: lookup.detail },
      'orphan check inconclusive – process left alone, record kept for the next start',
    );
  };
  const outcomes: ('killed' | 'failed')[] = [];
  // 1. The claude.exe root: same image and start time (± 5 s).
  const root = await view.lookup(record.pid);
  if (root.kind === 'unknown') {
    inconclusive(record.pid, root);
    return 'unknown';
  }
  let rootResult: 'gone' | 'not_ours' = 'gone';
  if (root.kind === 'found') {
    if (isRecordedRoot(root.info, record)) {
      const outcome = await kill(deps, view, record.pid, context, 'claude process tree');
      // CR-01: its `taskkill /T` ended the whole tree below it – the snapshot is not ended again
      // (its PIDs may already belong to new processes).
      if (outcome === 'killed') return 'killed';
      outcomes.push(outcome);
    } else {
      rootResult = 'not_ours';
    }
  }
  // 2. WP22-06: every process of the last snapshot that still runs EXACTLY as recorded (PID,
  //    image, start time) – e.g. a tool shell whose claude.exe ended itself after the abort. A
  //    process the snapshot did not see (started after `aliveAt`) is never touched. CR-01: each one
  //    is looked up again right before its kill (an earlier kill may have ended it, its PID reused).
  for (const child of record.children) {
    const lookup = await view.lookup(child.pid);
    if (lookup.kind === 'unknown') {
      inconclusive(child.pid, lookup);
      return outcomes.includes('failed') ? 'failed' : 'unknown';
    }
    if (lookup.kind !== 'found' || !matchesExactly(lookup.info, child)) continue;
    outcomes.push(
      await kill(deps, view, child.pid, { ...context, image: child.image }, 'child process tree'),
    );
  }
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('killed')) return 'killed';
  return rootResult;
}

/**
 * Records of processes.json with a live PID (C.8): ONE query for all of them; ended with
 * `taskkill /T /F` (the whole tree) are
 *  - the claude.exe itself when it still runs with the recorded image and start time (± 5 s) –
 *    then nothing else of the record (CR-01: its tree is gone with it);
 *  - otherwise (WP22-06, R2-03 follow-up) every process of the record's last heartbeat snapshot that
 *    still runs with exactly the recorded PID, image and start time. A PID reused by another
 *    program never matches (its start time differs) and stays untouched (`not_ours`); processes
 *    started after the last snapshot are unknown and stay too.
 * CR-01: every single kill follows a fresh look at that PID (after any kill, a new query). A
 * failed/slow query is `unknown` – nothing more is killed, the record stays for the next start
 * (R2-02). Resolves per record (same order as `records`); never rejects.
 */
export function cleanupOrphans(records: readonly ProcessRecord[], deps: OrphanDeps): Promise<OrphanResult>[] {
  if (records.length === 0) return [];
  const pids = [...new Set(records.flatMap((r) => livePids(r, (pid) => deps.isProcessAlive(pid))))];
  const all = [...new Set(records.flatMap((r) => [r.pid, ...r.children.map((c) => c.pid)]))];
  const view = new ProcessView(deps, all, pids.length > 0 ? pids : records.map((r) => r.pid));
  // Records one after the other: a root's `taskkill /T` may already end processes of a later one.
  let previous: Promise<unknown> = Promise.resolve();
  return records.map((record) => {
    const before = previous;
    const done = (async (): Promise<OrphanResult> => {
      await before.catch(() => undefined);
      return checkRecord(record, view, deps);
    })();
    previous = done;
    return done;
  });
}
