import { describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { toolCallItemSchema } from '@shared/model';
import { SAMPLE_TIME, sampleEntry, sampleId, sampleItems } from '@shared/samples';
import type { ProcessFilter, ProcessInfo, ProcessQueryResult } from '../lib/process';
import type { ProcessRecord } from './processStore';
import {
  cleanupOrphans,
  interruptedToolCalls,
  keepsOrphanRecord,
  registryFacts,
  splitOrphanRecords,
  wasActive,
  type OrphanDeps,
  type OrphanResult,
} from './recovery';

describe('registryFacts (R0-17)', () => {
  it('runState, unread and the errorCode of an error entry come from the registry', () => {
    expect(registryFacts(sampleEntry({ lastRunState: 'idle', unread: true }))).toMatchObject({
      runState: 'idle',
      unread: true,
      errorCode: null,
    });
    expect(
      registryFacts(
        sampleEntry({
          lastRunState: 'error',
          lastError: { ...makeError('CLAUDE_AUTH_FAILED'), at: SAMPLE_TIME },
        }),
      ).errorCode,
    ).toBe('CLAUDE_AUTH_FAILED');
    expect(registryFacts(sampleEntry({ lastRunState: 'error', lastError: null })).errorCode).toBe(
      'CLAUDE_PROCESS_CRASHED',
    );
    expect(wasActive(sampleEntry({ lastRunState: 'starting' }))).toBe(true);
    expect(wasActive(sampleEntry({ lastRunState: 'working' }))).toBe(true);
    expect(wasActive(sampleEntry({ lastRunState: 'idle' }))).toBe(false);
  });
});

describe('interruptedToolCalls', () => {
  it('open tool calls → interrupted (open decision ref → expired); finished ones untouched', () => {
    const ref = {
      decisionId: sampleId('dc', 1),
      kind: 'permission' as const,
      planVersion: null,
      outcome: null,
    };
    const items = [
      sampleItems.toolCall({ id: 'a', toolUseId: 'a', status: 'awaiting_decision', decision: ref }),
      sampleItems.toolCall({ id: 'b', toolUseId: 'b', status: 'running' }),
      sampleItems.toolCall({ id: 'c', toolUseId: 'c', status: 'background' }),
      sampleItems.toolCall({ id: 'd', toolUseId: 'd', status: 'pending' }),
      sampleItems.toolCall({ id: 'e', toolUseId: 'e', status: 'done' }),
      sampleItems.toolCall({
        id: 'f',
        toolUseId: 'f',
        status: 'running',
        decision: { ...ref, outcome: { type: 'allowed', remember: null, acceptEdits: false } },
      }),
      sampleItems.userMessage(),
    ];
    const fixed = interruptedToolCalls(items);
    expect(fixed.map((i) => [i.id, i.status, i.decision?.outcome ?? null])).toEqual([
      ['a', 'interrupted', { type: 'expired' }],
      ['b', 'interrupted', null],
      ['c', 'interrupted', null],
      ['d', 'interrupted', null],
      ['f', 'interrupted', { type: 'allowed', remember: null, acceptEdits: false }],
    ]);
    for (const item of fixed) expect(toolCallItemSchema.parse(item)).toEqual(item);
  });
});

describe('cleanupOrphans (C.8, R2-02, R2-03)', () => {
  const record = (pid = 4242, n = 1): ProcessRecord => ({
    entryId: sampleId('en', n),
    pid,
    image: 'claude.exe',
    startedAt: SAMPLE_TIME,
    aliveAt: null,
    children: [],
  });
  const at = (s: number) => new Date(Date.parse(SAMPLE_TIME) + s * 1000);
  const info = (p: Partial<ProcessInfo>): ProcessInfo => ({
    pid: 4242,
    name: 'claude.exe',
    parentPid: 1,
    startedAt: at(0),
    ...p,
  });
  const ok = (...processes: ProcessInfo[]): ProcessQueryResult => ({ kind: 'ok', processes });

  function deps(p: Partial<OrphanDeps> = {}) {
    const killProcessTree = vi.fn((_pid: number) => Promise.resolve());
    const queryProcesses = vi.fn((_filter: ProcessFilter) => Promise.resolve(ok()));
    const log = { warn: vi.fn(), error: vi.fn() };
    const d: OrphanDeps = { isProcessAlive: () => true, queryProcesses, killProcessTree, log, ...p };
    return { d, killProcessTree, queryProcesses, log };
  }

  it.each<[string, ProcessInfo | null, OrphanResult, number[]]>([
    [
      'same image (case-insensitive) and start ± 5 s → killed',
      info({ name: 'Claude.EXE', startedAt: at(4.9) }),
      'killed',
      [4242],
    ],
    ['start 6 s off → PID reused → untouched', info({ startedAt: at(6) }), 'not_ours', []],
    ['other image → untouched', info({ name: 'chrome.exe' }), 'not_ours', []],
    ['not in the answer → gone', null, 'gone', []],
  ])('%s', async (_name, found, result, killed) => {
    const { d, killProcessTree } = deps({
      queryProcesses: () => Promise.resolve(found === null ? ok() : ok(found)),
    });
    expect(await Promise.all(cleanupOrphans([record()], d))).toEqual([result]);
    expect(killProcessTree.mock.calls.map((c) => c[0])).toEqual(killed);
  });

  it('ONE query for all records; after a kill one fresh query for the rest (R2-03, CR-01)', async () => {
    const { d, queryProcesses, killProcessTree } = deps();
    queryProcesses.mockResolvedValue(
      ok(info({ pid: 2 }), info({ pid: 3, name: 'x.exe' }), info({ pid: 4, name: 'y.exe' })),
    );
    const results = await Promise.all(
      cleanupOrphans([record(1), record(2, 2), record(3, 3), record(4, 4)], d),
    );
    expect(results).toEqual(['gone', 'killed', 'not_ours', 'not_ours']);
    // The kill of 2 makes the first answer stale: 3 and 4 are looked up again – in ONE query.
    expect(queryProcesses.mock.calls).toEqual([[{ pids: [1, 2, 3, 4] }], [{ pids: [3, 4] }]]);
    expect(killProcessTree.mock.calls.map((c) => c[0])).toEqual([2]);
    expect(cleanupOrphans([], d)).toEqual([]);
  });

  it('CR-01: a later root whose PID was reused after an earlier kill is not ended', async () => {
    const queryProcesses = vi
      .fn((_filter: ProcessFilter) => Promise.resolve(ok()))
      .mockResolvedValueOnce(ok(info({ pid: 1 }), info({ pid: 2 })))
      // After the taskkill of 1: PID 2 belongs to a new process now (another start time).
      .mockResolvedValueOnce(ok(info({ pid: 2, startedAt: at(90) })));
    const { d, killProcessTree } = deps({ queryProcesses });
    expect(await Promise.all(cleanupOrphans([record(1), record(2, 2)], d))).toEqual(['killed', 'not_ours']);
    expect(killProcessTree.mock.calls.map((c) => c[0])).toEqual([1]);
    expect(queryProcesses.mock.calls).toEqual([[{ pids: [1, 2] }], [{ pids: [2] }]]);
  });

  it.each<[string, () => Promise<ProcessQueryResult>]>([
    ['a timeout', () => Promise.resolve({ kind: 'unknown', reason: 'timeout', detail: 'no answer' })],
    ['a policy/CIM failure', () => Promise.resolve({ kind: 'unknown', reason: 'failed', detail: 'exit 1' })],
    ['a rejected query', () => Promise.reject(new Error('powershell missing'))],
  ])('%s is unknown: nothing killed, warned, the record is kept (R2-02)', async (_name, query) => {
    const { d, killProcessTree, log } = deps({ queryProcesses: query });
    const [result] = await Promise.all(cleanupOrphans([record()], d));
    expect(result).toBe('unknown');
    expect(keepsOrphanRecord('unknown')).toBe(true);
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 4242 }),
      expect.stringContaining('record kept'),
    );
  });

  it('a failing taskkill is failed (logged, record kept), never thrown', async () => {
    const { d, log } = deps({
      queryProcesses: () => Promise.resolve(ok(info({}))),
      killProcessTree: () => Promise.reject(new Error('access denied')),
    });
    expect(await Promise.all(cleanupOrphans([record()], d))).toEqual(['failed']);
    expect(log.error).toHaveBeenCalled();
    expect(keepsOrphanRecord('failed')).toBe(true);
    const removed: OrphanResult[] = ['killed', 'gone', 'not_ours'];
    expect(removed.map((r) => keepsOrphanRecord(r))).toEqual([false, false, false]);
  });

  describe('WP22-06: processes of the last heartbeat snapshot', () => {
    const shell = { pid: 5001, image: 'powershell.exe', startedAt: '2026-10-15T12:00:05.123Z' };
    const ping = { pid: 5002, image: 'PING.EXE', startedAt: '2026-10-15T12:00:05.456Z' };
    const withChildren = (): ProcessRecord => ({
      ...record(),
      aliveAt: '2026-10-15T12:00:30.000Z',
      children: [shell, ping],
    });
    const live = (child: typeof shell, p: Partial<ProcessInfo> = {}): ProcessInfo => ({
      pid: child.pid,
      name: child.image,
      parentPid: 1,
      startedAt: new Date(child.startedAt),
      ...p,
    });

    it('claude.exe ended itself (gone), its tool shell + ping still run exactly as recorded → both ended', async () => {
      const queryProcesses = vi.fn((_filter: ProcessFilter) => Promise.resolve(ok(live(shell), live(ping))));
      const { d, killProcessTree } = deps({ isProcessAlive: (pid) => pid !== 4242, queryProcesses });
      expect(await Promise.all(cleanupOrphans([withChildren()], d))).toEqual(['killed']);
      expect(killProcessTree.mock.calls.map((c) => c[0])).toEqual([5001, 5002]);
      // CR-01: ping is looked up again after the kill of the shell (still alive here).
      expect(queryProcesses.mock.calls).toEqual([[{ pids: [5001, 5002] }], [{ pids: [5002] }]]);
    });

    it('CR-01: a child ended by an earlier taskkill /T is not killed again (no PowerShell either)', async () => {
      const alive = new Set([5001, 5002]);
      const queryProcesses = vi.fn((_filter: ProcessFilter) => Promise.resolve(ok(live(shell), live(ping))));
      // The shell's tree contains ping: both end with the first taskkill /T.
      const killProcessTree = vi.fn((pid: number) => {
        if (pid === 5001) alive.clear();
        return Promise.resolve();
      });
      const { d } = deps({ isProcessAlive: (pid) => alive.has(pid), queryProcesses, killProcessTree });
      expect(await Promise.all(cleanupOrphans([withChildren()], d))).toEqual(['killed']);
      expect(killProcessTree.mock.calls.map((c) => c[0])).toEqual([5001]);
      expect(queryProcesses.mock.calls).toEqual([[{ pids: [5001, 5002] }]]);
    });

    it('CR-01: a child PID reused right after an earlier kill (fresh check: other start) is untouched', async () => {
      const queryProcesses = vi
        .fn((_filter: ProcessFilter) => Promise.resolve(ok()))
        .mockResolvedValueOnce(ok(live(shell), live(ping)))
        .mockResolvedValueOnce(
          ok(live(ping, { name: 'notepad.exe', startedAt: new Date('2026-10-15T12:01:00.000Z') })),
        );
      const { d, killProcessTree } = deps({ isProcessAlive: (pid) => pid !== 4242, queryProcesses });
      expect(await Promise.all(cleanupOrphans([withChildren()], d))).toEqual(['killed']);
      expect(killProcessTree.mock.calls.map((c) => c[0])).toEqual([5001]);
    });

    it('CR-01: an unknown fresh check ends nothing more and keeps the record', async () => {
      const queryProcesses = vi
        .fn((_filter: ProcessFilter): Promise<ProcessQueryResult> => Promise.resolve(ok()))
        .mockResolvedValueOnce(ok(live(shell), live(ping)))
        .mockResolvedValueOnce({ kind: 'unknown', reason: 'timeout', detail: 'slow' });
      const { d, killProcessTree, log } = deps({ isProcessAlive: (pid) => pid !== 4242, queryProcesses });
      const [result] = await Promise.all(cleanupOrphans([withChildren()], d));
      expect(result).toBe('unknown');
      expect(keepsOrphanRecord('unknown')).toBe(true);
      expect(killProcessTree.mock.calls.map((c) => c[0])).toEqual([5001]);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 5002 }),
        expect.stringContaining('record kept'),
      );
    });

    it.each<[string, ProcessInfo]>([
      ['another start time (PID reused)', live(shell, { startedAt: new Date('2026-10-15T12:00:05.124Z') })],
      ['another image', live(shell, { name: 'notepad.exe' })],
    ])('a snapshot PID with %s is never touched', async (_name, found) => {
      const { d, killProcessTree } = deps({
        isProcessAlive: (pid) => pid === 5001,
        queryProcesses: () => Promise.resolve(ok(found)),
      });
      expect(await Promise.all(cleanupOrphans([withChildren()], d))).toEqual(['gone']);
      expect(killProcessTree).not.toHaveBeenCalled();
    });

    it('CR-01: the root still runs – its taskkill /T ends the tree, the snapshot is not ended again', async () => {
      // The answer from BEFORE the root kill still lists ping; its PID may be reused by now.
      const queryProcesses = vi.fn((_filter: ProcessFilter) => Promise.resolve(ok(info({}), live(ping))));
      const { d, killProcessTree } = deps({ queryProcesses });
      expect(await Promise.all(cleanupOrphans([withChildren()], d))).toEqual(['killed']);
      expect(killProcessTree.mock.calls.map((c) => c[0])).toEqual([4242]);
      expect(queryProcesses).toHaveBeenCalledTimes(1);
    });

    it('an unknown answer ends nothing and keeps the record', async () => {
      const { d, killProcessTree } = deps({
        isProcessAlive: (pid) => pid !== 4242,
        queryProcesses: () => Promise.resolve({ kind: 'unknown', reason: 'timeout', detail: 'slow' }),
      });
      expect(await Promise.all(cleanupOrphans([withChildren()], d))).toEqual(['unknown']);
      expect(killProcessTree).not.toHaveBeenCalled();
    });

    it('a failing taskkill of a child keeps the record (failed)', async () => {
      const { d } = deps({
        isProcessAlive: (pid) => pid !== 4242,
        queryProcesses: () => Promise.resolve(ok(live(shell))),
        killProcessTree: () => Promise.reject(new Error('access denied')),
      });
      expect(await Promise.all(cleanupOrphans([withChildren()], d))).toEqual(['failed']);
    });

    it('splitOrphanRecords: a dead root with a live snapshot process still needs the query', () => {
      const records = [withChildren(), record(7, 7)];
      expect(splitOrphanRecords(records, (pid) => pid === 5002)).toEqual({
        alive: [records[0]],
        dead: [records[1]],
      });
    });
  });

  it('splitOrphanRecords: the liveness pre-filter keeps dead PIDs out of the query', () => {
    const records = [record(1), record(2, 2), record(3, 3)];
    expect(splitOrphanRecords(records, (pid) => pid !== 2)).toEqual({
      alive: [records[0], records[2]],
      dead: [records[1]],
    });
  });
});
