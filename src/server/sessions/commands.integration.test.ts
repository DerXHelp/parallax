/**
 * WP-13 §3.5.6 / architecture §5.2 – the command table as a table test: every error row, and the
 * effect + result of every Phase-1 command (dormant and running), through the real manager with
 * the FakeBackend. Every result is checked against `commandResultSchemas` by the harness.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import type { ErrorCode } from '@shared/errors';
import { currentConversation } from '@shared/model';
import {
  sampleConversation,
  sampleEntry,
  sampleId,
  sampleItems,
  sampleProfile,
  sampleSettings,
} from '@shared/samples';
import { eventsScenario } from '../backend/fakeBackend';
import { closeGate, dslContext, input, events as join, textTurn, toEvents } from '../backend/fake/dsl';
import { checkCwd } from '../lib/paths';
import { CommandError } from '../sync/ports';
import {
  HARNESS_CWD,
  createEngineHarness,
  type CommandInput,
  type EngineHarness,
  type EngineHarnessOptions,
} from './testing/harness';

// Whole-engine runs: generous per-test bound for parallel load (the logic itself uses no wall clock).
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

const UNKNOWN: EntryId = sampleId('en', 999);

/** Every command that addresses an entry, with valid arguments. */
function entryCommands(entryId: EntryId): CommandInput[] {
  return [
    { name: 'session.sendPrompt', entryId, prompt: { text: 'hi' } },
    { name: 'session.interrupt', entryId },
    { name: 'session.setModel', entryId, model: 'opus' },
    { name: 'session.setPermissionMode', entryId, mode: 'acceptEdits' },
    { name: 'session.setEffort', entryId, effort: 'high' },
    { name: 'session.setFastMode', entryId, enabled: true },
    { name: 'session.rename', entryId, title: 'X' },
    { name: 'session.close', entryId },
    { name: 'session.resume', entryId },
    { name: 'session.setPinned', entryId, pinned: true },
    { name: 'session.setArchived', entryId, archived: true },
    {
      name: 'decision.respond',
      entryId,
      decisionId: sampleId('dc', 1),
      response: { kind: 'permission', response: { behavior: 'allow' } },
    },
    { name: 'transcript.loadEarlier', entryId, conversationId: sampleId('cv', 1), beforeOrder: 5, limit: 10 },
    { name: 'session.getContext', entryId, detail: 'summary' },
    { name: 'session.refreshModels', entryId },
  ];
}

describe('general rows', () => {
  it.each(entryCommands(UNKNOWN).map((c) => [c.name, c] as const))(
    '%s: unknown entry → ENTRY_NOT_FOUND',
    async (_n, cmd) => {
      const h = await setup();
      expect((await h.cmdError(cmd)).code).toBe('ENTRY_NOT_FOUND');
    },
  );

  it('every command after server.shutdown → SERVER_SHUTTING_DOWN', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    await h.cmd({ name: 'server.shutdown' });
    const all: CommandInput[] = [
      ...entryCommands(entryId),
      { name: 'session.create', cwd: HARNESS_CWD },
      { name: 'settings.update', patch: { theme: 'light' } },
      { name: 'server.shutdown' },
    ];
    for (const cmd of all)
      expect([cmd.name, (await h.cmdError(cmd)).code]).toEqual([cmd.name, 'SERVER_SHUTTING_DOWN']);
  });

  it('runState external → SESSION_EXTERNAL (Phase 2 handoff), loadEarlier still works', async () => {
    const entry = sampleEntry({ id: sampleId('en', 3), lastRunState: 'external' });
    const h = await setup({ seed: { entries: [entry] } });
    for (const cmd of entryCommands(entry.id)) {
      if (cmd.name === 'transcript.loadEarlier') continue;
      expect([cmd.name, (await h.cmdError(cmd)).code]).toEqual([cmd.name, 'SESSION_EXTERNAL']);
    }
    const page = await h.cmd({
      name: 'transcript.loadEarlier',
      entryId: entry.id,
      conversationId: currentConversation(entry).id,
      beforeOrder: 3,
      limit: 5,
    });
    expect(page).toEqual({ items: [], hasEarlier: false });
  });

  it('an unexpected error → INTERNAL_ERROR (logged)', async () => {
    const h = await setup();
    h.stores.settings.update = () => {
      throw new Error('disk on fire');
    };
    expect((await h.cmdError({ name: 'settings.update', patch: { theme: 'light' } })).code).toBe(
      'INTERNAL_ERROR',
    );
    expect(h.errors.map((e) => e.context)).toEqual(['command settings.update']);
    h.errors.length = 0;
  });
});

describe('session.create', () => {
  it('without prompt: entry with exact cwd, first conversation, sleeping; title → custom', async () => {
    const h = await setup();
    const cwd = 'd:\\Work\\Mixed Case\\';
    const result = await h.cmd({ name: 'session.create', cwd, title: '  My title ' });
    expect(result.messageUuid).toBeNull();
    const entry = h.stores.registry.get(result.entryId);
    expect(entry).toMatchObject({ cwd, title: 'My title', titleSource: 'custom', lastRunState: 'sleeping' });
    expect(entry?.conversations).toHaveLength(1);
    expect(entry?.conversations[0]?.id).toMatch(/^cv_[0-9a-f]{32}$/);
    expect(h.summary(result.entryId).status.runState).toBe('sleeping');
    expect(h.backend.starts).toHaveLength(0);
  });

  it('with prompt: start + send, title from the prompt; model/mode/effort from command, then profile', async () => {
    const profile = sampleProfile({
      defaults: { model: 'sonnet', permissionMode: 'acceptEdits', effort: 'low' },
    });
    const h = await setup({ profiles: [profile] });
    const a = await h.cmd({
      name: 'session.create',
      cwd: HARNESS_CWD,
      prompt: { text: '  Fix the\n  parser bug please ' },
      model: 'opus',
      permissionMode: 'plan',
      effort: 'high',
    });
    expect(a.messageUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.summary(a.entryId)).toMatchObject({ title: 'Fix the', titleSource: 'prompt' });
    expect(h.backend.starts[0]).toMatchObject({ model: 'opus', permissionMode: 'plan', effort: 'high' });
    expect(h.backend.starts[0]?.promptSuggestions).toBe(false);
    const b = await h.cmd({ name: 'session.create', cwd: HARNESS_CWD });
    expect(h.stores.registry.get(b.entryId)).toMatchObject({
      modelSetting: 'sonnet',
      permissionMode: 'acceptEdits',
      effort: 'low',
      titleSource: 'none',
    });
  });

  it.each<[string, Partial<Extract<CommandInput, { name: 'session.create' }>>, ErrorCode]>([
    ['unknown profile', { profileId: sampleId('pf', 4) }, 'PROFILE_NOT_FOUND'],
    ['bypass without allowsBypass', { permissionMode: 'bypassPermissions' }, 'MODE_NOT_ALLOWED'],
    ['attachments', { prompt: { text: 'x', attachments: [{ blobId: 'a'.repeat(64) }] } }, 'NOT_IMPLEMENTED'],
    ['UNC cwd', { cwd: '\\\\server\\share\\repo' }, 'PATH_REJECTED'],
  ])('%s → %s', async (_name, extra, code) => {
    const h = await setup();
    expect((await h.cmdError({ name: 'session.create', cwd: HARNESS_CWD, ...extra })).code).toBe(code);
    expect(h.manager.listSummaries()).toEqual([]);
  });

  it('a bypass profile default without allowsBypass → MODE_NOT_ALLOWED; with it the entry gets the mode', async () => {
    const profile = sampleProfile({
      defaults: { model: null, permissionMode: 'bypassPermissions', effort: null },
    });
    const strict = await setup({ profiles: [profile] });
    expect((await strict.cmdError({ name: 'session.create', cwd: HARNESS_CWD })).code).toBe(
      'MODE_NOT_ALLOWED',
    );
    const allowed = await setup({ profiles: [profile], allowsBypass: true });
    const { entryId } = await allowed.cmd({ name: 'session.create', cwd: HARNESS_CWD });
    expect(allowed.stores.registry.get(entryId)?.permissionMode).toBe('bypassPermissions');
  });

  it('checkCwd: missing → CWD_NOT_FOUND, a file → CWD_NOT_DIRECTORY, a directory is kept exactly', async () => {
    const base = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp13b-cwd-'));
    const file = path.join(base, 'file.txt');
    await writeFile(file, 'x');
    const h = await setup({ checkCwd });
    expect((await h.cmdError({ name: 'session.create', cwd: path.join(base, 'missing') })).code).toBe(
      'CWD_NOT_FOUND',
    );
    expect((await h.cmdError({ name: 'session.create', cwd: file })).code).toBe('CWD_NOT_DIRECTORY');
    const { entryId } = await h.cmd({ name: 'session.create', cwd: base });
    expect(h.stores.registry.get(entryId)?.cwd).toBe(base);
  });
});

describe('commands of a dormant entry', () => {
  it('interrupt → {stillQueued: []} without a start; getContext → SESSION_NOT_RUNNING', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    expect(await h.cmd({ name: 'session.interrupt', entryId })).toEqual({ stillQueued: [] });
    expect((await h.cmdError({ name: 'session.getContext', entryId, detail: 'summary' })).code).toBe(
      'SESSION_NOT_RUNNING',
    );
    expect(await h.cmd({ name: 'session.close', entryId })).toEqual({});
    expect(h.backend.starts).toHaveLength(0);
  });

  it('WP22-01: before the first start the picker offers the CLI aliases; the choice is the first model', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    const { models } = await h.cmd({ name: 'session.refreshModels', entryId });
    expect(models.map((m) => m.value)).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect((await h.manager.loadView(entryId))?.detail.models?.map((m) => m.value)).toEqual([
      'default',
      'opus',
      'sonnet',
      'haiku',
    ]);
    expect(h.backend.starts).toHaveLength(0);
    await h.cmd({ name: 'session.setModel', entryId, model: 'haiku' });
    expect(h.backend.starts).toHaveLength(0);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'hello' } });
    expect(h.backend.starts[0]?.model).toBe('haiku');
  });

  it('setModel / setPermissionMode / setEffort are stored and used by the next start', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    await h.cmd({ name: 'session.setModel', entryId, model: 'haiku' });
    await h.cmd({ name: 'session.setPermissionMode', entryId, mode: 'acceptEdits' });
    await h.cmd({ name: 'session.setEffort', entryId, effort: 'max' });
    expect(h.summary(entryId)).toMatchObject({
      modelSetting: 'haiku',
      permissionMode: 'acceptEdits',
      effort: 'max',
    });
    expect(
      (await h.cmdError({ name: 'session.setPermissionMode', entryId, mode: 'bypassPermissions' })).code,
    ).toBe('MODE_NOT_ALLOWED');
    await h.cmd({ name: 'session.resume', entryId });
    expect(h.backend.starts[0]).toMatchObject({
      model: 'haiku',
      permissionMode: 'acceptEdits',
      effort: 'max',
    });
  });

  it('rename: dormant with session id → renameSession (C.6); without → local; null → automatic title', async () => {
    const withSession = sampleEntry({ id: sampleId('en', 5), titleSource: 'prompt', title: 'Old' });
    const withoutSession = sampleEntry({
      id: sampleId('en', 6),
      conversations: [sampleConversation({ id: sampleId('cv', 6), sessionId: null })],
    });
    const h = await setup({ seed: { entries: [withSession, withoutSession] } });
    await h.cmd({ name: 'session.rename', entryId: withSession.id, title: 'New name' });
    expect(h.summary(withSession.id)).toMatchObject({ title: 'New name', titleSource: 'custom' });
    const sessionId = currentConversation(withSession).sessionId ?? '';
    expect(h.backend.history.info(sessionId)).toMatchObject({ customTitle: 'New name' });
    await h.cmd({ name: 'session.rename', entryId: withoutSession.id, title: 'Local' });
    expect(h.summary(withoutSession.id).title).toBe('Local');
    await h.cmd({ name: 'session.rename', entryId: withSession.id, title: null });
    expect(h.summary(withSession.id)).toMatchObject({ title: '', titleSource: 'none' });
    expect(h.backend.starts).toHaveLength(0);
  });

  it('transcript.loadEarlier: items before an order; unknown conversation → CONVERSATION_NOT_FOUND', async () => {
    const entry = sampleEntry({
      id: sampleId('en', 7),
      conversations: [sampleConversation({ id: sampleId('cv', 7) })],
    });
    const items = [
      sampleItems.userMessage(),
      sampleItems.thinking(),
      sampleItems.assistantText(),
      sampleItems.toolCall(),
      sampleItems.turnResult(),
    ];
    const h = await setup({
      seed: {
        entries: [entry],
        transcripts: [{ entryId: entry.id, conversationId: sampleId('cv', 7), items }],
      },
    });
    const page = await h.cmd({
      name: 'transcript.loadEarlier',
      entryId: entry.id,
      conversationId: sampleId('cv', 7),
      beforeOrder: 4,
      limit: 2,
    });
    expect(page.items.map((i) => i.order)).toEqual([2, 3]);
    expect(page.hasEarlier).toBe(true);
    const error = await h.cmdError({
      name: 'transcript.loadEarlier',
      entryId: entry.id,
      conversationId: sampleId('cv', 8),
      beforeOrder: 4,
      limit: 2,
    });
    expect(error.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('setFastMode / setPinned / setArchived → NOT_IMPLEMENTED (Phase 2)', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    const phase2: CommandInput[] = [
      { name: 'session.setFastMode', entryId, enabled: true },
      { name: 'session.setPinned', entryId, pinned: true },
      { name: 'session.setArchived', entryId, archived: false },
    ];
    for (const cmd of phase2)
      expect([cmd.name, (await h.cmdError(cmd)).code]).toEqual([cmd.name, 'NOT_IMPLEMENTED']);
  });

  it('sendPrompt with attachments → NOT_IMPLEMENTED; decision.respond with an unknown id → DECISION_NOT_FOUND', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    const attachments = await h.cmdError({
      name: 'session.sendPrompt',
      entryId,
      prompt: { text: 'x', attachments: [{ blobId: 'b'.repeat(64) }] },
    });
    expect(attachments.code).toBe('NOT_IMPLEMENTED');
    const unknown = await h.cmdError({
      name: 'decision.respond',
      entryId,
      decisionId: sampleId('dc', 77),
      response: { kind: 'permission', response: { behavior: 'allow' } },
    });
    expect(unknown.code).toBe('DECISION_NOT_FOUND');
  });

  it('sendPrompt of a dormant entry resumes it (single start) and sends; slash prompts never become the title', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    const [a, b] = await Promise.all([
      h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: '/compact' } }),
      h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Second prompt' } }),
    ]);
    expect(h.backend.starts).toHaveLength(1);
    expect(h.session(entryId).sent.map((p) => p.uuid)).toEqual([a.messageUuid, b.messageUuid]);
    expect(h.summary(entryId)).toMatchObject({ title: 'Second prompt', titleSource: 'prompt' });
  });
});

describe('commands of a running entry', () => {
  async function running(h: EngineHarness): Promise<EntryId> {
    const entryId = await h.create('hello');
    await h.settle();
    expect(h.facts(entryId).runState).toBe('idle');
    return entryId;
  }

  it('setModel / setPermissionMode / setEffort go to the process and are stored', async () => {
    const h = await setup();
    const entryId = await running(h);
    await h.cmd({ name: 'session.setModel', entryId, model: 'opus' });
    await h.cmd({ name: 'session.setModel', entryId, model: null });
    await h.cmd({ name: 'session.setPermissionMode', entryId, mode: 'plan' });
    await h.cmd({ name: 'session.setEffort', entryId, effort: 'low' });
    expect(h.session(entryId).controls).toEqual([
      { method: 'setModel', args: ['opus'] },
      { method: 'setModel', args: [null] },
      { method: 'setPermissionMode', args: ['plan'] },
      { method: 'applyFlagSettings', args: [{ effortLevel: 'low' }] },
    ]);
    expect(h.summary(entryId)).toMatchObject({ modelSetting: null, permissionMode: 'plan', effort: 'low' });
  });

  it('a failing control request → CLAUDE_CONTROL_FAILED', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000d1' });
    const prompt = c.ids.uuid();
    const events = join(
      input(c, prompt, 'hello'),
      textTurn(c, { prompt, text: 'hi' }),
      toEvents([
        ['control', { method: 'setModel', args: ['opus'], error: { message: 'boom' }, ms: 1 }],
        ['call', { fn: 'getContextUsage', args: [{ detail: 'full' }], error: { message: 'boom' }, ms: 1 }],
      ]),
      closeGate(),
    );
    const h = await setup({ scenario: () => eventsScenario('control-error', events) });
    const entryId = await running(h);
    expect((await h.cmdError({ name: 'session.setModel', entryId, model: 'opus' })).code).toBe(
      'CLAUDE_CONTROL_FAILED',
    );
    expect(h.summary(entryId).modelSetting).toBeNull();
    const context = await h.cmdError({ name: 'session.getContext', entryId, detail: 'full' });
    expect(context).toMatchObject({ code: 'CLAUDE_CONTROL_FAILED', params: { detail: 'full' } });
  });

  it('getContext summary updates the gauge; full returns categories; refreshModels caches per profile', async () => {
    const h = await setup();
    const entryId = await running(h);
    const { context } = await h.cmd({ name: 'session.getContext', entryId, detail: 'summary' });
    expect(context).toMatchObject({ detail: 'summary', source: 'sdk', maxTokens: 200_000 });
    expect(h.summary(entryId).context).toMatchObject({ totalTokens: context.totalTokens, source: 'sdk' });
    const full = await h.cmd({ name: 'session.getContext', entryId, detail: 'full' });
    expect(full.context.categories.length).toBeGreaterThan(0);
    const { models } = await h.cmd({ name: 'session.refreshModels', entryId });
    expect(models.map((m) => m.value)).toContain('haiku');
    await h.cmd({ name: 'session.close', entryId });
    // Dormant: from the cache of the profile.
    expect((await h.cmd({ name: 'session.refreshModels', entryId })).models).toEqual(models);
  });

  it('rename while running: title custom at once, `/rename X` prompt (next), the echo keeps it', async () => {
    const h = await setup();
    const entryId = await running(h);
    await h.cmd({ name: 'session.rename', entryId, title: 'Running name' });
    expect(h.summary(entryId)).toMatchObject({ title: 'Running name', titleSource: 'custom' });
    const last = h.session(entryId).sent.at(-1);
    expect(last).toMatchObject({
      priority: 'next',
      content: [{ type: 'text', text: '/rename Running name' }],
    });
    await h.settle();
    expect(h.manager.inspect(entryId)?.pendingRename).toBeNull();
    expect(h.summary(entryId)).toMatchObject({ title: 'Running name', titleSource: 'custom' });
  });

  it('resume of a running entry is a no-op; close → sleeping; settings.update → host state', async () => {
    const h = await setup();
    const entryId = await running(h);
    await h.cmd({ name: 'session.resume', entryId });
    expect(h.backend.starts).toHaveLength(1);
    await h.cmd({ name: 'session.close', entryId });
    expect(h.facts(entryId).runState).toBe('sleeping');
    const before = h.publisher.hostStates.length;
    const { settings } = await h.cmd({ name: 'settings.update', patch: { language: 'de' } });
    expect(settings).toEqual(sampleSettings({ language: 'de' }));
    expect(h.publisher.hostStates.length).toBe(before + 1);
    expect(h.publisher.hostStates.at(-1)?.settings.language).toBe('de');
  });

  it('decision rows: kind mismatch → DECISION_OPTION_UNAVAILABLE; plan approve bypass → MODE_NOT_ALLOWED; fresh context → NOT_IMPLEMENTED', async () => {
    const h = await setup();
    const entryId = await h.create('fake:plan');
    await h.settle();
    const [plan] = await h.decisions(entryId);
    if (plan?.kind !== 'plan') throw new Error('no plan decision');
    const mismatch = await h.cmdError({
      name: 'decision.respond',
      entryId,
      decisionId: plan.id,
      response: { kind: 'permission', response: { behavior: 'allow' } },
    });
    expect(mismatch.code).toBe('DECISION_OPTION_UNAVAILABLE');
    const bypass = await h.cmdError({
      name: 'decision.respond',
      entryId,
      decisionId: plan.id,
      response: { kind: 'plan', response: { behavior: 'approve', mode: 'bypassPermissions' } },
    });
    expect(bypass.code).toBe('MODE_NOT_ALLOWED');
    const fresh = await h.cmdError({
      name: 'decision.respond',
      entryId,
      decisionId: plan.id,
      response: { kind: 'plan', response: { behavior: 'approve_fresh_context', mode: 'default' } },
    });
    expect(fresh.code).toBe('NOT_IMPLEMENTED');
    const ok = await h.cmd({
      name: 'decision.respond',
      entryId,
      decisionId: plan.id,
      response: { kind: 'plan', response: { behavior: 'approve', mode: 'default' } },
    });
    expect(ok.outcome).toEqual({ type: 'plan_approved', mode: 'default', edited: false });
  });

  it('server.shutdown counts the running sessions before closing (R0-19)', async () => {
    const h = await setup();
    await running(h);
    await running(h);
    await h.create(null);
    expect(await h.cmd({ name: 'server.shutdown' })).toEqual({ sessionsStopped: 2 });
  });
});

describe('CommandError surface', () => {
  it('handleCommand throws CommandError with code and params', async () => {
    const h = await setup();
    await expect(
      h.manager.handleCommand(
        { name: 'session.resume', entryId: UNKNOWN },
        { clientId: sampleId('cl', 1), cmdId: '00000000-0000-4000-8000-000000000001' },
      ),
    ).rejects.toBeInstanceOf(CommandError);
  });
});
