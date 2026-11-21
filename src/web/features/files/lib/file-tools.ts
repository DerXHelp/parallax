import type { JsonValue } from '@shared/common';
import type { ToolCallItem, TranscriptItem } from '@shared/model';
import { WIN32_PATHS, fromGitBashPath, type PathFlavor, type PathRules } from '@shared/paths';

/**
 * File tool calls of a transcript (ADR-143, ADR-145): which tools touch which file, so the viewer
 * reloads after a finished write, the stat cache drops a stale answer and "Files of this session"
 * refreshes. Pure; cached per `view.items` array (cheap for every selector call). WP-104: paths follow
 * the rules of the session's host (`rules`, default Windows).
 */

/** Tools that change a file (the viewer reloads at once when one of them finishes). */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Input key of the file path per tool (Read/Write/Edit: file_path; NotebookEdit; ExitPlanMode). */
const PATH_KEYS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  ExitPlanMode: 'planFilePath',
};

/** Tools whose finished calls feed "Files of this session". */
export const FILE_TOOLS: ReadonlySet<string> = new Set(Object.keys(PATH_KEYS));

function inputString(input: JsonValue, key: string): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Absolute path a file tool call works on (Windows host: Git Bash `/c/…` converted), or null – also
 * for paths that fail the C.10 filter of the host (they are never used for anything).
 */
export function toolFilePath(
  item: Pick<ToolCallItem, 'toolName' | 'input'>,
  rules: PathRules = WIN32_PATHS,
): string | null {
  const key = PATH_KEYS[item.toolName];
  if (key === undefined) return null;
  const raw = inputString(item.input, key);
  if (raw === null) return null;
  const path = rules.flavor === 'win32' && raw.startsWith('/') ? (fromGitBashPath(raw) ?? raw) : raw;
  return rules.issue(path) === null ? path : null;
}

/** Time (ms) a tool call finished: its result time, else the item time. */
function finishedAt(item: ToolCallItem): number {
  const at = Date.parse(item.result?.at ?? item.at);
  return Number.isFinite(at) ? at : 0;
}

export interface FileToolIndex {
  /** `rules.key(path)` → time (ms) of the newest finished write tool on that file. */
  writes: ReadonlyMap<string, number>;
  /**
   * Changes whenever a file tool call finishes (or a task with an output file ends) – the trigger of
   * the debounced refresh of "Files of this session".
   */
  signature: string;
}

const caches: Readonly<Record<PathFlavor, WeakMap<readonly TranscriptItem[], FileToolIndex>>> = {
  win32: new WeakMap(),
  posix: new WeakMap(),
};

export function fileToolIndex(
  items: readonly TranscriptItem[],
  rules: PathRules = WIN32_PATHS,
): FileToolIndex {
  const cache = caches[rules.flavor];
  const cached = cache.get(items);
  if (cached !== undefined) return cached;
  const writes = new Map<string, number>();
  let finished = 0;
  let last = '';
  let outputs = 0;
  for (const item of items) {
    if (item.kind !== 'tool_call') continue;
    const task = item.task;
    if (typeof task?.outputFile === 'string' && typeof task.endedAt === 'string') outputs++;
    if (item.status !== 'done') continue;
    const path = toolFilePath(item, rules);
    if (path === null) continue;
    finished++;
    last = item.toolUseId;
    if (!FILE_WRITE_TOOLS.has(item.toolName) || item.result?.isError === true) continue;
    const key = rules.key(path);
    const at = finishedAt(item);
    if (at > (writes.get(key) ?? -1)) writes.set(key, at);
  }
  const index: FileToolIndex = { writes, signature: `${String(finished)}:${last}:${String(outputs)}` };
  cache.set(items, index);
  return index;
}
