import { describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { toolCallItemSchema } from '@shared/model';
import { SAMPLE_TIME, sampleEntry, sampleId, sampleItems } from '@shared/samples';
import type { ProcessInfo } from '../lib/process';
import type { ProcessRecord } from './processStore';
import { cleanupOrphan, interruptedToolCalls, registryFacts, wasActive, type OrphanDeps } from './recovery';

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

describe('cleanupOrphan (C.8)', () => {
  const record: ProcessRecord = {
    entryId: sampleId('en', 1),
    pid: 4242,
    image: 'claude.exe',
    startedAt: SAMPLE_TIME,
  };
  const at = (s: number) => new Date(Date.parse(SAMPLE_TIME) + s * 1000);
  const info = (p: Partial<ProcessInfo>): ProcessInfo => ({
    pid: 4242,
    name: 'claude.exe',
    parentPid: 1,
    startedAt: at(0),
    ...p,
  });

  function deps(p: Partial<OrphanDeps>): OrphanDeps & { killProcessTree: ReturnType<typeof vi.fn> } {
    const killProcessTree = vi.fn(() => Promise.resolve());
    return {
      processInfo: () => Promise.resolve(null),
      serverStartedAt: at(600),
      log: { warn: vi.fn(), error: vi.fn() },
      ...p,
      killProcessTree,
    };
  }

  it.each<[string, ProcessInfo | null, string, number[]]>([
    [
      'same image (case-insensitive) and start ± 5 s → killed',
      info({ name: 'Claude.EXE', startedAt: at(4.9) }),
      'killed',
      [4242],
    ],
    ['start 6 s off → PID reused → untouched', info({ startedAt: at(6) }), 'not_ours', []],
    ['other image → untouched', info({ name: 'chrome.exe' }), 'not_ours', []],
    ['gone, no child lookup', null, 'gone', []],
  ])('%s', async (_name, found, result, killed) => {
    const d = deps({ processInfo: () => Promise.resolve(found) });
    expect(await cleanupOrphan(record, d)).toBe(result);
    expect(d.killProcessTree.mock.calls.map((c: unknown[]) => c[0])).toEqual(killed);
  });

  it('gone → children started after it and before this server are ended', async () => {
    const d = deps({
      childProcesses: () =>
        Promise.resolve([
          info({ pid: 1, name: 'node.exe', startedAt: at(10) }),
          info({ pid: 2, name: 'old.exe', startedAt: at(-10) }),
          info({ pid: 3, name: 'new.exe', startedAt: at(700) }),
        ]),
    });
    expect(await cleanupOrphan(record, d)).toBe('children_killed');
    expect(d.killProcessTree.mock.calls.map((c: unknown[]) => c[0])).toEqual([1]);
  });

  it('a failing lookup is logged, never thrown', async () => {
    const errorLog = vi.fn();
    const d = deps({
      processInfo: () => Promise.reject(new Error('powershell missing')),
      log: { warn: vi.fn(), error: errorLog },
    });
    expect(await cleanupOrphan(record, d)).toBe('failed');
    expect(errorLog).toHaveBeenCalled();
  });
});
