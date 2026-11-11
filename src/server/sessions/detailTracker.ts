/**
 * Engine-derived detail fields of the current conversation (Phase 3; single writer: the engine,
 * head comment of `sessions/ports.ts`): the pinned task list `todos` (ADR-149) and the plan file
 * `planFile` (ADR-148). Both come from FINISHED main-agent tool calls (`status 'done'`, no error
 * result, `parentToolUseId` null) – each tool call counts once (its first finished upsert):
 *
 * - `TodoWrite` → the whole list (`input.todos[]`, id = index, `source 'todo_write'`).
 * - `TaskCreate` / `TaskUpdate` / `TaskList` → the task list (`source 'tasks'`, id = the CLI's task
 *   id from the result); see the mapping table in docs/wp/WP-51.md "2. Ergebnis".
 * - `Write` / `Edit` on (a) the `planFilePath` of the newest plan decision or (b) – while the
 *   permission mode is `plan` – any `.md` file → `planFile {path, updatedAt, toolUseId}`.
 *
 * Inputs and results are parsed tolerantly (zod, unknown fields ignored, broken entries skipped).
 * A new conversation starts with both fields null (`reset`). Pure state, no I/O – `EntryState`
 * feeds it from its op path and publishes the changes as `detail.patch`.
 */
import { z } from 'zod';
import { LIMITS } from '@shared/common';
import {
  TODO_STATUSES,
  type PlanFileRef,
  type TodoItem,
  type TodoList,
  type TodoStatus,
  type ToolCallItem,
} from '@shared/model';
import { windowsPathExtension, windowsPathKey, windowsPathsEqual } from '@shared/paths';

/** `todoItemSchema` caps `content` and `activeForm` at 2000 characters. */
export const TODO_TEXT_CHARS = 2000;
/** Last finished Write/Edit per file kept for rule (a) of a plan decision that arrives later. */
export const PLAN_FILE_CANDIDATES = 100;

export interface DetailFields {
  todos: TodoList | null;
  planFile: PlanFileRef | null;
}

export interface DetailContext {
  /** `planFilePath` of the newest plan decision of the entry (rule a); null = none. */
  planFilePath: string | null;
  /** The entry's permission mode is `plan` (rule b). */
  planMode: boolean;
}

const looseText = z.string();
const todoWriteInputSchema = z.looseObject({ todos: z.array(z.unknown()) });
const todoWriteEntrySchema = z.looseObject({
  content: looseText,
  status: z.unknown().optional(),
  activeForm: looseText.nullable().optional(),
});
const taskIdSchema = z.union([z.string().min(1), z.number().int().nonnegative().transform(String)]);
const taskCreateInputSchema = z.looseObject({
  subject: looseText.optional(),
  description: looseText.optional(),
  activeForm: looseText.nullable().optional(),
});
const taskCreateOutputSchema = z.looseObject({ task: z.looseObject({ id: taskIdSchema }) });
const taskUpdateInputSchema = z.looseObject({
  taskId: taskIdSchema,
  subject: looseText.optional(),
  activeForm: looseText.nullable().optional(),
  status: z.unknown().optional(),
});
const taskUpdateOutputSchema = z.looseObject({ success: z.boolean().optional() });
const taskListOutputSchema = z.looseObject({
  tasks: z.array(z.unknown()),
});
const taskListEntrySchema = z.looseObject({
  id: taskIdSchema,
  subject: looseText.optional(),
  status: z.unknown().optional(),
});
const fileToolInputSchema = z.looseObject({ file_path: z.string().min(1) });

const PLAN_FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit']);
const TRACKED_TOOLS: ReadonlySet<string> = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  ...PLAN_FILE_TOOLS,
]);

function cap(text: string): string {
  return text.slice(0, TODO_TEXT_CHARS);
}

function todoStatus(value: unknown): TodoStatus {
  return TODO_STATUSES.find((status) => status === value) ?? 'pending';
}

/** First text part of a tool result (the TaskCreate id fallback of a history import, F.15). */
function resultText(item: ToolCallItem): string {
  for (const part of item.result?.content ?? []) if (part.type === 'text') return part.text.text;
  return '';
}

/** A main-agent tool call that finished successfully (the only ones that count). */
export function isFinishedMainCall(item: ToolCallItem): boolean {
  return (
    item.parentToolUseId === null && item.status === 'done' && item.result !== null && !item.result.isError
  );
}

export class DetailTracker {
  private todos: TodoList | null = null;
  private planFile: PlanFileRef | null = null;
  /** Tool calls already counted (a later upsert of the same call – a decision ref – changes nothing). */
  private readonly applied = new Set<string>();
  /** windowsPathKey → last finished Write/Edit (rule a for a plan decision that comes after it). */
  private readonly writes = new Map<string, PlanFileRef>();

  current(): DetailFields {
    return { todos: this.todos, planFile: this.planFile };
  }

  /** New conversation: both fields null, nothing counted. True when a field changed. */
  reset(): boolean {
    const changed = this.todos !== null || this.planFile !== null;
    this.todos = null;
    this.planFile = null;
    this.applied.clear();
    this.writes.clear();
    return changed;
  }

  /** A tool call upsert (any state). True when a field changed. */
  apply(item: ToolCallItem, context: DetailContext): boolean {
    if (!TRACKED_TOOLS.has(item.toolName) || !isFinishedMainCall(item) || this.applied.has(item.toolUseId))
      return false;
    this.applied.add(item.toolUseId);
    const at = item.result?.at ?? item.at;
    switch (item.toolName) {
      case 'TodoWrite':
        return this.setTodos(this.todoWrite(item, at));
      case 'TaskCreate':
        return this.setTodos(this.taskCreate(item, at));
      case 'TaskUpdate':
        return this.setTodos(this.taskUpdate(item, at));
      case 'TaskList':
        return this.setTodos(this.taskList(item, at));
      default:
        return PLAN_FILE_TOOLS.has(item.toolName) ? this.fileWritten(item, at, context) : false;
    }
  }

  /**
   * A new plan decision with its plan file (rule a): the last finished Write/Edit on that file
   * becomes the plan file (the plan-mode Write comes before ExitPlanMode, plan-mode#40). True when
   * the field changed.
   */
  planDecision(planFilePath: string | null): boolean {
    if (planFilePath === null) return false;
    const known = this.writes.get(windowsPathKey(planFilePath));
    if (known === undefined || this.samePlanFile(known)) return false;
    if (this.planFile !== null && Date.parse(this.planFile.updatedAt) > Date.parse(known.updatedAt))
      return false;
    this.planFile = known;
    return true;
  }

  private samePlanFile(ref: PlanFileRef): boolean {
    return (
      this.planFile !== null &&
      this.planFile.toolUseId === ref.toolUseId &&
      windowsPathsEqual(this.planFile.path, ref.path)
    );
  }

  private fileWritten(item: ToolCallItem, at: string, context: DetailContext): boolean {
    const input = fileToolInputSchema.safeParse(item.input);
    if (!input.success) return false;
    const path = input.data.file_path;
    const ref: PlanFileRef = { path, updatedAt: at, toolUseId: item.toolUseId };
    const key = windowsPathKey(path);
    this.writes.delete(key);
    this.writes.set(key, ref);
    if (this.writes.size > PLAN_FILE_CANDIDATES) {
      const oldest = this.writes.keys().next().value;
      if (oldest !== undefined) this.writes.delete(oldest);
    }
    const planned = context.planFilePath !== null && windowsPathsEqual(path, context.planFilePath);
    const markdown = context.planMode && windowsPathExtension(path) === 'md';
    if (!planned && !markdown) return false;
    this.planFile = ref;
    return true;
  }

  private setTodos(next: TodoList | null): boolean {
    if (next === null) return false;
    this.todos = next;
    return true;
  }

  private list(source: TodoList['source'], items: TodoItem[], at: string, toolUseId: string): TodoList {
    return { source, items: items.slice(0, LIMITS.todoItemsMax), updatedAt: at, toolUseId };
  }

  /** TodoWrite: the whole list replaces the current one (also a task list). */
  private todoWrite(item: ToolCallItem, at: string): TodoList | null {
    const input = todoWriteInputSchema.safeParse(item.input);
    if (!input.success) return null;
    const items: TodoItem[] = [];
    input.data.todos.forEach((raw, index) => {
      const entry = todoWriteEntrySchema.safeParse(raw);
      if (!entry.success || items.length >= LIMITS.todoItemsMax) return;
      items.push({
        id: String(index),
        content: cap(entry.data.content),
        status: todoStatus(entry.data.status),
        activeForm: typeof entry.data.activeForm === 'string' ? cap(entry.data.activeForm) : null,
      });
    });
    return this.list('todo_write', items, at, item.toolUseId);
  }

  /** The current task list, or a new empty one (a TodoWrite list is replaced). */
  private taskItems(): TodoItem[] {
    return this.todos?.source === 'tasks' ? [...this.todos.items] : [];
  }

  /** TaskCreate: appends the task (id from the result); a full list takes no more. */
  private taskCreate(item: ToolCallItem, at: string): TodoList | null {
    const input = taskCreateInputSchema.safeParse(item.input);
    if (!input.success) return null;
    const items = this.taskItems();
    const id = this.createdTaskId(item, items);
    const content = (input.data.subject ?? '').trim() !== '' ? input.data.subject : input.data.description;
    const task: TodoItem = {
      id,
      content: cap(content ?? ''),
      status: 'pending',
      activeForm: typeof input.data.activeForm === 'string' ? cap(input.data.activeForm) : null,
    };
    const index = items.findIndex((t) => t.id === id);
    if (index >= 0) items[index] = task;
    else if (items.length < LIMITS.todoItemsMax) items.push(task);
    else return null;
    return this.list('tasks', items, at, item.toolUseId);
  }

  /** Result `task.id`; without a structured result (history, F.15) `#<n>` from the text; else the next number. */
  private createdTaskId(item: ToolCallItem, items: readonly TodoItem[]): string {
    const output = taskCreateOutputSchema.safeParse(item.result?.structured);
    if (output.success) return output.data.task.id;
    const match = /#(\d+)/.exec(resultText(item));
    if (match?.[1] !== undefined) return match[1];
    const numbers = items.map((t) => Number(t.id)).filter((n) => Number.isInteger(n));
    return String(Math.max(0, ...numbers) + 1);
  }

  /** TaskUpdate: status/subject/activeForm of a known task; `deleted` removes it; `success:false` → nothing. */
  private taskUpdate(item: ToolCallItem, at: string): TodoList | null {
    const input = taskUpdateInputSchema.safeParse(item.input);
    if (!input.success || this.todos?.source !== 'tasks') return null;
    const output = taskUpdateOutputSchema.safeParse(item.result?.structured);
    if (output.success && output.data.success === false) return null;
    const items = this.taskItems();
    const index = items.findIndex((t) => t.id === input.data.taskId);
    const current = items[index];
    if (current === undefined) return null;
    const { status, subject, activeForm } = input.data;
    if (status === 'deleted') {
      items.splice(index, 1);
    } else {
      items[index] = {
        ...current,
        status: TODO_STATUSES.find((s) => s === status) ?? current.status,
        content: subject !== undefined && subject.trim() !== '' ? cap(subject) : current.content,
        activeForm: typeof activeForm === 'string' ? cap(activeForm) : current.activeForm,
      };
    }
    return this.list('tasks', items, at, item.toolUseId);
  }

  /** TaskList: the CLI's whole list (structured result only) – re-syncs ids, subjects and states. */
  private taskList(item: ToolCallItem, at: string): TodoList | null {
    const output = taskListOutputSchema.safeParse(item.result?.structured);
    if (!output.success) return null;
    const known = new Map(this.taskItems().map((t) => [t.id, t]));
    const items: TodoItem[] = [];
    for (const raw of output.data.tasks) {
      const entry = taskListEntrySchema.safeParse(raw);
      if (!entry.success || items.length >= LIMITS.todoItemsMax) continue;
      const before = known.get(entry.data.id);
      items.push({
        id: entry.data.id,
        content: cap(entry.data.subject ?? before?.content ?? ''),
        status: todoStatus(entry.data.status),
        activeForm: before?.activeForm ?? null,
      });
    }
    return this.list('tasks', items, at, item.toolUseId);
  }
}
