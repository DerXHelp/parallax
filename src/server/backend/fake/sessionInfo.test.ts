/**
 * WP-67 – the session info of the FakeBackend: every section through the SdkBackend's parser (no
 * account data), the MCP state machine, reloads, the levers (options and `fake:info-*` keywords),
 * the events mode and a closed session. The engine path is covered by
 * sessions/sessionInfo.integration.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SESSION_INFO_LIMITS, SESSION_INFO_SECTIONS, type SessionInfoOf } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import type { BackendEvent } from '../types';
import {
  FAKE_FRESH_SKILL,
  FAKE_INFO_ACTION_ERROR,
  createFakeBackend,
  eventsScenario,
  sequentialIds,
  type FakeBackendOptions,
} from '../fakeBackend';
import { createFakeClaudeIntegration } from './integration';

const launch = await createFakeClaudeIntegration().launchSpecFor('standard', SAMPLE_IDS.entry);
const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'parallax-fake-info-test-'));
afterAll(() => {
  rmSync(filesRoot, { recursive: true, force: true });
});

const CWD = 'D:\\work\\fake';

function harness(options: Partial<FakeBackendOptions> = {}) {
  const backend = createFakeBackend({
    ids: sequentialIds(),
    filesRoot: mkdtempSync(path.join(filesRoot, 'h-')),
    now: () => new Date(2026, 10, 13, 10, 15, 0),
    ...options,
  });
  const agent = backend.start({
    entryId: SAMPLE_IDS.entry,
    cwd: CWD,
    launch,
    resumeSessionId: null,
    model: null,
    permissionMode: null,
    effort: null,
    promptSuggestions: false,
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no' }),
  });
  const events: BackendEvent[] = [];
  const consumed = (async () => {
    for await (const event of agent.events) events.push(event);
  })();
  let n = 0;
  const send = async (text: string) => {
    n += 1;
    agent.send({
      uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      content: [{ type: 'text', text }],
      priority: 'next',
    });
    await backend.settle();
  };
  const close = async () => {
    await agent.close();
    await consumed;
  };
  return { backend, agent, send, close };
}

async function mcpOf(agent: ReturnType<typeof harness>['agent']): Promise<SessionInfoOf<'mcp'>['servers']> {
  const data = await agent.readInfo('mcp');
  if (data?.section !== 'mcp') throw new Error('no mcp data');
  return data.servers;
}

async function skillNames(agent: ReturnType<typeof harness>['agent']): Promise<string[]> {
  const data = await agent.readInfo('skills');
  if (data?.section !== 'skills') throw new Error('no skills data');
  return data.skills.map((s) => s.name);
}

describe('FakeBackend – session info (WP-67)', () => {
  it('every section answers in the display form, without account data', async () => {
    const h = harness();
    await h.send('fix the login bug');
    for (const section of SESSION_INFO_SECTIONS) {
      const data = await h.agent.readInfo(section);
      expect(data?.section).toBe(section);
    }
    const all = JSON.stringify(await Promise.all(SESSION_INFO_SECTIONS.map((s) => h.agent.readInfo(s))));
    expect(all).not.toMatch(/@|organi[sz]ation|e-?mail/i);
    await expect(h.agent.readInfo('export')).resolves.toMatchObject({
      section: 'export',
      filename: '2026-11-13-101500-fix-the-login-bug.txt',
      text: expect.stringContaining('> fix the login bug') as unknown,
    });
    await expect(h.agent.readInfo('permissions')).resolves.toMatchObject({ cwd: CWD });
    await expect(h.agent.readInfo('memory')).resolves.toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({ kind: 'project', path: `${CWD}\\CLAUDE.md` }),
      ]) as unknown,
    });
    await h.close();
  });

  it('MCP: reconnect connects a failed server, a disabled one refuses; enable/disable; unknown server rejects', async () => {
    const h = harness();
    expect((await mcpOf(h.agent)).map((s) => [s.name, s.status])).toEqual([
      ['fake-docs', 'connected'],
      ['fake-search', 'failed'],
      ['fake-auth', 'needs-auth'],
      ['fake-off', 'disabled'],
    ]);
    await h.agent.mcpAction('fake-search', 'reconnect');
    await expect(h.agent.mcpAction('fake-off', 'reconnect')).rejects.toThrow('is disabled');
    await h.agent.mcpAction('fake-off', 'enable');
    await h.agent.mcpAction('fake-docs', 'disable');
    await expect(h.agent.mcpAction('nope', 'reconnect')).rejects.toThrow('not found');
    expect((await mcpOf(h.agent)).map((s) => [s.name, s.status, s.error])).toEqual([
      ['fake-docs', 'disabled', null],
      ['fake-search', 'connected', null],
      ['fake-auth', 'needs-auth', null],
      ['fake-off', 'connected', null],
    ]);
    await h.close();
  });

  it('reloadSkills adds the fresh skill; reloadPlugins resolves', async () => {
    const h = harness();
    expect(await skillNames(h.agent)).not.toContain(FAKE_FRESH_SKILL);
    await h.agent.reload('skills');
    await h.agent.reload('plugins');
    expect(await skillNames(h.agent)).toContain(FAKE_FRESH_SKILL);
    await h.close();
  });

  it('levers: unavailable sections, failing actions, long lists (options)', async () => {
    const h = harness({ sessionInfo: { unavailable: ['hooks'], actions: 'failed', long: true } });
    await expect(h.agent.readInfo('hooks')).resolves.toBeNull();
    await expect(h.agent.mcpAction('fake-search', 'reconnect')).rejects.toThrow(FAKE_INFO_ACTION_ERROR);
    await expect(h.agent.reload('skills')).rejects.toThrow(FAKE_INFO_ACTION_ERROR);
    await expect(h.agent.readInfo('skills')).resolves.toMatchObject({ truncated: true });
    expect(await skillNames(h.agent)).toHaveLength(SESSION_INFO_LIMITS.listMax);
    const all = harness({ sessionInfo: { unavailable: 'all' } });
    for (const section of SESSION_INFO_SECTIONS)
      await expect(all.agent.readInfo(section)).resolves.toBeNull();
    await h.close();
    await all.close();
  });

  it('levers: the fake:info-* keywords switch this session and reset brings the options back', async () => {
    const h = harness();
    await h.send('fake:info-unavailable mcp status nonsense');
    await expect(h.agent.readInfo('mcp')).resolves.toBeNull();
    await expect(h.agent.readInfo('status')).resolves.toBeNull();
    await expect(h.agent.readInfo('skills')).resolves.not.toBeNull();
    await h.send('fake:info-fail');
    await expect(h.agent.reload('plugins')).rejects.toThrow(FAKE_INFO_ACTION_ERROR);
    await h.send('fake:info-long');
    await expect(h.agent.readInfo('permissions')).resolves.toMatchObject({ truncated: false });
    await h.send('fake:info-reset');
    await expect(h.agent.readInfo('mcp')).resolves.not.toBeNull();
    await expect(h.agent.reload('plugins')).resolves.toBeUndefined();
    await h.send('fake:info-unavailable');
    for (const section of SESSION_INFO_SECTIONS) await expect(h.agent.readInfo(section)).resolves.toBeNull();
    await h.close();
  });

  it('events mode: not available, actions reject; a closed session rejects', async () => {
    const e = harness({ scenario: () => eventsScenario('empty', []) });
    await expect(e.agent.readInfo('status')).resolves.toBeNull();
    await expect(e.agent.mcpAction('x', 'reconnect')).rejects.toThrow();
    await expect(e.agent.reload('skills')).rejects.toThrow();
    await e.close();
    const h = harness();
    await h.close();
    await expect(h.agent.readInfo('status')).rejects.toThrow('session closed');
    await expect(h.agent.mcpAction('fake-docs', 'reconnect')).rejects.toThrow('session closed');
    await expect(h.agent.reload('skills')).rejects.toThrow('session closed');
  });
});
