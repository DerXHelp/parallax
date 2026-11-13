/**
 * WP-67 – session info with tabs through the real manager with the FakeBackend (speed 0): each
 * section on request (no polling: nothing is asked without a command), "not available" without an
 * error, a dormant entry is not woken (SESSION_NOT_RUNNING), a start in progress is awaited, MCP
 * actions and reloads, failures as CLAUDE_CONTROL_FAILED (with the CLI's text for actions), gates
 * (archived, external).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { SESSION_INFO_SECTIONS } from '@shared/model';
import { FAKE_FRESH_SKILL, FAKE_INFO_ACTION_ERROR } from '../backend/fakeBackend';
import { createTestConsoleLauncher, TEST_CONSOLE_FIRST_PID } from './testing/consoleLauncher';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

async function setup(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const h = await createEngineHarness(options);
  harnesses.push(h);
  return h;
}

async function idleEntry(h: EngineHarness, prompt = 'hello first world'): Promise<EntryId> {
  const entryId = await h.create(prompt);
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
  return entryId;
}

function infoCalls(h: EngineHarness, entryId: EntryId): unknown[] {
  return h
    .session(entryId)
    .calls.filter((c) => c.fn === 'readInfo')
    .map((c) => c.args[0]);
}

describe('session.info (WP-67 §1.1)', () => {
  it('answers each section on request – nothing is asked without a command', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    expect(infoCalls(h, entryId)).toEqual([]);
    for (const section of SESSION_INFO_SECTIONS) {
      const result = await h.cmd({ name: 'session.info', entryId, section });
      expect(result.available).toBe(true);
      expect(result.data?.section).toBe(section);
    }
    expect(infoCalls(h, entryId)).toEqual([...SESSION_INFO_SECTIONS]);
    const exported = await h.cmd({ name: 'session.info', entryId, section: 'export' });
    expect(exported.data).toMatchObject({ text: expect.stringContaining('> hello first world') as unknown });
  });

  it('a section this CLI cannot answer → available:false, no error', async () => {
    const h = await setup({ sessionInfo: { unavailable: ['hooks'] } });
    const entryId = await idleEntry(h);
    expect(await h.cmd({ name: 'session.info', entryId, section: 'hooks' })).toEqual({
      available: false,
      data: null,
    });
    expect(h.summary(entryId).lastError ?? null).toBeNull();
  });

  it('a dormant entry is not woken (SESSION_NOT_RUNNING); a start in progress is awaited', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.close', entryId });
    await h.settle();
    const starts = h.backend.starts.length;
    for (const cmd of [
      { name: 'session.info', entryId, section: 'status' },
      { name: 'session.mcpAction', entryId, server: 'fake-docs', action: 'reconnect' },
      { name: 'session.reload', entryId, what: 'skills' },
    ] as const) {
      expect(await h.cmdError(cmd)).toEqual({ code: 'SESSION_NOT_RUNNING', params: { entryId } });
    }
    expect(h.backend.starts.length).toBe(starts);

    const resumed = h.cmd({ name: 'session.resume', entryId });
    const info = await h.cmd({ name: 'session.info', entryId, section: 'status' });
    await resumed;
    expect(info.available).toBe(true);
    expect(h.backend.starts.length).toBe(starts + 1);
  });

  it('MCP actions and reloads change what the next request shows', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    expect(
      await h.cmd({ name: 'session.mcpAction', entryId, server: 'fake-search', action: 'reconnect' }),
    ).toEqual({});
    const mcp = await h.cmd({ name: 'session.info', entryId, section: 'mcp' });
    expect(
      mcp.data?.section === 'mcp' ? mcp.data.servers.find((s) => s.name === 'fake-search')?.status : null,
    ).toBe('connected');
    expect(await h.cmd({ name: 'session.reload', entryId, what: 'skills' })).toEqual({});
    const skills = await h.cmd({ name: 'session.info', entryId, section: 'skills' });
    expect(skills.data?.section === 'skills' ? skills.data.skills.map((s) => s.name) : []).toContain(
      FAKE_FRESH_SKILL,
    );
    expect(
      h.session(entryId).controls.filter((c) => c.method === 'mcpAction' || c.method === 'reload'),
    ).toEqual([
      { method: 'mcpAction', args: ['fake-search', 'reconnect'] },
      { method: 'reload', args: ['skills'] },
    ]);
  });

  it('failures → CLAUDE_CONTROL_FAILED (actions with the CLI text)', async () => {
    const h = await setup({ sessionInfo: { actions: 'failed' } });
    const entryId = await idleEntry(h);
    expect(
      await h.cmdError({ name: 'session.mcpAction', entryId, server: 'fake-docs', action: 'disable' }),
    ).toEqual({
      code: 'CLAUDE_CONTROL_FAILED',
      params: { method: 'mcpAction', detail: FAKE_INFO_ACTION_ERROR },
    });
    expect(await h.cmdError({ name: 'session.reload', entryId, what: 'plugins' })).toEqual({
      code: 'CLAUDE_CONTROL_FAILED',
      params: { method: 'reload', detail: FAKE_INFO_ACTION_ERROR },
    });
    const ok = await setup();
    const other = await idleEntry(ok);
    expect(
      await ok.cmdError({
        name: 'session.mcpAction',
        entryId: other,
        server: 'fake-off',
        action: 'reconnect',
      }),
    ).toEqual({
      code: 'CLAUDE_CONTROL_FAILED',
      params: { method: 'mcpAction', detail: 'MCP server "fake-off" is disabled' },
    });
  });

  it('gates: archived → SESSION_ARCHIVED; an entry in an external console → SESSION_EXTERNAL', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.setArchived', entryId, archived: true });
    expect((await h.cmdError({ name: 'session.info', entryId, section: 'status' })).code).toBe(
      'SESSION_ARCHIVED',
    );
    expect((await h.cmdError({ name: 'session.reload', entryId, what: 'skills' })).code).toBe(
      'SESSION_ARCHIVED',
    );

    const clock = { now: () => h.now() };
    const g = await setup({ consoleLauncher: createTestConsoleLauncher({ now: () => clock.now() }) });
    clock.now = () => g.now();
    const external = await idleEntry(g);
    expect(await g.cmd({ name: 'session.openExternal', entryId: external })).toEqual({
      pid: TEST_CONSOLE_FIRST_PID,
    });
    expect((await g.cmdError({ name: 'session.info', entryId: external, section: 'mcp' })).code).toBe(
      'SESSION_EXTERNAL',
    );
    expect(
      (
        await g.cmdError({
          name: 'session.mcpAction',
          entryId: external,
          server: 'fake-docs',
          action: 'reconnect',
        })
      ).code,
    ).toBe('SESSION_EXTERNAL');
  });
});
