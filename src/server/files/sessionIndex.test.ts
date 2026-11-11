import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS, type ConversationId } from '@shared/common';
import { sessionFilesFileSchema, type ToolCallItem, type TranscriptItem } from '@shared/model';
import { windowsPathKey } from '@shared/paths';
import type { SessionOp } from '@shared/protocol';
import { SAMPLE_IDS, sampleId, sampleItems, sampleSystemItems, sampleTime } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { entryDir } from '../store/decisions';
import { SESSION_FILES_FILE, createSessionIndex, recordsOfItem } from './sessionIndex';
import { entryLookup, fakeTranscripts } from './testing';

const ENTRY = SAMPLE_IDS.entry;
const CONV = SAMPLE_IDS.conversation;
const CONV2: ConversationId = sampleId('cv', 2);

let toolSeq = 0;
function tool(toolName: string, input: ToolCallItem['input'], p: Partial<ToolCallItem> = {}): ToolCallItem {
  toolSeq += 1;
  const id = `toolu_${String(toolSeq).padStart(6, '0')}`;
  return sampleItems.toolCall({ id: `msg:${id}`, toolUseId: id, toolName, input, order: toolSeq, ...p });
}

const upsert = (item: TranscriptItem): SessionOp => ({ op: 'item.upsert', item });

async function setup(
  transcripts: Record<string, TranscriptItem[]> = {},
  conversationIds: ConversationId[] = [CONV],
) {
  const home = await makeTempHome('files-index-');
  const store = fakeTranscripts(transcripts);
  const entries = entryLookup({
    [ENTRY]: { cwd: 'D:\\work\\sample', additionalDirectories: [], conversationIds },
  });
  const index = createSessionIndex({ home, entries, transcripts: store, debounceMs: 60_000 });
  return { home, store, entries, index };
}

describe('recordsOfItem (ADR-145)', () => {
  it.each([
    ['Read', { file_path: 'D:\\work\\a.ts' }, 'read'],
    ['Write', { file_path: 'D:\\work\\a.ts', content: 'x' }, 'written'],
    ['Edit', { file_path: 'D:\\work\\a.ts', old_string: 'a', new_string: 'b' }, 'edited'],
    ['MultiEdit', { file_path: 'D:\\work\\a.ts', edits: [] }, 'edited'],
    ['NotebookEdit', { notebook_path: 'D:\\work\\a.ipynb', new_source: '' }, 'edited'],
    ['ExitPlanMode', { plan: '# Plan', planFilePath: 'C:\\Users\\u\\.claude\\plans\\p.md' }, 'plan'],
  ])('%s → %s', (toolName, input, op) => {
    const records = recordsOfItem(tool(toolName, input));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ op });
  });

  it.each([
    ['a running call', tool('Read', { file_path: 'D:\\work\\a.ts' }, { status: 'running' })],
    ['a relative path', tool('Read', { file_path: 'src\\a.ts' })],
    ['a UNC path', tool('Read', { file_path: '\\\\host\\share\\a.ts' })],
    ['a device path', tool('Write', { file_path: '\\\\?\\C:\\a.ts' })],
    ['an over-long path', tool('Read', { file_path: `C:\\${'a'.repeat(LIMITS.pathChars)}` })],
    ['a wrong input type', tool('Read', { file_path: 42 })],
    ['Grep (on purpose not)', tool('Grep', { pattern: 'x', path: 'D:\\work' })],
    ['Bash', tool('Bash', { command: 'type D:\\work\\a.ts' })],
  ])('nothing for %s', (_name, item) => {
    expect(recordsOfItem(item)).toEqual([]);
  });

  it('task.outputFile → output (any status), also from task_notification; subagent items count', () => {
    const task = sampleSystemItems.task_notification().task;
    const running = tool('Task', { prompt: 'x' }, { status: 'running', task });
    expect(recordsOfItem(running)).toEqual([
      expect.objectContaining({ op: 'output', path: task.outputFile, toolUseId: running.toolUseId }),
    ]);
    expect(recordsOfItem(sampleSystemItems.task_notification())).toEqual([
      expect.objectContaining({ op: 'output', path: task.outputFile, toolUseId: null }),
    ]);
    const sub = tool('Read', { file_path: 'D:\\work\\b.ts' }, { parentToolUseId: 'toolu_parent' });
    expect(recordsOfItem(sub)).toEqual([expect.objectContaining({ op: 'read' })]);
  });
});

describe('createSessionIndex', () => {
  it('observe: one row per file, ops distinct in first-seen order, newest lastAt first; wroteFiles for writes', async () => {
    const { index } = await setup();
    const read = tool('Read', { file_path: 'D:\\work\\a.ts' }, { at: sampleTime(10) });
    expect(index.observe(ENTRY, [upsert(read)])).toEqual({ wroteFiles: false });
    const edit = tool('Edit', { file_path: 'd:/WORK/a.ts' }, { at: sampleTime(20) });
    expect(index.observe(ENTRY, [upsert(edit)])).toEqual({ wroteFiles: true });
    const other = tool('Write', { file_path: 'D:\\work\\b.ts' }, { at: sampleTime(15) });
    index.observe(ENTRY, [upsert(other)]);
    const files = await index.list(ENTRY);
    expect(files.map((file) => file.path)).toEqual(['D:\\work\\a.ts', 'D:\\work\\b.ts']);
    expect(files[0]).toEqual({
      path: 'D:\\work\\a.ts',
      ops: ['read', 'edited'],
      count: 2,
      firstAt: sampleTime(10),
      lastAt: sampleTime(20),
      lastToolUseId: edit.toolUseId,
      conversationId: CONV,
    });
    expect((await index.keys(ENTRY)).has(windowsPathKey('D:\\WORK\\A.TS'))).toBe(true);
    expect((await index.keys(ENTRY)).has(windowsPathKey('D:\\work\\c.ts'))).toBe(false);
  });

  it('the same tool call counts once (re-upserts, restarts); a conversation.reset switches the conversation', async () => {
    const { index } = await setup();
    const read = tool('Read', { file_path: 'D:\\work\\a.ts' }, { at: sampleTime(10) });
    index.observe(ENTRY, [upsert(read), upsert(read)]);
    index.observe(ENTRY, [upsert(read)]);
    index.observe(ENTRY, [
      {
        op: 'conversation.reset',
        conversationId: CONV2,
        previousConversationId: CONV,
        trigger: 'clear',
        hasEarlier: false,
      },
      upsert(tool('Read', { file_path: 'D:\\work\\a.ts' }, { at: sampleTime(30) })),
    ]);
    const [file] = await index.list(ENTRY);
    expect(file).toMatchObject({ count: 2, lastAt: sampleTime(30), conversationId: CONV2 });
  });

  it(`keeps at most ${String(LIMITS.sessionFilesMax)} files (oldest lastAt dropped)`, async () => {
    const { index } = await setup();
    const ops = Array.from({ length: LIMITS.sessionFilesMax + 5 }, (_, i) =>
      upsert(tool('Read', { file_path: `D:\\work\\f${String(i)}.ts` }, { at: sampleTime(i) })),
    );
    index.observe(ENTRY, ops);
    const files = await index.list(ENTRY);
    expect(files).toHaveLength(LIMITS.sessionFilesMax);
    expect(files.some((file) => file.path === 'D:\\work\\f0.ts')).toBe(false);
    expect(files[0]?.path).toBe(`D:\\work\\f${String(LIMITS.sessionFilesMax + 4)}.ts`);
  });

  it('files.json is written debounced; flush writes it now (valid schema)', async () => {
    const { home, index } = await setup();
    const file = path.join(entryDir(home, ENTRY), SESSION_FILES_FILE);
    await index.list(ENTRY); // load + backfill (empty) – the backfill marks the file as done
    await index.flush();
    index.observe(ENTRY, [upsert(tool('Write', { file_path: 'D:\\work\\new.ts' }))]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = sessionFilesFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    expect(before.files).toEqual([]);
    await index.flush();
    const after = sessionFilesFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    expect(after).toMatchObject({ schemaVersion: 1, backfilled: true });
    expect(after.files.map((entry) => entry.path)).toEqual(['D:\\work\\new.ts']);
  });

  it('backfill: once from the transcripts of all conversations, then backfilled: true', async () => {
    const old = tool('Read', { file_path: 'D:\\work\\old.ts' }, { at: sampleTime(1) });
    const plan = tool(
      'ExitPlanMode',
      { planFilePath: 'C:\\Users\\u\\.claude\\plans\\p.md' },
      { at: sampleTime(2) },
    );
    const newer = tool('Edit', { file_path: 'D:\\work\\old.ts' }, { at: sampleTime(3) });
    const { home, store, entries, index } = await setup({ [CONV]: [old, plan], [CONV2]: [newer] }, [
      CONV,
      CONV2,
    ]);
    const files = await index.list(ENTRY);
    expect(files.map((file) => [file.path, file.ops, file.conversationId])).toEqual([
      ['D:\\work\\old.ts', ['read', 'edited'], CONV2],
      ['C:\\Users\\u\\.claude\\plans\\p.md', ['plan'], CONV],
    ]);
    expect(store.reads).toEqual([`tail:${CONV}`, `tail:${CONV2}`]);
    // Live upserts of items the backfill already saw do not count twice.
    index.observe(ENTRY, [upsert(newer)]);
    expect((await index.list(ENTRY))[0]?.count).toBe(2);
    await index.flush();

    // A new process: files.json says backfilled – the transcripts are not read again.
    const again = fakeTranscripts({ [CONV]: [old, plan], [CONV2]: [newer] });
    const second = createSessionIndex({ home, entries, transcripts: again, debounceMs: 60_000 });
    expect((await second.list(ENTRY)).map((file) => file.path)).toEqual([
      'D:\\work\\old.ts',
      'C:\\Users\\u\\.claude\\plans\\p.md',
    ]);
    expect(again.reads).toEqual([]);
    // The tail re-published after the restart does not count again (only a newer `at` moves it).
    second.observe(ENTRY, [upsert(newer)]);
    expect((await second.list(ENTRY))[0]?.count).toBe(2);
  });

  it('a long transcript is read page by page', async () => {
    const items = Array.from({ length: 4500 }, (_, i) =>
      tool('Read', { file_path: `D:\\work\\p${String(i % 7)}.ts` }, { at: sampleTime(i), order: i + 1 }),
    );
    const { store, index } = await setup({ [CONV]: items });
    const files = await index.list(ENTRY);
    expect(files).toHaveLength(7);
    expect(files.reduce((sum, file) => sum + file.count, 0)).toBe(4500);
    expect(store.reads.filter((read) => read.startsWith('before:'))).toHaveLength(2);
  });
});
