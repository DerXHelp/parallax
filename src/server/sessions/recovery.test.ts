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

  it('ONE query for all records (pids only – no children, R2-03)', async () => {
    const { d, queryProcesses, killProcessTree } = deps();
    queryProcesses.mockResolvedValue(ok(info({ pid: 2 }), info({ pid: 3, name: 'x.exe' })));
    const results = await Promise.all(cleanupOrphans([record(1), record(2, 2), record(3, 3)], d));
    expect(results).toEqual(['gone', 'killed', 'not_ours']);
    expect(queryProcesses.mock.calls).toEqual([[{ pids: [1, 2, 3] }]]);
    expect(killProcessTree.mock.calls.map((c) => c[0])).toEqual([2]);
    expect(cleanupOrphans([], d)).toEqual([]);
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

  it('splitOrphanRecords: the liveness pre-filter keeps dead PIDs out of the query', () => {
    const records = [record(1), record(2, 2), record(3, 3)];
    expect(splitOrphanRecords(records, (pid) => pid !== 2)).toEqual({
      alive: [records[0], records[2]],
      dead: [records[1]],
    });
  });
});
