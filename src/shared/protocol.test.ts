import { describe, expect, it } from 'vitest';
import { LIMITS } from './common';
import { SUBAGENT_TRANSCRIPT_LIMITS } from './model';
import {
  HOST_COMMAND_NAMES,
  LOGIN_CODE_CHARS,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  clientMessageSchema,
  commandResultSchemas,
  commandSchema,
  isHostCommand,
  parseClientMessage,
  parseCommandResult,
  parseServerMessage,
  serverMessageSchema,
  type ClientMessage,
  type Command,
  type ServerMessage,
} from './protocol';
import {
  SAMPLE_IDS,
  sampleClaudeInstallStatus,
  sampleClientHello,
  sampleContextBreakdown,
  sampleDecisions,
  sampleFileInfo,
  sampleFileStatResult,
  sampleFsListing,
  sampleHello,
  sampleHostState,
  sampleId,
  sampleItems,
  sampleModelOption,
  sampleOutcomes,
  samplePlanVersionInfo,
  samplePresence,
  sampleProfile,
  sampleProfileInput,
  sampleProfileIssue,
  sampleResponses,
  sampleSessionFile,
  sampleSessionSnapshot,
  sampleSummary,
  sampleTime,
} from './samples';

const entryId = SAMPLE_IDS.entry;

/** One valid command per name. */
const commands: Command[] = [
  { name: 'session.create', cwd: 'D:\\work\\x', prompt: { text: 'Hello', attachments: [], pastes: [] } },
  {
    name: 'session.sendPrompt',
    entryId,
    prompt: { text: 'Next', attachments: [], pastes: ['Next'] },
    priority: 'now',
  },
  { name: 'session.interrupt', entryId },
  { name: 'session.setModel', entryId, model: null },
  { name: 'session.setPermissionMode', entryId, mode: 'acceptEdits' },
  { name: 'session.setEffort', entryId, effort: 'high' },
  { name: 'session.setFastMode', entryId, enabled: true },
  { name: 'session.rename', entryId, title: 'My title' },
  { name: 'session.close', entryId },
  { name: 'session.resume', entryId },
  { name: 'session.setPinned', entryId, pinned: true },
  { name: 'session.setArchived', entryId, archived: false },
  {
    name: 'decision.respond',
    entryId,
    decisionId: SAMPLE_IDS.decision,
    response: sampleResponses.planApprove,
  },
  {
    name: 'transcript.loadEarlier',
    entryId,
    conversationId: SAMPLE_IDS.conversation,
    beforeOrder: 10,
    limit: 50,
  },
  { name: 'session.getContext', entryId, detail: 'full' },
  { name: 'session.refreshModels', entryId },
  { name: 'settings.update', patch: { theme: 'light' } },
  { name: 'server.shutdown' },
  // Phase 2 (WP-30 §4.6)
  { name: 'session.switchConversation', entryId, conversationId: SAMPLE_IDS.conversation },
  { name: 'session.openExternal', entryId },
  { name: 'session.reclaim', entryId },
  { name: 'session.consoleCommand', entryId },
  { name: 'session.continueAfterLimit', entryId, enabled: true },
  { name: 'profile.get', profileId: 'standard' },
  { name: 'profile.save', profile: sampleProfileInput() },
  { name: 'profile.delete', profileId: sampleId('pf', 2) },
  { name: 'profile.setDefault', profileId: sampleId('pf', 2) },
  { name: 'profile.test', profileId: 'standard' },
  { name: 'profile.validate', profile: sampleProfileInput({ id: sampleId('pf', 2) }) },
  { name: 'fs.listDirectory', path: null, showHidden: false },
  { name: 'fs.listDirectory', path: 'D:\\work', showHidden: true },
  // Phase 3 (WP-50 §4.6)
  { name: 'session.stopTask', entryId, taskId: 'task_01' },
  { name: 'plan.list', entryId },
  { name: 'plan.read', entryId, version: 2 },
  { name: 'file.stat', entryId, path: 'D:\\work\\sample\\src\\main.ts' },
  { name: 'file.statMany', entryId, paths: ['D:\\work\\sample\\a.md', 'D:\\work\\sample\\b.md'] },
  { name: 'file.open', entryId, path: 'D:\\work\\sample\\a.md', target: 'editor', line: 12, col: 3 },
  { name: 'file.open', entryId, path: 'D:\\work\\sample', target: 'explorer', line: null, col: null },
  { name: 'files.session', entryId },
  { name: 'files.project', entryId },
  { name: 'editor.detect' },
  // WP-63
  { name: 'session.remove', entryId },
  // WP-64
  { name: 'session.setRemoteControl', entryId, enabled: true },
  { name: 'session.setRemoteControl', entryId, enabled: false },
  // WP-65
  { name: 'session.backgroundTasks', entryId, toolUseId: 'toolu_01' },
  { name: 'session.backgroundTasks', entryId, toolUseId: null },
  { name: 'session.regenerateTitle', entryId },
  { name: 'link.open', url: 'https://claude.ai/code/session_01' },
  // WP-66
  { name: 'session.askSideQuestion', entryId, question: 'Why?', threadId: null },
  { name: 'session.askSideQuestion', entryId, question: 'And then?', threadId: 'px:cv:3' },
  { name: 'session.cancelSideQuestion', entryId, itemId: 'px:cv:3' },
  { name: 'session.deleteSideQuestion', entryId, threadId: 'px:cv:3' },
  { name: 'session.withdrawQueued', entryId, messageUuid: SAMPLE_IDS.messageUuid },
  // WP-67
  { name: 'session.info', entryId, section: 'status' },
  { name: 'session.info', entryId, section: 'export' },
  { name: 'session.mcpAction', entryId, server: 'docs', action: 'reconnect' },
  { name: 'session.mcpAction', entryId, server: 'docs', action: 'disable' },
  { name: 'session.reload', entryId, what: 'skills' },
  { name: 'session.reload', entryId, what: 'plugins' },
  // WP-69
  { name: 'session.subagentTranscript', entryId, agentId: 'a655391549dc96788', conversationId: null, offset: null, limit: 100 },
  {
    name: 'session.subagentTranscript',
    entryId,
    agentId: 'task_toolu_fake-1',
    conversationId: SAMPLE_IDS.conversation,
    offset: 40,
    limit: 200,
  },
  // WP-70
  { name: 'profile.login', profileId: 'standard' },
  { name: 'profile.loginCode', profileId: sampleId('pf', 2), code: 'abc123#fake-state' },
  { name: 'profile.loginCancel', profileId: 'standard' },
  { name: 'session.setOutputStyle', entryId, style: 'Explanatory' },
];

const clientMessages: ClientMessage[] = [
  sampleClientHello(),
  { type: 'presence', presence: samplePresence({ focused: false }) },
  { type: 'subscribe', entryId, sinceSeq: 12 },
  { type: 'subscribe', entryId },
  { type: 'unsubscribe', entryId },
  ...commands.map((cmd, i): ClientMessage => ({
    type: 'cmd',
    cmdId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    cmd,
  })),
];

const serverMessages: ServerMessage[] = [
  sampleHello(),
  { type: 'host.state', host: sampleHostState() },
  { type: 'summaries.snapshot', summaries: [sampleSummary()] },
  { type: 'summary.upsert', summary: sampleSummary({ title: 'Renamed' }) },
  { type: 'summary.remove', entryId },
  sampleSessionSnapshot({ decisions: [sampleDecisions.permission()] }),
  {
    type: 'session.ops',
    entryId,
    ops: [
      {
        seq: 6,
        at: sampleTime(6),
        op: { op: 'item.upsert', item: sampleItems.assistantText({ streaming: true, text: '' }) },
      },
      {
        seq: 7,
        at: sampleTime(7),
        op: { op: 'item.delta', itemId: sampleItems.assistantText().id, field: 'text', append: 'O' },
      },
      { seq: 8, at: sampleTime(8), op: { op: 'item.remove', itemId: 'x' } },
      {
        seq: 9,
        at: sampleTime(9),
        op: {
          op: 'conversation.reset',
          conversationId: `cv_${'2'.repeat(32)}`,
          previousConversationId: SAMPLE_IDS.conversation,
          trigger: 'clear',
          hasEarlier: false,
        },
      },
      { seq: 10, at: sampleTime(10), op: { op: 'decision.upsert', decision: sampleDecisions.question() } },
      {
        seq: 11,
        at: sampleTime(11),
        op: {
          op: 'decision.resolved',
          decisionId: SAMPLE_IDS.decision,
          outcome: sampleOutcomes.answered,
          byClientId: SAMPLE_IDS.client,
          at: sampleTime(11),
        },
      },
      {
        seq: 12,
        at: sampleTime(12),
        op: { op: 'detail.patch', patch: { promptSuggestion: 'Run the tests' } },
      },
    ],
  },
  { type: 'session.ops', entryId, ops: [] },
  { type: 'session.unavailable', entryId, error: { code: 'ENTRY_NOT_FOUND', params: {} } },
  { type: 'ack', cmdId: SAMPLE_IDS.cmdId, ok: true, result: { messageUuid: SAMPLE_IDS.messageUuid } },
  {
    type: 'ack',
    cmdId: SAMPLE_IDS.cmdId,
    ok: false,
    error: { code: 'DECISION_ALREADY_RESOLVED', params: {} },
  },
  { type: 'error', error: { code: 'INVALID_MESSAGE', params: {} }, inReplyTo: null },
  {
    type: 'notify',
    notification: {
      id: 'n1',
      kind: 'plan',
      entryId,
      title: 'Sample session',
      delivery: 'system',
      at: sampleTime(),
    },
  },
  { type: 'notify.clear', entryId },
];

describe('client messages', () => {
  it.each(clientMessages.map((m) => [m.type === 'cmd' ? `cmd ${m.cmd.name}` : m.type, m] as const))(
    '%s',
    (_name, message) => {
      const parsed = parseClientMessage(JSON.stringify(message));
      expect(parsed).toEqual({ ok: true, message });
    },
  );

  it('covers every command name', () => {
    const names = commandSchema.options.map((option) => option.shape.name.value);
    expect([...new Set(commands.map((c) => c.name))].sort()).toEqual([...names].sort());
  });

  it('covers every client message type', () => {
    const types = clientMessageSchema.options.map((option) => option.shape.type.value);
    expect([...new Set(clientMessages.map((m) => m.type))].sort()).toEqual([...types].sort());
  });

  it('presence: systemNotifications is optional and additive (WP22-03)', () => {
    const older = { type: 'presence', presence: samplePresence() };
    expect(parseClientMessage(JSON.stringify(older))).toEqual({ ok: true, message: older });
    const newer = { type: 'presence', presence: samplePresence({ systemNotifications: false }) };
    expect(parseClientMessage(JSON.stringify(newer))).toEqual({ ok: true, message: newer });
    const invalid = { type: 'presence', presence: { ...samplePresence(), systemNotifications: 'no' } };
    expect(parseClientMessage(JSON.stringify(invalid)).ok).toBe(false);
  });

  it('fills command defaults (priority next, attachments [], pastes [])', () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: 'cmd',
        cmdId: SAMPLE_IDS.cmdId,
        cmd: { name: 'session.sendPrompt', entryId, prompt: { text: 'x' } },
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      message: { cmd: { priority: 'next', prompt: { attachments: [], pastes: [] } } },
    });
  });

  it('file.open: line/col default to null; target and positive positions are checked', () => {
    const open = (cmd: Record<string, unknown>) =>
      parseClientMessage(
        JSON.stringify({
          type: 'cmd',
          cmdId: SAMPLE_IDS.cmdId,
          cmd: { name: 'file.open', entryId, path: 'D:\\work\\a.md', ...cmd },
        }),
      );
    expect(open({ target: 'default' })).toMatchObject({
      ok: true,
      message: { cmd: { target: 'default', line: null, col: null } },
    });
    expect(open({ target: 'browser' }).ok).toBe(false);
    expect(open({ target: 'editor', line: 0 }).ok).toBe(false);
    expect(open({ target: 'editor', path: '' }).ok).toBe(false);
  });

  it('file.statMany: 1 … LIMITS.fileStatBatchMax paths', () => {
    const statMany = (count: number) =>
      parseClientMessage(
        JSON.stringify({
          type: 'cmd',
          cmdId: SAMPLE_IDS.cmdId,
          cmd: {
            name: 'file.statMany',
            entryId,
            paths: Array.from({ length: count }, () => 'D:\\work\\a.md'),
          },
        }),
      ).ok;
    expect(statMany(0)).toBe(false);
    expect(statMany(1)).toBe(true);
    expect(statMany(LIMITS.fileStatBatchMax)).toBe(true);
    expect(statMany(LIMITS.fileStatBatchMax + 1)).toBe(false);
  });

  it('pastes per prompt are capped (LIMITS.pastesMax) and never empty', () => {
    const prompt = (pastes: string[]) =>
      parseClientMessage(
        JSON.stringify({
          type: 'cmd',
          cmdId: SAMPLE_IDS.cmdId,
          cmd: { name: 'session.sendPrompt', entryId, prompt: { text: 'x', pastes } },
        }),
      ).ok;
    expect(prompt(Array.from({ length: LIMITS.pastesMax }, () => 'x'))).toBe(true);
    expect(prompt(Array.from({ length: LIMITS.pastesMax + 1 }, () => 'x'))).toBe(false);
    expect(prompt([''])).toBe(false);
  });

  it('settings.update does not inject defaults into the patch', () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: 'cmd',
        cmdId: SAMPLE_IDS.cmdId,
        cmd: { name: 'settings.update', patch: { theme: 'light' } },
      }),
    );
    expect(parsed.ok && parsed.message.type === 'cmd' ? parsed.message.cmd : null).toEqual({
      name: 'settings.update',
      patch: { theme: 'light' },
    });
  });

  it('invalid JSON → INVALID_MESSAGE without cmdId', () => {
    const parsed = parseClientMessage('{nope');
    expect(parsed).toMatchObject({ ok: false, cmdId: null, error: { code: 'INVALID_MESSAGE' } });
  });

  it('unknown client message type → INVALID_MESSAGE (client → server is strict)', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'whatever' }))).toMatchObject({
      ok: false,
      cmdId: null,
      error: { code: 'INVALID_MESSAGE' },
    });
  });

  it('invalid command with a valid cmdId → VALIDATION_FAILED + cmdId + path', () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: 'cmd',
        cmdId: SAMPLE_IDS.cmdId,
        cmd: { name: 'session.interrupt', entryId: 'en_bad' },
      }),
    );
    expect(parsed).toMatchObject({
      ok: false,
      cmdId: SAMPLE_IDS.cmdId,
      error: { code: 'VALIDATION_FAILED', params: { path: 'cmd.entryId' } },
    });
  });

  it('unknown command name with a valid cmdId → VALIDATION_FAILED', () => {
    const parsed = parseClientMessage(
      JSON.stringify({ type: 'cmd', cmdId: SAMPLE_IDS.cmdId, cmd: { name: 'session.fly' } }),
    );
    expect(parsed).toMatchObject({
      ok: false,
      cmdId: SAMPLE_IDS.cmdId,
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  it('invalid cmdId → INVALID_MESSAGE without cmdId', () => {
    const parsed = parseClientMessage(
      JSON.stringify({ type: 'cmd', cmdId: 'nope', cmd: { name: 'server.shutdown' } }),
    );
    expect(parsed).toMatchObject({ ok: false, cmdId: null, error: { code: 'INVALID_MESSAGE' } });
  });

  it.each([
    ['empty text', { text: '' }],
    ['whitespace only', { text: '  \n ' }],
  ])('rejects an empty prompt (%s)', (_name, prompt) => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: 'cmd',
        cmdId: SAMPLE_IDS.cmdId,
        cmd: { name: 'session.sendPrompt', entryId, prompt },
      }),
    );
    expect(parsed).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('accepts an attachment-only prompt', () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: 'cmd',
        cmdId: SAMPLE_IDS.cmdId,
        cmd: {
          name: 'session.sendPrompt',
          entryId,
          prompt: { text: '', attachments: [{ blobId: SAMPLE_IDS.blob }] },
        },
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it('model names must not look like CLI flags (R0-09) and are length-capped (R0-08)', () => {
    const setModel = (model: string | null) =>
      parseClientMessage(
        JSON.stringify({
          type: 'cmd',
          cmdId: SAMPLE_IDS.cmdId,
          cmd: { name: 'session.setModel', entryId, model },
        }),
      ).ok;
    expect(setModel('sonnet[1m]')).toBe(true);
    expect(setModel(null)).toBe(true);
    expect(setModel('--dangerously-skip-permissions')).toBe(false);
    expect(setModel('x'.repeat(LIMITS.modelChars + 1))).toBe(false);
    const create = (model: string) =>
      parseClientMessage(
        JSON.stringify({
          type: 'cmd',
          cmdId: SAMPLE_IDS.cmdId,
          cmd: { name: 'session.create', cwd: 'D:\\x', model },
        }),
      ).ok;
    expect(create('haiku')).toBe(true);
    expect(create('-p')).toBe(false);
  });

  it('caps the build id of clientHello (R0-08)', () => {
    const hello = (buildId: string) => parseClientMessage(JSON.stringify(sampleClientHello({ buildId }))).ok;
    expect(hello('0.0.0+6d02d1a4a1cf.dirty-1a2b3c4d')).toBe(true);
    expect(hello('x'.repeat(LIMITS.buildIdChars + 1))).toBe(false);
  });

  it('rejects a blank rename title but accepts null (auto title)', () => {
    const rename = (title: string | null) =>
      parseClientMessage(
        JSON.stringify({
          type: 'cmd',
          cmdId: SAMPLE_IDS.cmdId,
          cmd: { name: 'session.rename', entryId, title },
        }),
      ).ok;
    expect(rename('   ')).toBe(false);
    expect(rename(null)).toBe(true);
  });
});

describe('server messages', () => {
  it.each(serverMessages.map((m) => [m.type, m] as const))('%s', (_name, message) => {
    expect(parseServerMessage(JSON.stringify(message))).toEqual({ ok: true, message });
  });

  it('SERVER_MESSAGE_TYPES lists exactly the union members', () => {
    const types = serverMessageSchema.options.flatMap((option) =>
      'shape' in option ? [option.shape.type.value] : option.options.map((o) => o.shape.type.value),
    );
    expect([...new Set(types)].sort()).toEqual([...SERVER_MESSAGE_TYPES].sort());
    expect([...new Set(serverMessages.map((m) => m.type))].sort()).toEqual([...SERVER_MESSAGE_TYPES].sort());
  });

  it('unknown type → ignored (forward compatible)', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'brand.new', x: 1 }))).toEqual({
      ok: 'ignored',
      type: 'brand.new',
    });
  });

  it('invalid known message → INVALID_MESSAGE', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'hello', protocolVersion: 'x' }))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_MESSAGE' },
    });
    expect(parseServerMessage('nope')).toMatchObject({ ok: false });
    expect(parseServerMessage(JSON.stringify([1, 2]))).toMatchObject({ ok: false });
  });

  it('unknown extra fields are stripped (tolerant)', () => {
    const parsed = parseServerMessage(JSON.stringify({ ...sampleHello(), futureField: true }));
    expect(parsed).toEqual({ ok: true, message: sampleHello() });
  });

  it('hello carries the current protocol version in the samples', () => {
    expect(sampleHello().protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe('command results', () => {
  it('commandResultSchemas has exactly one schema per command name', () => {
    const names = commandSchema.options.map((option) => option.shape.name.value);
    expect(Object.keys(commandResultSchemas).sort()).toEqual([...names].sort());
  });

  it('parseCommandResult validates per command', () => {
    expect(parseCommandResult('session.sendPrompt', { messageUuid: SAMPLE_IDS.messageUuid })).toEqual({
      messageUuid: SAMPLE_IDS.messageUuid,
    });
    expect(parseCommandResult('session.sendPrompt', { messageUuid: 'x' })).toBeNull();
    expect(parseCommandResult('decision.respond', { outcome: sampleOutcomes.plan_approved })).toEqual({
      outcome: sampleOutcomes.plan_approved,
    });
    expect(parseCommandResult('session.getContext', { context: sampleContextBreakdown() })).not.toBeNull();
    expect(parseCommandResult('session.refreshModels', { models: [sampleModelOption()] })).not.toBeNull();
    expect(
      parseCommandResult('transcript.loadEarlier', { items: [sampleItems.userMessage()], hasEarlier: true }),
    ).not.toBeNull();
    expect(parseCommandResult('session.close', {})).toEqual({});
    expect(parseCommandResult('server.shutdown', { sessionsStopped: -1 })).toBeNull();
  });

  it('Phase 2 results (WP-30 §4.6)', () => {
    expect(parseCommandResult('session.openExternal', { pid: 4242 })).toEqual({ pid: 4242 });
    expect(parseCommandResult('session.openExternal', { pid: null })).toEqual({ pid: null });
    expect(parseCommandResult('session.reclaim', { importedItems: -1 })).toBeNull();
    expect(
      parseCommandResult('session.consoleCommand', {
        command: "& 'C:\\c\\claude.exe' --resume x",
        sessionId: 'x',
      }),
    ).not.toBeNull();
    expect(parseCommandResult('session.continueAfterLimit', { continueAt: sampleTime(60) })).not.toBeNull();
    expect(
      parseCommandResult('profile.get', {
        profile: sampleProfile(),
        issues: [sampleProfileIssue()],
        entryCount: 2,
      }),
    ).not.toBeNull();
    expect(parseCommandResult('profile.save', { profileId: sampleId('pf', 3) })).not.toBeNull();
    expect(parseCommandResult('profile.save', { profileId: 'pf_bad' })).toBeNull();
    expect(parseCommandResult('profile.test', { claude: sampleClaudeInstallStatus() })).not.toBeNull();
    expect(parseCommandResult('profile.validate', { issues: [] })).toEqual({ issues: [] });
    expect(parseCommandResult('fs.listDirectory', sampleFsListing())).toEqual(sampleFsListing());
  });

  it('WP-65: link.open only takes http(s) links; the new commands answer {}', () => {
    const cmd = (url: string) => ({ type: 'cmd', cmdId: SAMPLE_IDS.cmdId, cmd: { name: 'link.open', url } });
    expect(parseClientMessage(JSON.stringify(cmd('http://localhost:3000/a?b#c'))).ok).toBe(true);
    for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'https://', 'https://a b', 'https://user@host/x', 'ftp://x']) {
      expect(parseClientMessage(JSON.stringify(cmd(bad))).ok).toBe(false);
    }
    expect(parseCommandResult('link.open', {})).toEqual({});
    expect(parseCommandResult('session.backgroundTasks', {})).toEqual({});
    expect(parseCommandResult('session.regenerateTitle', {})).toEqual({});
  });

  it('WP-70: login commands are host commands; code and style are trimmed and bounded; results are {}', () => {
    expect(isHostCommand({ name: 'profile.login', profileId: 'standard' })).toBe(true);
    expect(isHostCommand({ name: 'profile.loginCode', profileId: 'standard', code: 'x' })).toBe(true);
    expect(isHostCommand({ name: 'profile.loginCancel', profileId: 'standard' })).toBe(true);
    expect(isHostCommand({ name: 'session.setOutputStyle', entryId, style: 'Concise' })).toBe(false);
    const send = (cmd: unknown) => parseClientMessage(JSON.stringify({ type: 'cmd', cmdId: SAMPLE_IDS.cmdId, cmd }));
    expect(send({ name: 'profile.loginCode', profileId: 'standard', code: '  abc#def  ' }).ok).toBe(true);
    expect(send({ name: 'profile.loginCode', profileId: 'standard', code: '   ' }).ok).toBe(false);
    expect(send({ name: 'profile.loginCode', profileId: 'standard', code: 'x'.repeat(LOGIN_CODE_CHARS + 1) }).ok).toBe(false);
    expect(send({ name: 'session.setOutputStyle', entryId, style: '' }).ok).toBe(false);
    expect(send({ name: 'session.setOutputStyle', entryId, style: 'x'.repeat(101) }).ok).toBe(false);
    for (const name of ['profile.login', 'profile.loginCode', 'profile.loginCancel', 'session.setOutputStyle'] as const) {
      expect(parseCommandResult(name, {})).toEqual({});
    }
  });

  it('WP-66: side question (trimmed, 1 … LIMITS.sideQuestionChars) and withdraw results', () => {
    const ask = (question: string) =>
      parseClientMessage(
        JSON.stringify({
          type: 'cmd',
          cmdId: SAMPLE_IDS.cmdId,
          cmd: { name: 'session.askSideQuestion', entryId, question, threadId: null },
        }),
      );
    expect(ask('   ').ok).toBe(false);
    expect(ask('x'.repeat(LIMITS.sideQuestionChars + 1)).ok).toBe(false);
    const ok = ask('  why?  ');
    expect(ok.ok && ok.message.type === 'cmd' && ok.message.cmd.name === 'session.askSideQuestion').toBe(true);
    if (ok.ok && ok.message.type === 'cmd' && ok.message.cmd.name === 'session.askSideQuestion') {
      expect(ok.message.cmd.question).toBe('why?');
    }
    expect(parseCommandResult('session.askSideQuestion', { itemId: 'px:cv:1' })).toEqual({ itemId: 'px:cv:1' });
    expect(parseCommandResult('session.cancelSideQuestion', {})).toEqual({});
    expect(parseCommandResult('session.deleteSideQuestion', {})).toEqual({});
    expect(parseCommandResult('session.withdrawQueued', { withdrawn: true, text: 'x' })).toEqual({
      withdrawn: true,
      text: 'x',
    });
    expect(parseCommandResult('session.withdrawQueued', { withdrawn: true })).toBeNull();
  });

  it('WP-67: session info, MCP actions and reloads (sections, actions, results)', () => {
    const cmd = (body: Record<string, unknown>) =>
      parseClientMessage(JSON.stringify({ type: 'cmd', cmdId: SAMPLE_IDS.cmdId, cmd: { entryId, ...body } })).ok;
    expect(cmd({ name: 'session.info', section: 'status' })).toBe(true);
    expect(cmd({ name: 'session.info', section: 'account' })).toBe(false);
    expect(cmd({ name: 'session.mcpAction', server: '', action: 'reconnect' })).toBe(false);
    expect(cmd({ name: 'session.mcpAction', server: 'docs', action: 'restart' })).toBe(false);
    expect(cmd({ name: 'session.reload', what: 'agents' })).toBe(false);
    expect(parseCommandResult('session.info', { available: false, data: null })).toEqual({ available: false, data: null });
    const status = { section: 'status', groups: [{ title: 'Session', rows: [{ label: null, value: 'x' }] }], extra: [] };
    expect(parseCommandResult('session.info', { available: true, data: status })).toEqual({ available: true, data: status });
    expect(parseCommandResult('session.info', { available: true, data: { section: 'status' } })).toBeNull();
    expect(
      parseCommandResult('session.info', {
        available: true,
        data: { section: 'export', text: 'hi', filename: '', totalChars: 2, truncated: false },
      }),
    ).toBeNull();
    expect(parseCommandResult('session.mcpAction', {})).toEqual({});
    expect(parseCommandResult('session.reload', {})).toEqual({});
  });

  it('WP-69: subagent transcript (agent id without path characters, defaults, page result)', () => {
    const parse = (body: Record<string, unknown>) =>
      parseClientMessage(JSON.stringify({ type: 'cmd', cmdId: SAMPLE_IDS.cmdId, cmd: { entryId, ...body } }));
    const ok = parse({ name: 'session.subagentTranscript', agentId: 'a655391549dc96788' });
    expect(ok).toMatchObject({
      ok: true,
      message: { cmd: { conversationId: null, offset: null, limit: SUBAGENT_TRANSCRIPT_LIMITS.pageItems } },
    });
    for (const agentId of ['', '..\\x', 'a/b', 'a b', 'x'.repeat(SUBAGENT_TRANSCRIPT_LIMITS.agentIdChars + 1)]) {
      expect(parse({ name: 'session.subagentTranscript', agentId }).ok).toBe(false);
    }
    const tooMany = SUBAGENT_TRANSCRIPT_LIMITS.maxPageItems + 1;
    expect(parse({ name: 'session.subagentTranscript', agentId: 'a1', limit: tooMany }).ok).toBe(false);
    expect(parse({ name: 'session.subagentTranscript', agentId: 'a1', offset: -1 }).ok).toBe(false);
    const page = { items: [sampleItems.assistantText()], offset: 3, total: 4, running: true };
    expect(parseCommandResult('session.subagentTranscript', page)).toEqual(page);
    expect(parseCommandResult('session.subagentTranscript', { items: [], offset: 0, total: 0 })).toBeNull();
  });

  it('Phase 3 results (WP-50 §4.6)', () => {
    expect(parseCommandResult('session.stopTask', {})).toEqual({});
    expect(parseCommandResult('plan.list', { versions: [samplePlanVersionInfo()] })).toEqual({
      versions: [samplePlanVersionInfo()],
    });
    expect(
      parseCommandResult('plan.list', {
        versions: [
          samplePlanVersionInfo({ resolvedAt: sampleTime(9), outcome: sampleOutcomes.plan_approved }),
        ],
      }),
    ).not.toBeNull();
    expect(parseCommandResult('plan.read', { version: 1, text: '# Plan' })).not.toBeNull();
    expect(parseCommandResult('plan.read', { version: 0, text: '' })).toBeNull();
    expect(parseCommandResult('file.stat', { file: sampleFileInfo() })).toEqual({ file: sampleFileInfo() });
    expect(parseCommandResult('file.stat', { file: { ...sampleFileInfo(), kind: 'archive' } })).toBeNull();
    const results = [sampleFileStatResult(), sampleFileStatResult(false)];
    expect(parseCommandResult('file.statMany', { results })).toEqual({ results });
    expect(parseCommandResult('file.open', {})).toEqual({});
    expect(
      parseCommandResult('files.session', { files: [sampleSessionFile()], truncated: false }),
    ).not.toBeNull();
    expect(
      parseCommandResult('files.project', {
        root: 'D:\\work\\sample',
        files: ['src/main.ts', 'README.md'],
        truncated: false,
        source: 'git',
      }),
    ).not.toBeNull();
    expect(
      parseCommandResult('files.project', { root: 'x', files: [], truncated: false, source: 'svn' }),
    ).toBeNull();
    expect(
      parseCommandResult('editor.detect', {
        notepadpp: 'C:\\Program Files\\Notepad++\\notepad++.exe',
        vscode: null,
        custom: { executable: 'D:\\tools\\edit.exe', exists: false },
      }),
    ).not.toBeNull();
  });

  it('host commands: the commands without entryId besides create/settings/shutdown, plus the file service (ADR-140)', () => {
    const withoutEntry = commandSchema.options
      .filter((option) => !('entryId' in option.shape))
      .map((option) => option.shape.name.value)
      .filter((name) => !['session.create', 'settings.update', 'server.shutdown'].includes(name));
    const fileCommands = ['file.stat', 'file.statMany', 'file.open', 'files.session', 'files.project'];
    expect([...withoutEntry, ...fileCommands].sort()).toEqual([...HOST_COMMAND_NAMES].sort());
    expect(isHostCommand({ name: 'fs.listDirectory', path: null, showHidden: false })).toBe(true);
    expect(isHostCommand({ name: 'files.session', entryId })).toBe(true);
    expect(isHostCommand({ name: 'editor.detect' })).toBe(true);
    expect(isHostCommand({ name: 'session.reclaim', entryId })).toBe(false);
    expect(isHostCommand({ name: 'plan.list', entryId })).toBe(false);
  });

  it('attachments per prompt are capped (LIMITS.attachmentsMax)', () => {
    const prompt = (count: number) =>
      parseClientMessage(
        JSON.stringify({
          type: 'cmd',
          cmdId: SAMPLE_IDS.cmdId,
          cmd: {
            name: 'session.sendPrompt',
            entryId,
            prompt: {
              text: '',
              attachments: Array.from({ length: count }, () => ({ blobId: SAMPLE_IDS.blob })),
            },
          },
        }),
      ).ok;
    expect(prompt(LIMITS.attachmentsMax)).toBe(true);
    expect(prompt(LIMITS.attachmentsMax + 1)).toBe(false);
  });

  it('PROTOCOL_VERSION is 3 (Phase 3, ADR-140)', () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});
