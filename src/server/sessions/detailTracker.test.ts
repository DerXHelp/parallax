/**
 * WP-51 – `DetailTracker`: `todos` (ADR-149) from TodoWrite and the TaskCreate/TaskUpdate/TaskList
 * calls, `planFile` (ADR-148) rules (a) and (b), limits, tolerance and the reset of a new
 * conversation. Table of the mapping: docs/wp/WP-51.md "2. Ergebnis".
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import type { JsonValue } from '@shared/common';
import type { ToolCallItem } from '@shared/model';
import { sampleItems, sampleTime } from '@shared/samples';
import { DetailTracker, TODO_TEXT_CHARS, type DetailContext } from './detailTracker';

const NO_PLAN: DetailContext = { planFilePath: null, planMode: false };
const PLAN_FILE = 'C:\\Users\\user\\.claude\\plans\\fake-plan.md';

let n = 0;
function call(
  toolName: string,
  input: JsonValue,
  o: {
    structured?: JsonValue;
    text?: string;
    status?: ToolCallItem['status'];
    isError?: boolean;
    at?: number;
  } = {},
  extra: Partial<ToolCallItem> = {},
): ToolCallItem {
  n += 1;
  return sampleItems.toolCall({
    toolUseId: `toolu_${String(n)}`,
    toolName,
    input,
    status: o.status ?? 'done',
    result: {
      isError: o.isError ?? false,
      content: [{ type: 'text', text: { text: o.text ?? 'ok', truncated: null } }],
      structured: o.structured ?? null,
      structuredTruncated: null,
      at: sampleTime(o.at ?? n),
    },
    ...extra,
  });
}

const todo = (content: string, status: string, activeForm?: string) => ({
  content,
  status,
  ...(activeForm === undefined ? {} : { activeForm }),
});

describe('todos from TodoWrite (source todo_write)', () => {
  it('the whole list: id = index, status, activeForm (missing → null); updatedAt/toolUseId of the call', () => {
    const t = new DetailTracker();
    const write = call('TodoWrite', {
      todos: [
        todo('Read the code', 'completed', 'Reading the code'),
        todo('Write tests', 'in_progress'),
        todo('Ship', 'pending', 'Shipping'),
      ],
    });
    expect(t.apply(write, NO_PLAN)).toBe(true);
    expect(t.current().todos).toEqual({
      source: 'todo_write',
      items: [
        { id: '0', content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
        { id: '1', content: 'Write tests', status: 'in_progress', activeForm: null },
        { id: '2', content: 'Ship', status: 'pending', activeForm: 'Shipping' },
      ],
      updatedAt: write.result?.at,
      toolUseId: write.toolUseId,
    });
    // The next TodoWrite replaces it.
    expect(t.apply(call('TodoWrite', { todos: [todo('Only', 'completed')] }), NO_PLAN)).toBe(true);
    expect(t.current().todos?.items).toEqual([
      { id: '0', content: 'Only', status: 'completed', activeForm: null },
    ]);
  });

  it('tolerant: broken entries skipped (ids keep the index), unknown status → pending, unknown fields ignored, texts capped', () => {
    const t = new DetailTracker();
    t.apply(
      call('TodoWrite', {
        todos: [
          42,
          todo('x'.repeat(TODO_TEXT_CHARS + 5), 'blocked', 'y'.repeat(TODO_TEXT_CHARS + 1)),
          { status: 'pending' },
          { content: 'ok', status: 'completed', priority: 'high' },
        ],
        extra: true,
      }),
      NO_PLAN,
    );
    expect(t.current().todos?.items).toEqual([
      {
        id: '1',
        content: 'x'.repeat(TODO_TEXT_CHARS),
        status: 'pending',
        activeForm: 'y'.repeat(TODO_TEXT_CHARS),
      },
      { id: '3', content: 'ok', status: 'completed', activeForm: null },
    ]);
    // Input without a todos array: nothing changes.
    expect(t.apply(call('TodoWrite', { list: [] }), NO_PLAN)).toBe(false);
  });

  it(`at most LIMITS.todoItemsMax (${String(LIMITS.todoItemsMax)}) items`, () => {
    const t = new DetailTracker();
    const todos = Array.from({ length: LIMITS.todoItemsMax + 7 }, (_, i) =>
      todo(`Step ${String(i)}`, 'pending'),
    );
    t.apply(call('TodoWrite', { todos }), NO_PLAN);
    const items = t.current().todos?.items ?? [];
    expect(items).toHaveLength(LIMITS.todoItemsMax);
    expect(items.at(-1)?.id).toBe(String(LIMITS.todoItemsMax - 1));
  });

  it('only finished main-agent calls count, each once (running, error, subagent, a later upsert of the same call)', () => {
    const t = new DetailTracker();
    const input = { todos: [todo('A', 'pending')] };
    expect(t.apply(call('TodoWrite', input, { status: 'running' }), NO_PLAN)).toBe(false);
    expect(t.apply(call('TodoWrite', input, { isError: true }), NO_PLAN)).toBe(false);
    expect(t.apply(call('TodoWrite', input, {}, { parentToolUseId: 'toolu_agent' }), NO_PLAN)).toBe(false);
    expect(t.apply(call('TodoWrite', input, {}, { result: null }), NO_PLAN)).toBe(false);
    expect(t.current().todos).toBeNull();
    const first = call('TodoWrite', input);
    expect(t.apply(first, NO_PLAN)).toBe(true);
    t.apply(call('TodoWrite', { todos: [todo('B', 'pending')] }), NO_PLAN);
    // The first call again (e.g. a decision ref update): no regression to its list.
    expect(t.apply(first, NO_PLAN)).toBe(false);
    expect(t.current().todos?.items[0]?.content).toBe('B');
  });
});

describe('todos from TaskCreate / TaskUpdate / TaskList (source tasks)', () => {
  const create = (
    subject: string,
    id: string | null,
    extra: Record<string, JsonValue> = {},
    text = 'Task created',
  ) =>
    call(
      'TaskCreate',
      { subject, description: `About ${subject}`, ...extra },
      {
        structured: id === null ? null : { task: { id, subject } },
        text,
      },
    );
  const update = (
    taskId: string,
    fields: Record<string, JsonValue>,
    structured: JsonValue = { success: true, taskId, updatedFields: [] },
  ) => call('TaskUpdate', { taskId, ...fields }, { structured });

  it('TaskCreate appends with the id from the result (fallbacks: "#n" in the text, then the next number)', () => {
    const t = new DetailTracker();
    const first = create('Plan the API', '7', { activeForm: 'Planning the API' });
    t.apply(first, NO_PLAN);
    t.apply(create('Write the code', null, {}, 'Task #9 created successfully: Write the code'), NO_PLAN);
    t.apply(create('', null, {}, 'created'), NO_PLAN);
    expect(t.current().todos).toEqual({
      source: 'tasks',
      items: [
        { id: '7', content: 'Plan the API', status: 'pending', activeForm: 'Planning the API' },
        { id: '9', content: 'Write the code', status: 'pending', activeForm: null },
        // Empty subject → the description.
        { id: '10', content: 'About ', status: 'pending', activeForm: null },
      ],
      updatedAt: expect.any(String) as string,
      toolUseId: expect.any(String) as string,
    });
  });

  it('TaskUpdate: status, subject, activeForm; deleted removes; unknown task / success:false / no task list → nothing', () => {
    const t = new DetailTracker();
    expect(t.apply(update('1', { status: 'completed' }), NO_PLAN)).toBe(false);
    t.apply(create('One', '1'), NO_PLAN);
    t.apply(create('Two', '2'), NO_PLAN);
    t.apply(update('1', { status: 'in_progress', activeForm: 'Doing one', subject: 'One!' }), NO_PLAN);
    t.apply(update('2', { status: 'deleted' }), NO_PLAN);
    expect(t.apply(update('3', { status: 'completed' }), NO_PLAN)).toBe(false);
    expect(
      t.apply(
        update('1', { status: 'completed' }, { success: false, taskId: '1', updatedFields: [], error: 'x' }),
        NO_PLAN,
      ),
    ).toBe(false);
    // Unknown status values keep the current one.
    t.apply(update('1', { status: 'paused' }), NO_PLAN);
    const update1 = update('1', { status: 'completed' });
    t.apply(update1, NO_PLAN);
    expect(t.current().todos).toMatchObject({
      source: 'tasks',
      items: [{ id: '1', content: 'One!', status: 'completed', activeForm: 'Doing one' }],
      toolUseId: update1.toolUseId,
      updatedAt: update1.result?.at,
    });
  });

  it('TaskList re-syncs the whole list (activeForm kept by id); a TodoWrite replaces a task list and vice versa', () => {
    const t = new DetailTracker();
    t.apply(create('One', '1', { activeForm: 'Doing one' }), NO_PLAN);
    t.apply(
      call(
        'TaskList',
        {},
        {
          structured: {
            tasks: [
              { id: '1', subject: 'One', status: 'in_progress', blockedBy: [] },
              { id: 2, subject: 'Two', status: 'pending', blockedBy: [] },
              { subject: 'broken' },
            ],
          },
        },
      ),
      NO_PLAN,
    );
    expect(t.current().todos?.items).toEqual([
      { id: '1', content: 'One', status: 'in_progress', activeForm: 'Doing one' },
      { id: '2', content: 'Two', status: 'pending', activeForm: null },
    ]);
    // TaskList without a structured result (history import, F.15): nothing changes.
    expect(t.apply(call('TaskList', {}, { structured: null }), NO_PLAN)).toBe(false);
    t.apply(call('TodoWrite', { todos: [todo('A', 'pending')] }), NO_PLAN);
    expect(t.current().todos?.source).toBe('todo_write');
    t.apply(create('Fresh', '5'), NO_PLAN);
    expect(t.current().todos).toMatchObject({ source: 'tasks', items: [{ id: '5', content: 'Fresh' }] });
  });

  it(`a full task list (LIMITS.todoItemsMax) takes no further TaskCreate; the same id replaces`, () => {
    const t = new DetailTracker();
    for (let i = 1; i <= LIMITS.todoItemsMax; i += 1) t.apply(create(`T${String(i)}`, String(i)), NO_PLAN);
    expect(t.apply(create('Too many', String(LIMITS.todoItemsMax + 1)), NO_PLAN)).toBe(false);
    expect(t.current().todos?.items).toHaveLength(LIMITS.todoItemsMax);
    expect(t.apply(create('Renamed', '1'), NO_PLAN)).toBe(true);
    expect(t.current().todos?.items[0]).toMatchObject({ id: '1', content: 'Renamed' });
  });
});

describe('planFile (ADR-148)', () => {
  const write = (path: string, tool = 'Write') => call(tool, { file_path: path, content: '# Plan' });

  it('(a) the plan file of the newest plan decision (case-insensitive, also Edit), in any mode', () => {
    const t = new DetailTracker();
    const context = { planFilePath: PLAN_FILE, planMode: false };
    expect(t.apply(write('D:\\work\\notes.md'), context)).toBe(false);
    const edit = write(PLAN_FILE.toUpperCase(), 'Edit');
    expect(t.apply(edit, context)).toBe(true);
    expect(t.current().planFile).toEqual({
      path: PLAN_FILE.toUpperCase(),
      updatedAt: edit.result?.at,
      toolUseId: edit.toolUseId,
    });
  });

  it('(b) while the mode is plan: any .md file; other files and other modes do not count', () => {
    const t = new DetailTracker();
    const planMode = { planFilePath: null, planMode: true };
    expect(t.apply(write('D:\\work\\src\\main.ts'), planMode)).toBe(false);
    expect(t.apply(write('D:\\work\\PLAN.MD'), planMode)).toBe(true);
    expect(t.current().planFile?.path).toBe('D:\\work\\PLAN.MD');
    expect(t.apply(write('D:\\work\\other.md'), NO_PLAN)).toBe(false);
    // Unfinished or broken input: nothing.
    expect(t.apply(call('Write', { file_path: 'D:\\work\\x.md' }, { status: 'running' }), planMode)).toBe(
      false,
    );
    expect(t.apply(call('Write', { path: 'D:\\work\\x.md' }), planMode)).toBe(false);
  });

  it('a plan decision that arrives after the Write makes it the plan file (rule a), unless a newer one is set', () => {
    const t = new DetailTracker();
    const first = write(PLAN_FILE);
    t.apply(first, NO_PLAN);
    expect(t.current().planFile).toBeNull();
    expect(t.planDecision(null)).toBe(false);
    expect(t.planDecision('D:\\elsewhere.md')).toBe(false);
    expect(t.planDecision(PLAN_FILE)).toBe(true);
    expect(t.current().planFile?.toolUseId).toBe(first.toolUseId);
    expect(t.planDecision(PLAN_FILE)).toBe(false);
    const newer = call('Write', { file_path: 'D:\\work\\later.md' }, { at: 9999 });
    t.apply(newer, { planFilePath: null, planMode: true });
    expect(t.planDecision(PLAN_FILE)).toBe(false);
    expect(t.current().planFile?.toolUseId).toBe(newer.toolUseId);
  });

  it('reset (new conversation): both fields null; true only when something was set', () => {
    const t = new DetailTracker();
    expect(t.reset()).toBe(false);
    t.apply(write(PLAN_FILE), { planFilePath: PLAN_FILE, planMode: false });
    t.apply(call('TodoWrite', { todos: [todo('A', 'pending')] }), NO_PLAN);
    expect(t.reset()).toBe(true);
    expect(t.current()).toEqual({ todos: null, planFile: null });
    // A plan decision after the reset finds no Write of the old conversation.
    expect(t.planDecision(PLAN_FILE)).toBe(false);
  });
});
