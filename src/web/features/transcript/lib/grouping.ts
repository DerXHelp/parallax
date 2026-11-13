import type { SideQuestionItem, SystemItem, ToolCallItem, TranscriptItem } from '@shared/model';
import type { HookDisplay } from '@web/state/hook-display';
import type { TranscriptViewMode } from '@web/state/transcript-view';

/**
 * Compact transcript (WP-63 §1.5) as pure functions – the list only maps their rows to components:
 * - `classifyItem`: the role of a top-level item, as a one-letter code (the list's selector
 *   compares the codes shallowly, so a delta that does not change a role never rebuilds the rows);
 * - `buildRows`: one pass over the top-level ids (O(n)) – in the compact view every run of work
 *   steps between two visible entries becomes ONE group row (its pictures as a gallery in the same
 *   row; the steps follow as nested rows while the group is open); in the view "all steps" every
 *   item is a row, adjacent tool calls with pictures share one gallery row;
 * - `summarizeGroup`: what the group line says (step count, tools, errors, running step, times).
 *
 * Roles (the choice, §1.5):
 * - visible – ends a group: user messages, assistant texts, the turn footer, decisions (tool calls
 *   with a permission decision, AskUserQuestion, ExitPlanMode), subagent cards (Agent/Task), error
 *   notices, `rate_limit` rejected, compact boundary, new conversation, API retry, model fallback,
 *   permission denied, interruptions, handoffs, task notifications, local command output,
 *   informational warnings/errors and side questions (WP-66: never inside a group) – all of them
 *   change what happens next or answer the user;
 * - step: thinking, every other tool call with its result, and the quiet system items (memory
 *   recall, system notifications, informational at level info, unknown SDK messages) – bookkeeping
 *   of the work, interesting only when looking into it;
 * - hidden: `rate_limit` allowed / allowed_warning (§1.2 – older logs still hold such items; the
 *   limit bar shows every value) and the later questions of a side-question thread (WP-66: the card
 *   of its earliest loaded question shows the whole thread). Hidden items are skipped and do not
 *   split a group.
 * - hook runs (WP-69) have codes of their own, resolved by `buildRows` with the setting
 *   `hookDisplay` (`resolveHookCode`): a successful (or still running) run is a step with `all`,
 *   hidden otherwise; a failed one (blocking included) is visible unless `off`; a failed
 *   SessionStart/Setup hook is always visible (start problems are never hidden). So the codes stay
 *   independent of the setting (one cached code list per items array).
 */

/**
 * v visible, s step, i step with pictures in its result, h hidden; hook runs: k succeeded or
 * running, f failed, F failed at the session start (SessionStart/Setup).
 */
export type ItemCode = 'v' | 's' | 'i' | 'h' | 'k' | 'f' | 'F';

/** A run shorter than this stays plain rows (one step needs no extra click). */
export const MIN_GROUP_SIZE = 2;

/** Tool calls that are decisions or cards of their own (always visible). */
const VISIBLE_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'ExitPlanMode', 'AskUserQuestion']);

/** System events that are work steps; every other event stays visible (hooks: `hookCode`). */
const QUIET_SYSTEM_EVENTS: ReadonlySet<SystemItem['event']> = new Set(['memory_recall', 'notification', 'unknown']);

/** Hook events of the session start: a failure there stays visible even with `hookDisplay: 'off'`. */
const SESSION_START_HOOK_EVENTS: ReadonlySet<string> = new Set(['SessionStart', 'Setup']);

type HookItem = Extract<SystemItem, { event: 'hook' }>;

/** A run that ended without success (`outcome` other than `success`; null = still running). */
export function isFailedHook(item: HookItem): boolean {
  return item.outcome !== null && item.outcome !== 'success';
}

/** A failed run that stopped something (exit code 2: the tool call, the prompt, the stop). */
export function isBlockingHook(item: HookItem): boolean {
  return isFailedHook(item) && item.exitCode === 2;
}

function hookCode(item: HookItem): ItemCode {
  if (!isFailedHook(item)) return 'k';
  return SESSION_START_HOOK_EVENTS.has(item.hookEvent) ? 'F' : 'f';
}

/** The role of a hook code under the setting (other codes stay as they are). */
export function resolveHookCode(code: ItemCode, hooks: HookDisplay): ItemCode {
  switch (code) {
    case 'k':
      return hooks === 'all' ? 's' : 'h';
    case 'f':
      return hooks === 'off' ? 'h' : 'v';
    case 'F':
      return 'v';
    default:
      return code;
  }
}

/** Is a hook item shown at all under the setting (nested rows check it themselves)? */
export function isHookShown(item: HookItem, hooks: HookDisplay): boolean {
  return resolveHookCode(hookCode(item), hooks) !== 'h';
}

/** The result holds at least one picture (blob image). */
export function hasResultImages(item: ToolCallItem): boolean {
  return (
    item.result?.content.some((part) => part.type === 'image' && part.image.mediaType.startsWith('image/')) ??
    false
  );
}

/** §1.2: a `rate_limit` item is shown only for `rejected` (the session stops). */
export function isHiddenRateLimit(item: TranscriptItem): boolean {
  return item.kind === 'system' && item.event === 'rate_limit' && item.info.status !== 'rejected';
}

function systemCode(item: SystemItem): ItemCode {
  if (item.event === 'hook') return hookCode(item);
  if (item.event === 'rate_limit') return item.info.status === 'rejected' ? 'v' : 'h';
  if (item.event === 'informational') return item.level === 'warning' || item.level === 'error' ? 'v' : 's';
  return QUIET_SYSTEM_EVENTS.has(item.event) ? 's' : 'v';
}

export function classifyItem(item: TranscriptItem): ItemCode {
  switch (item.kind) {
    case 'user_message':
    case 'assistant_text':
    case 'turn_result':
      return 'v';
    case 'thinking':
      return 's';
    case 'tool_call':
      if (VISIBLE_TOOLS.has(item.toolName) || item.decision !== null) return 'v';
      return hasResultImages(item) ? 'i' : 's';
    case 'system':
      return systemCode(item);
    case 'side_question':
      return 'v';
  }
}

/**
 * The role code of every item by id (the list maps the top-level ids through it). WP-66: only the
 * earliest loaded question of a side-question thread is a row (normally its first question) – that
 * card renders the whole thread, the other questions of the thread are hidden.
 */
export function itemCodesById(items: readonly TranscriptItem[]): Map<string, ItemCode> {
  const codes = new Map<string, ItemCode>();
  const leads = new Map<string, SideQuestionItem>();
  for (const item of items) {
    codes.set(item.id, classifyItem(item));
    if (item.kind !== 'side_question') continue;
    const lead = leads.get(item.threadId);
    if (lead === undefined || item.order < lead.order) leads.set(item.threadId, item);
  }
  for (const item of items) {
    if (item.kind === 'side_question' && leads.get(item.threadId) !== item) codes.set(item.id, 'h');
  }
  return codes;
}

export type TranscriptRowModel =
  /** One item; `nested` = a step of an open group, `hideImages` = its pictures are in a gallery. */
  | { kind: 'item'; id: string; nested: boolean; hideImages: boolean }
  /** The group line (+ gallery of `imageIds`) of the steps `ids`; `key` = `group:<first id>`. */
  | { kind: 'group'; key: string; ids: readonly string[]; imageIds: readonly string[]; open: boolean }
  /** View "all steps": the pictures of adjacent tool calls `ids`, after the last of them. */
  | { kind: 'gallery'; key: string; ids: readonly string[] };

/** Stable key of a group: its first item (kept while the group grows at its end). */
export function groupKey(firstId: string): string {
  return `group:${firstId}`;
}

/** A single step (or an image run of one): plain rows with their own pictures. */
function pushPlain(rows: TranscriptRowModel[], ids: readonly string[]): void {
  for (const id of ids) rows.push({ kind: 'item', id, nested: false, hideImages: false });
}

/**
 * The rows of the list. `codes[i]` belongs to `ids[i]` (a missing code counts as visible);
 * `isOpen(groupKey)` says which groups the user opened; `hooks` resolves the hook codes (WP-69).
 */
export function buildRows(
  ids: readonly string[],
  codes: readonly ItemCode[],
  mode: TranscriptViewMode,
  isOpen: (key: string) => boolean,
  hooks: HookDisplay = 'failed',
): TranscriptRowModel[] {
  const resolved = codes.some((code) => code === 'k' || code === 'f' || code === 'F')
    ? codes.map((code) => resolveHookCode(code, hooks))
    : codes;
  return mode === 'compact' ? compactRows(ids, resolved, isOpen) : allRows(ids, resolved);
}

function compactRows(
  ids: readonly string[],
  codes: readonly ItemCode[],
  isOpen: (key: string) => boolean,
): TranscriptRowModel[] {
  const rows: TranscriptRowModel[] = [];
  let run: string[] = [];
  let runImages: string[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length < MIN_GROUP_SIZE) {
      pushPlain(rows, run);
    } else {
      const key = groupKey(run[0] ?? '');
      const open = isOpen(key);
      rows.push({ kind: 'group', key, ids: run, imageIds: runImages, open });
      if (open)
        for (const id of run) rows.push({ kind: 'item', id, nested: true, hideImages: runImages.length > 0 });
    }
    run = [];
    runImages = [];
  };
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id === undefined) continue;
    const code = codes[i] ?? 'v';
    if (code === 'h') continue;
    if (code === 's' || code === 'i') {
      run.push(id);
      if (code === 'i') runImages.push(id);
      continue;
    }
    flush();
    rows.push({ kind: 'item', id, nested: false, hideImages: false });
  }
  flush();
  return rows;
}

function allRows(ids: readonly string[], codes: readonly ItemCode[]): TranscriptRowModel[] {
  const rows: TranscriptRowModel[] = [];
  let images: string[] = [];
  const flush = () => {
    if (images.length >= MIN_GROUP_SIZE) {
      for (const id of images) rows.push({ kind: 'item', id, nested: false, hideImages: true });
      rows.push({ kind: 'gallery', key: `gallery:${images[0] ?? ''}`, ids: images });
    } else {
      pushPlain(rows, images);
    }
    images = [];
  };
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id === undefined) continue;
    const code = codes[i] ?? 'v';
    if (code === 'h') continue;
    if (code === 'i') {
      images.push(id);
      continue;
    }
    flush();
    rows.push({ kind: 'item', id, nested: false, hideImages: false });
  }
  flush();
  return rows;
}

// ---- the group line ----

export interface ToolCount {
  name: string;
  count: number;
}

export interface GroupSummary {
  /** Tool calls (the "steps" of the line). */
  tools: number;
  thoughts: number;
  /** WP-69: hook runs (steps of the line as well, listed as "n× Hook"). */
  hooks: number;
  /** Quiet system items. */
  notices: number;
  /** Per tool name, most frequent first (ties by name). */
  toolCounts: readonly ToolCount[];
  /** Failed tool calls. */
  errors: number;
  /** The step that is running now (last active member), null when the group is finished. */
  running: TranscriptItem | null;
  /** Epoch ms of the first member and of the latest end (a result's time for tool calls). */
  startAt: number | null;
  endAt: number | null;
}

/** A tool call that is still at work (background tasks run on their own and do not count). */
function isActive(item: TranscriptItem): boolean {
  if (item.kind === 'thinking') return item.streaming;
  if (item.kind === 'tool_call') {
    return item.status === 'streaming_input' || item.status === 'pending' || item.status === 'running';
  }
  return false;
}

function isFailed(item: ToolCallItem): boolean {
  return item.status === 'error' || (item.status === 'done' && item.result?.isError === true);
}

function timeOf(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function summarizeGroup(items: readonly (TranscriptItem | null)[]): GroupSummary {
  let tools = 0;
  let thoughts = 0;
  let hooks = 0;
  let notices = 0;
  let errors = 0;
  let running: TranscriptItem | null = null;
  let startAt: number | null = null;
  let endAt: number | null = null;
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item === null) continue;
    const at = timeOf(item.at);
    if (at !== null) {
      startAt = startAt === null ? at : Math.min(startAt, at);
      endAt = endAt === null ? at : Math.max(endAt, at);
    }
    if (isActive(item)) running = item;
    if (item.kind === 'thinking') thoughts++;
    else if (item.kind === 'tool_call') {
      tools++;
      counts.set(item.toolName, (counts.get(item.toolName) ?? 0) + 1);
      if (isFailed(item)) errors++;
      const end = timeOf(item.result?.at);
      if (end !== null) endAt = endAt === null ? end : Math.max(endAt, end);
    } else if (item.kind === 'system' && item.event === 'hook') hooks++;
    else notices++;
  }
  const toolCounts = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { tools, thoughts, hooks, notices, toolCounts, errors, running, startAt, endAt };
}
