import type { JsonValue } from '@shared/common';
import type { ToolCallItem, TranscriptItem } from '@shared/model';
import { WIN32_PATHS, fromGitBashPath, type PathRules } from '@shared/paths';
import { partialJsonString } from './partial-json';

/**
 * The plan file in the transcript (ADR-148, same rule as the engine's `planFile`): a `Write`/`Edit`
 * of the main agent on (a) the known plan file path or (b) – while the session is in plan mode – a
 * `.md` file. The plan panel previews a running `Write` from its streamed input and reloads the file
 * after every finished write on it. Pure; cached per `view.items` array. WP-104: paths follow the
 * rules of the session's host (`PlanFileRule.rules`, default Windows).
 */

/** Tools that change the plan file (a finished one makes the panel load the file again). */
export const PLAN_WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit']);

/** A `Write` in one of these states is "being written" (input streaming, then executing). */
const LIVE_STATUSES: ReadonlySet<ToolCallItem['status']> = new Set(['streaming_input', 'pending', 'running']);

export interface PlanFileRule {
  /** Known plan file (detail `planFile`, else the plan decision's `planFilePath`). */
  planPath: string | null;
  /** The session is in plan mode (rule b: any `.md` file). */
  planMode: boolean;
  /** Path rules of the session's host (default Windows). */
  rules?: PathRules;
}

function inputString(input: JsonValue, key: string): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function safePath(raw: string, rules: PathRules): string | null {
  const path = rules.flavor === 'win32' && raw.startsWith('/') ? (fromGitBashPath(raw) ?? raw) : raw;
  return rules.issue(path) === null ? path : null;
}

/**
 * Absolute path a Write/Edit/MultiEdit works on – while the input still streams, from the partial
 * JSON once `file_path` is complete. Null for other tools and for paths that fail the C.10 filter
 * of the host (`rules`).
 */
export function planToolPath(
  item: Pick<ToolCallItem, 'toolName' | 'input' | 'inputPartial'>,
  rules: PathRules = WIN32_PATHS,
): string | null {
  if (!PLAN_WRITE_TOOLS.has(item.toolName)) return null;
  const fromInput = inputString(item.input, 'file_path');
  if (fromInput !== null) return safePath(fromInput, rules);
  if (item.inputPartial === null) return null;
  const partial = partialJsonString(item.inputPartial, 'file_path');
  return partial?.complete === true && partial.value !== '' ? safePath(partial.value, rules) : null;
}

/** Whether `path` is the plan file under `rule` (compared by the host's rules: case-insensitive on Windows). */
export function isPlanFilePath(path: string, rule: PlanFileRule): boolean {
  const rules = rule.rules ?? WIN32_PATHS;
  if (rule.planPath !== null && rules.equal(path, rule.planPath)) return true;
  return rule.planMode && rules.extension(path) === 'md';
}

export interface PlanFileActivity {
  /** Item id of the running `Write` on the plan file (the newest matching call), else null. */
  liveItemId: string | null;
  /** Path of the newest matching call (the plan file before the engine reported `planFile`). */
  path: string | null;
  /** Time (ms) of the newest finished, successful write on the plan file; null without one. */
  writtenAt: number | null;
}

const NONE: PlanFileActivity = { liveItemId: null, path: null, writtenAt: null };

function finishedAt(item: ToolCallItem): number {
  const at = Date.parse(item.result?.at ?? item.at);
  return Number.isFinite(at) ? at : 0;
}

const cache = new WeakMap<readonly TranscriptItem[], Map<string, PlanFileActivity>>();

/** Plan file calls of a transcript under `rule` (cached per items array and rule). */
export function planFileActivity(items: readonly TranscriptItem[], rule: PlanFileRule): PlanFileActivity {
  const rules = rule.rules ?? WIN32_PATHS;
  const ruleKey = `${rules.flavor}|${rule.planMode ? '1' : '0'}|${rule.planPath ?? ''}`;
  let perRule = cache.get(items);
  const cached = perRule?.get(ruleKey);
  if (cached !== undefined) return cached;
  let newest: ToolCallItem | null = null;
  let newestPath: string | null = null;
  let writtenAt: number | null = null;
  for (const item of items) {
    if (item.kind !== 'tool_call' || item.parentToolUseId !== null) continue;
    const path = planToolPath(item, rules);
    if (path === null || !isPlanFilePath(path, rule)) continue;
    newest = item;
    newestPath = path;
    if (item.status === 'done' && item.result?.isError !== true) {
      const at = finishedAt(item);
      if (writtenAt === null || at > writtenAt) writtenAt = at;
    }
  }
  const activity: PlanFileActivity =
    newest === null
      ? NONE
      : {
          liveItemId: newest.toolName === 'Write' && LIVE_STATUSES.has(newest.status) ? newest.id : null,
          path: newestPath,
          writtenAt,
        };
  if (perRule === undefined) {
    perRule = new Map();
    cache.set(items, perRule);
  }
  perRule.set(ruleKey, activity);
  return activity;
}

/**
 * Text of a running `Write` so far: the complete `content` once the input arrived, else the decoded
 * part of the streamed `content` (empty before the key arrived).
 */
export function liveWriteContent(item: Pick<ToolCallItem, 'input' | 'inputPartial'>): string {
  if (item.inputPartial === null) {
    if (typeof item.input === 'object' && item.input !== null && !Array.isArray(item.input)) {
      const content = item.input.content;
      if (typeof content === 'string') return content;
    }
    return '';
  }
  return partialJsonString(item.inputPartial, 'content')?.value ?? '';
}
