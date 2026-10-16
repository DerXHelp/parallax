import { describe, expect, it } from 'vitest';
import { LIMITS } from './common';
import {
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  clientMessageSchema,
  commandResultSchemas,
  commandSchema,
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
  sampleClientHello,
  sampleContextBreakdown,
  sampleDecisions,
  sampleHello,
  sampleHostState,
  sampleItems,
  sampleModelOption,
  sampleOutcomes,
  samplePresence,
  sampleResponses,
  sampleSessionSnapshot,
  sampleSummary,
  sampleTime,
} from './samples';

const entryId = SAMPLE_IDS.entry;

/** One valid command per name. */
const commands: Command[] = [
  { name: 'session.create', cwd: 'D:\\work\\x', prompt: { text: 'Hello', attachments: [] } },
  { name: 'session.sendPrompt', entryId, prompt: { text: 'Next', attachments: [] }, priority: 'now' },
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
    expect(commands.map((c) => c.name).sort()).toEqual([...names].sort());
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

  it('fills command defaults (priority next, attachments [])', () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: 'cmd',
        cmdId: SAMPLE_IDS.cmdId,
        cmd: { name: 'session.sendPrompt', entryId, prompt: { text: 'x' } },
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      message: { cmd: { priority: 'next', prompt: { attachments: [] } } },
    });
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
});
