import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/common';
import { makeError } from '@shared/errors';
import { parseCommandResult, parseServerMessage, type Command, type ServerMessage } from '@shared/protocol';
import {
  SAMPLE_IDS,
  sampleDecisions,
  sampleDetail,
  sampleFileInfo,
  sampleId,
  sampleClientHello,
  sampleItems,
  sampleSessionSnapshot,
  sampleSummary,
  sampleSystemItems,
  sampleTime,
} from '@shared/samples';
import { SHOWCASE_FILES } from '@web/playground/showcase/files';
import {
  FAKE_FILE_PATHS,
  FAKE_FILE_ROOT,
  FAKE_LOG_LINES,
  FAKE_PLAN_TEXTS,
  FakeHost,
  fakeFileTable,
} from './fake-host';
import { createMemoryTransport } from './transport';

const ENTRY = SAMPLE_IDS.entry;

function connect(transport: ReturnType<typeof createMemoryTransport>) {
  const received: ServerMessage[] = [];
  transport.connect(
    (text) => {
      const parsed = parseServerMessage(text);
      if (parsed.ok === true) received.push(parsed.message);
    },
    () => undefined,
  );
  return received;
}

function command(transport: ReturnType<typeof createMemoryTransport>, cmd: Command, cmdId: string): void {
  transport.send(JSON.stringify({ type: 'cmd', cmdId, cmd }));
}

function ackOf(received: readonly ServerMessage[], cmdId: string) {
  return received.find((message) => message.type === 'ack' && message.cmdId === cmdId);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FakeHost defaults for WP-15/16 demos (R1W-22)', () => {
  it('decision.respond resolves the decision and writes the outcome into the gating tool_call', () => {
    const transport = createMemoryTransport();
    const decision = sampleDecisions.plan();
    const toolCall = sampleItems.toolCall({
      toolUseId: decision.toolUseId,
      toolName: 'ExitPlanMode',
      status: 'awaiting_decision',
      result: null,
      decision: { decisionId: decision.id, kind: 'plan', planVersion: 1, outcome: null },
    });
    const host = new FakeHost({
      transport,
      sessions: [sampleSessionSnapshot({ items: [toolCall], decisions: [decision] })],
    });
    connect(transport);
    command(
      transport,
      {
        name: 'decision.respond',
        entryId: ENTRY,
        decisionId: decision.id,
        response: { kind: 'plan', response: { behavior: 'approve', mode: 'default', editedPlan: null } },
      },
      SAMPLE_IDS.cmdId,
    );
    const view = host.view(ENTRY);
    expect(view?.decisions).toEqual([]);
    expect(view?.items[0]).toMatchObject({
      kind: 'tool_call',
      status: 'done',
      decision: {
        decisionId: decision.id,
        outcome: { type: 'plan_approved', mode: 'default', edited: false },
      },
    });
    host.dispose();
  });

  it('session.interrupt aborts a running stream (aborted, not streaming)', () => {
    vi.useFakeTimers();
    const transport = createMemoryTransport();
    const host = new FakeHost({ transport, sessions: [sampleSessionSnapshot({ items: [] })] });
    connect(transport);
    const item = sampleItems.assistantText({ id: 'live:0', order: 1, text: '', streaming: true });
    host.streamAssistantText(ENTRY, { item, text: 'abcdefghijkl', chunkSize: 3, intervalMs: 10 });
    vi.advanceTimersByTime(25);
    command(transport, { name: 'session.interrupt', entryId: ENTRY }, SAMPLE_IDS.cmdId);
    expect(host.view(ENTRY)?.items[0]).toMatchObject({ text: 'abcdef', streaming: false, aborted: true });
    vi.advanceTimersByTime(100);
    expect(host.view(ENTRY)?.items[0]).toMatchObject({ text: 'abcdef' });
    host.dispose();
  });

  it('transcript.loadEarlier serves the items before the oldest loaded one', () => {
    const transport = createMemoryTransport();
    const count = LIMITS.snapshotItems + 3;
    const items = Array.from({ length: count }, (_, i) =>
      sampleItems.userMessage({ id: `u${String(i + 1)}`, order: i + 1 }),
    );
    const host = new FakeHost({ transport, sessions: [sampleSessionSnapshot({ items })] });
    const received = connect(transport);
    transport.send(JSON.stringify({ type: 'subscribe', entryId: ENTRY }));
    const snapshot = received.find((message) => message.type === 'session.snapshot');
    expect(snapshot).toMatchObject({ hasEarlier: true });
    command(
      transport,
      {
        name: 'transcript.loadEarlier',
        entryId: ENTRY,
        conversationId: SAMPLE_IDS.conversation,
        beforeOrder: 4,
        limit: 2,
      },
      SAMPLE_IDS.cmdId,
    );
    expect(ackOf(received, SAMPLE_IDS.cmdId)).toMatchObject({
      ok: true,
      result: { items: [{ id: 'u2' }, { id: 'u3' }], hasEarlier: true },
    });
    host.dispose();
  });
});

describe('FakeHost Phase 3 commands (WP-54)', () => {
  function setup(options: Partial<ConstructorParameters<typeof FakeHost>[0]> = {}) {
    const transport = createMemoryTransport();
    const host = new FakeHost({ transport, sessions: [sampleSessionSnapshot()], ...options });
    const received = connect(transport);
    let next = 0;
    const run = (cmd: Command) => {
      const cmdId = `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
      command(transport, cmd, cmdId);
      return ackOf(received, cmdId);
    };
    return { host, received, transport, run };
  }

  it('file.stat answers from the table; missing below the root, refused outside, rejected for UNC', () => {
    const { host, run } = setup();
    expect(run({ name: 'file.stat', entryId: ENTRY, path: FAKE_FILE_PATHS.readme })).toMatchObject({
      ok: true,
      result: { file: { path: FAKE_FILE_PATHS.readme, kind: 'markdown', previewable: true, access: 'cwd' } },
    });
    // Case-insensitive lookup, the answer keeps the requested spelling.
    const lower = FAKE_FILE_PATHS.main.toLowerCase();
    expect(run({ name: 'file.stat', entryId: ENTRY, path: lower })).toMatchObject({
      ok: true,
      result: { file: { path: lower, kind: 'text' } },
    });
    expect(run({ name: 'file.stat', entryId: ENTRY, path: FAKE_FILE_PATHS.missing })).toMatchObject({
      ok: false,
      error: { code: 'FILE_NOT_FOUND' },
    });
    expect(run({ name: 'file.stat', entryId: ENTRY, path: FAKE_FILE_PATHS.outside })).toMatchObject({
      ok: false,
      error: { code: 'PATH_NOT_ALLOWED' },
    });
    expect(run({ name: 'file.stat', entryId: ENTRY, path: '\\\\server\\share\\a.md' })).toMatchObject({
      ok: false,
      error: { code: 'PATH_REJECTED' },
    });
    expect(
      run({ name: 'file.stat', entryId: sampleId('en', 77), path: FAKE_FILE_PATHS.readme }),
    ).toMatchObject({
      ok: false,
      error: { code: 'ENTRY_NOT_FOUND' },
    });
    host.dispose();
  });

  it('file.statMany answers every path in order, never failing the command', () => {
    const { host, run } = setup();
    const paths = [
      FAKE_FILE_PATHS.log,
      FAKE_FILE_PATHS.outside,
      FAKE_FILE_PATHS.missing,
      FAKE_FILE_PATHS.plan,
    ];
    expect(run({ name: 'file.statMany', entryId: ENTRY, paths })).toMatchObject({
      ok: true,
      result: {
        results: [
          { path: FAKE_FILE_PATHS.log, ok: true, file: { truncated: true } },
          { path: FAKE_FILE_PATHS.outside, ok: false, error: { code: 'PATH_NOT_ALLOWED' } },
          { path: FAKE_FILE_PATHS.missing, ok: false, error: { code: 'FILE_NOT_FOUND' } },
          { path: FAKE_FILE_PATHS.plan, ok: true, file: { access: 'session' } },
        ],
      },
    });
    host.dispose();
  });

  it('file.open records the call, checks kind and default-program extension, fails on the switch', () => {
    const { host, run } = setup();
    expect(
      run({
        name: 'file.open',
        entryId: ENTRY,
        path: FAKE_FILE_PATHS.main,
        target: 'editor',
        line: 12,
        col: 3,
      }),
    ).toMatchObject({ ok: true });
    expect(host.fileOpens).toEqual([
      { name: 'file.open', entryId: ENTRY, path: FAKE_FILE_PATHS.main, target: 'editor', line: 12, col: 3 },
    ]);
    expect(
      run({
        name: 'file.open',
        entryId: ENTRY,
        path: FAKE_FILE_PATHS.main,
        target: 'default',
        line: null,
        col: null,
      }),
    ).toMatchObject({ ok: false, error: { code: 'FILE_TYPE_BLOCKED' } });
    expect(
      run({
        name: 'file.open',
        entryId: ENTRY,
        path: FAKE_FILE_PATHS.folder,
        target: 'editor',
        line: null,
        col: null,
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(
      run({
        name: 'file.open',
        entryId: ENTRY,
        path: FAKE_FILE_PATHS.folder,
        target: 'explorer',
        line: null,
        col: null,
      }),
    ).toMatchObject({ ok: true });
    host.fileOpenError = makeError('EDITOR_NOT_FOUND');
    expect(
      run({
        name: 'file.open',
        entryId: ENTRY,
        path: FAKE_FILE_PATHS.pdf,
        target: 'default',
        line: null,
        col: null,
      }),
    ).toMatchObject({ ok: false, error: { code: 'EDITOR_NOT_FOUND' } });
    expect(host.fileOpens.map((cmd) => cmd.target)).toEqual(['editor', 'explorer', 'default']);
    host.dispose();
  });

  it('files.session lists the index newest first; files.project lists the root relative with "/"', () => {
    const { host, run } = setup({ summaries: [sampleSummary()] });
    const session = run({ name: 'files.session', entryId: ENTRY });
    expect(session).toMatchObject({ ok: true, result: { truncated: false } });
    const files =
      session?.type === 'ack' && session.ok
        ? (parseCommandResult('files.session', session.result)?.files ?? [])
        : [];
    expect(files[0]?.path).toBe(FAKE_FILE_PATHS.main);
    const times = files.map((file) => Date.parse(file.lastAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(run({ name: 'files.project', entryId: ENTRY })).toMatchObject({
      ok: true,
      result: {
        root: FAKE_FILE_ROOT,
        source: 'git',
        files: [
          'README.md',
          'assets/diagram.png',
          'bin/tool.dat',
          'docs/guide.md',
          'docs/spec.pdf',
          'logs/build.log',
          'package.json',
          'src/main.ts',
        ],
      },
    });
    host.dispose();
  });

  it('editor.detect reports the presets and a custom executable', () => {
    const { host, run } = setup();
    expect(run({ name: 'editor.detect' })).toMatchObject({
      ok: true,
      result: { notepadpp: 'C:\\Program Files\\Notepad++\\notepad++.exe', vscode: null, custom: null },
    });
    host.hostState = {
      ...host.hostState,
      settings: {
        ...host.hostState.settings,
        editor: { preset: 'custom', executable: 'D:\\tools\\edit.exe', args: ['{file}'] },
      },
    };
    expect(run({ name: 'editor.detect' })).toMatchObject({
      ok: true,
      result: { custom: { executable: 'D:\\tools\\edit.exe', exists: true } },
    });
    host.dispose();
  });

  it('plan.list returns two versions, plan.read their texts, PLAN_NOT_FOUND otherwise', () => {
    const { host, run } = setup();
    expect(run({ name: 'plan.list', entryId: ENTRY })).toMatchObject({
      ok: true,
      result: {
        versions: [
          { version: 1, outcome: { type: 'plan_revised' } },
          { version: 2, outcome: null },
        ],
      },
    });
    expect(run({ name: 'plan.read', entryId: ENTRY, version: 1 })).toMatchObject({
      ok: true,
      result: { version: 1, text: FAKE_PLAN_TEXTS[0] },
    });
    expect(run({ name: 'plan.read', entryId: ENTRY, version: 2 })).toMatchObject({
      ok: true,
      result: { version: 2, text: FAKE_PLAN_TEXTS[1] },
    });
    expect(run({ name: 'plan.read', entryId: ENTRY, version: 3 })).toMatchObject({
      ok: false,
      error: { code: 'PLAN_NOT_FOUND' },
    });
    host.dispose();
  });

  it('session.stopTask reports the task as stopped and drops it from the background tasks', () => {
    const task = { ...sampleSystemItems.task_notification().task, status: 'running', endedAt: null };
    const agent = sampleItems.toolCall({ toolName: 'Agent', toolUseId: 'toolu_agent', task });
    const { host, run } = setup({
      sessions: [
        sampleSessionSnapshot({
          items: [agent],
          detail: sampleDetail({
            backgroundTasks: [
              {
                taskId: task.taskId,
                taskType: 'local_bash',
                description: 'Background command',
                subagentType: null,
                parentTaskId: null,
                ambient: false,
              },
            ],
          }),
        }),
      ],
      now: () => sampleTime(60),
    });
    expect(run({ name: 'session.stopTask', entryId: ENTRY, taskId: task.taskId })).toMatchObject({
      ok: true,
    });
    const view = host.view(ENTRY);
    expect(view?.items[0]).toMatchObject({
      task: { taskId: task.taskId, status: 'stopped', endedAt: sampleTime(60) },
    });
    expect(view?.items.at(-1)).toMatchObject({
      kind: 'system',
      event: 'task_notification',
      task: { taskId: task.taskId, status: 'stopped' },
    });
    expect(view?.detail.backgroundTasks).toEqual([]);
    expect(run({ name: 'session.stopTask', entryId: ENTRY, taskId: task.taskId })).toMatchObject({
      ok: false,
      error: { code: 'TASK_NOT_FOUND' },
    });
    host.dispose();
  });

  it('emitFileToolCall pushes a finished tool call, touches the file and updates the index', () => {
    const { host, run } = setup({ now: () => sampleTime(90) });
    const before = host.file(FAKE_FILE_PATHS.guide)?.info.mtimeMs ?? 0;
    const item = host.emitFileToolCall(ENTRY, { toolName: 'Write', path: FAKE_FILE_PATHS.guide });
    expect(host.view(ENTRY)?.items.at(-1)).toMatchObject({
      kind: 'tool_call',
      toolUseId: item.toolUseId,
      toolName: 'Write',
      status: 'done',
      input: { file_path: FAKE_FILE_PATHS.guide },
      result: { isError: false },
    });
    expect(host.file(FAKE_FILE_PATHS.guide)?.info.mtimeMs).toBe(before + 1000);
    expect(host.sessionFilesOf(ENTRY)[0]).toMatchObject({
      path: FAKE_FILE_PATHS.guide,
      ops: ['written'],
      count: 2,
      lastAt: sampleTime(90),
      lastToolUseId: item.toolUseId,
    });
    expect(run({ name: 'files.session', entryId: ENTRY })).toMatchObject({ ok: true });
    // A Read does not change the file; a NotebookEdit uses notebook_path.
    host.emitFileToolCall(ENTRY, { toolName: 'Read', path: FAKE_FILE_PATHS.readme });
    expect(host.file(FAKE_FILE_PATHS.readme)?.info.mtimeMs).toBe(sampleFileInfo().mtimeMs);
    host.emitFileToolCall(ENTRY, {
      toolName: 'NotebookEdit',
      path: 'D:\\work\\sample\\nb.ipynb',
      status: 'running',
    });
    expect(host.view(ENTRY)?.items.at(-1)).toMatchObject({
      input: { notebook_path: 'D:\\work\\sample\\nb.ipynb' },
      status: 'running',
      result: null,
    });
    host.dispose();
  });

  it('touchFile changes mtime and text; fileText serves the table texts', () => {
    const { host } = setup();
    expect(host.fileText(FAKE_FILE_PATHS.readme)).toContain('# Sample project');
    expect(host.fileText(FAKE_FILE_PATHS.log)?.split('\n')).toHaveLength(FAKE_LOG_LINES);
    expect(host.fileText(FAKE_FILE_PATHS.image)).toBeNull();
    const info = host.touchFile(FAKE_FILE_PATHS.main, { text: 'ä' });
    expect(info).toMatchObject({ bytes: 2, mtimeMs: sampleFileInfo().mtimeMs + 1000 });
    expect(host.fileText(FAKE_FILE_PATHS.main)).toBe('ä');
    expect(host.touchFile(FAKE_FILE_PATHS.missing)).toBeNull();
    host.dispose();
  });

  it('the table carries the README showcase files with their texts and times (WP-68)', () => {
    const { host } = setup();
    const table = fakeFileTable();
    for (const file of SHOWCASE_FILES) {
      expect(host.fileText(file.path), file.path).toBe(file.text);
      const info = table.find((candidate) => candidate.info.path === file.path)?.info;
      expect(info, file.path).toMatchObject({ kind: file.kind, mtimeMs: file.mtimeMs, previewable: true });
    }
    // The sample files stay ahead of the showcase files.
    expect(table.slice(0, -SHOWCASE_FILES.length).map((file) => file.info.path)).toContain(
      FAKE_FILE_PATHS.readme,
    );
    host.dispose();
  });
});

describe('FakeHost session.remove (WP-63 §1.3)', () => {
  it('like the hub: summary.remove for all, session.unavailable for the subscriber, then ENTRY_NOT_FOUND', () => {
    const transport = createMemoryTransport();
    const host = new FakeHost({
      transport,
      summaries: [sampleSummary()],
      sessions: [sampleSessionSnapshot()],
    });
    const received = connect(transport);
    transport.send(JSON.stringify(sampleClientHello()));
    transport.send(JSON.stringify({ type: 'subscribe', entryId: ENTRY }));
    command(transport, { name: 'session.remove', entryId: ENTRY }, SAMPLE_IDS.cmdId);
    expect(ackOf(received, SAMPLE_IDS.cmdId)).toMatchObject({ ok: true, result: {} });
    expect(parseCommandResult('session.remove', {})).toEqual({});
    expect(received).toContainEqual({ type: 'summary.remove', entryId: ENTRY });
    expect(received).toContainEqual({
      type: 'session.unavailable',
      entryId: ENTRY,
      error: makeError('ENTRY_NOT_FOUND'),
    });
    expect(host.view(ENTRY)).toBeNull();

    const again = '00000000-0000-4000-8000-000000000099';
    command(transport, { name: 'session.remove', entryId: ENTRY }, again);
    expect(ackOf(received, again)).toMatchObject({ ok: false, error: { code: 'ENTRY_NOT_FOUND' } });
    host.dispose();
  });
});
