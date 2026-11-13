/**
 * WP-65 (overview): pure helpers of the session engine for the sidebar's second line and the
 * auto title – the live activity of a turn (`ActivityTracker`: the CLI's live sentence, else the
 * running main-thread tool call with the same target text as the transcript line, else
 * "thinking"), the fallback turn summary (first meaningful line of the answer, Markdown removed),
 * the descriptions handed to `generateSessionTitle` and the merge of the usage query into the
 * account limits (ADR-114).
 */
import type { RateLimitInfo, SessionActivity, TranscriptItem } from '@shared/model';
import type { UsageLimits } from '../backend/types';

/** SessionActivity limits (model.ts). */
const TOOL_CHARS = 200;
const TARGET_CHARS = 300;
/** TurnSummary.text max (model.ts); the fallback keeps one short line. */
const FALLBACK_SUMMARY_CHARS = 200;
/** `generateSessionTitle` description (WP-65 §1.3: ≤ 2000 chars). */
export const TITLE_DESCRIPTION_CHARS = 2000;
const TITLE_PART_CHARS = 900;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function firstLine(text: string, max: number): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find((l) => l !== '') ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Last `count` segments of a Windows or POSIX path (like the transcript's `shortPath(path, 3)`). */
function shortPath(path: string, count = 3): string {
  const parts = path.split(/[\\/]+/).filter((p) => p !== '');
  return parts.length <= count ? path : `…/${parts.slice(-count).join('/')}`;
}

/**
 * The target the transcript line shows next to the tool name (renderers' `summary`): Bash /
 * PowerShell → description or command, file tools → short path, Grep/Glob → pattern, WebFetch →
 * url, WebSearch → query, Agent/Task → description, others → first string value.
 */
export function activityTarget(toolName: string, input: unknown): string | null {
  if (!isRecord(input)) return null;
  const o = input;
  let value: string | null;
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      value = str(o.description) ?? str(o.command);
      return value === null ? null : firstLine(value, 160);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      value = str(o.file_path);
      return value === null ? null : shortPath(value);
    case 'NotebookEdit':
      value = str(o.notebook_path);
      return value === null ? null : shortPath(value);
    case 'Grep':
    case 'Glob':
      value = str(o.pattern);
      break;
    case 'WebFetch':
      value = str(o.url);
      break;
    case 'WebSearch':
      value = str(o.query);
      break;
    case 'Agent':
    case 'Task':
      value = str(o.description);
      break;
    case 'TodoWrite':
      return null;
    default:
      value = Object.values(o).map(str).find((v) => v !== null) ?? null;
  }
  return value === null ? null : firstLine(value, TARGET_CHARS);
}

const ACTIVE_TOOL_STATUSES = new Set(['streaming_input', 'pending', 'running']);

/**
 * Live activity of the running turn: the CLI's sentence (`task_summary`, Remote Control only) wins,
 * else the newest running main-thread tool call, else `thinking`. Fed with every item upsert of
 * the current conversation; reset when the turn ends.
 */
export class ActivityTracker {
  private sentence: string | null = null;
  private readonly tools = new Map<string, { tool: string; target: string | null; order: number }>();

  /** True when the item changed what `current()` answers. */
  apply(item: TranscriptItem): boolean {
    if (item.kind !== 'tool_call' || item.parentToolUseId !== null) return false;
    if (ACTIVE_TOOL_STATUSES.has(item.status)) {
      const before = this.tools.get(item.toolUseId);
      const next = {
        tool: item.toolName.slice(0, TOOL_CHARS),
        target: activityTarget(item.toolName, item.input),
        order: item.order,
      };
      if (before?.tool === next.tool && before.target === next.target) return false;
      this.tools.set(item.toolUseId, next);
      return true;
    }
    return this.tools.delete(item.toolUseId);
  }

  /** The CLI's live sentence; null = it has none (the turn ended). */
  setSentence(text: string | null): boolean {
    if (this.sentence === text) return false;
    this.sentence = text;
    return true;
  }

  reset(): void {
    this.sentence = null;
    this.tools.clear();
  }

  current(): SessionActivity {
    if (this.sentence !== null) return { kind: 'claude', text: this.sentence };
    let newest: { tool: string; target: string | null; order: number } | null = null;
    for (const tool of this.tools.values()) if (newest === null || tool.order >= newest.order) newest = tool;
    return newest === null ? { kind: 'thinking' } : { kind: 'tool', tool: newest.tool, target: newest.target };
  }
}

/** Markdown markers that carry no words (headings, lists, quotes, emphasis, code, links, tables). */
function stripMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/^\|+|\|+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fallback turn summary: the first line of the answer that has words after removing Markdown
 * (fences, rules and table separators skipped), ≤ 200 chars; null = nothing usable.
 */
export function fallbackSummary(answer: string | null): string | null {
  if (answer === null) return null;
  let fenced = false;
  for (const raw of answer.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || trimmed === '' || /^([-*_=|:\s])+$/.test(trimmed)) continue;
    const line = stripMarkdown(trimmed);
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    return line.length > FALLBACK_SUMMARY_CHARS ? `${line.slice(0, FALLBACK_SUMMARY_CHARS - 1)}…` : line;
  }
  return null;
}

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

interface Exchange {
  prompt: string | null;
  answer: string | null;
}

/**
 * U+200B in front of a prompt that starts with `/` only because of a pasted text (composer
 * `SLASH_GUARD`, R5W-03; like `titleFromPrompt`): no part of what the title describes.
 */
const LEADING_SLASH_GUARD = /^\u200b+/u;

/** Main-thread prompts typed by a person (no slash commands) and Claude's answers, in order. */
function exchanges(items: readonly TranscriptItem[]): { first: Exchange; last: Exchange } {
  const sorted = [...items].filter((i) => i.parentToolUseId === null).sort((a, b) => a.order - b.order);
  const list: Exchange[] = [];
  for (const item of sorted) {
    if (item.kind === 'user_message') {
      if (item.slashCommand !== null || item.origin !== 'human' || item.text.text.trim() === '') continue;
      list.push({ prompt: item.text.text.trim().replace(LEADING_SLASH_GUARD, ''), answer: null });
    } else if (item.kind === 'assistant_text' && item.localCommand === null && item.text.trim() !== '') {
      const current = list.at(-1);
      if (current === undefined) list.push({ prompt: null, answer: item.text });
      else current.answer ??= item.text;
    }
  }
  const empty = { prompt: null, answer: null };
  return { first: list[0] ?? empty, last: list.at(-1) ?? empty };
}

/** Auto title (§1.3): the first prompt + the start of the first answer; null = no prompt yet. */
export function autoTitleDescription(items: readonly TranscriptItem[]): string | null {
  const { first } = exchanges(items);
  if (first.prompt === null) return null;
  const parts = [clip(first.prompt, TITLE_PART_CHARS)];
  if (first.answer !== null) parts.push(clip(first.answer, TITLE_PART_CHARS));
  return parts.join('\n\n').slice(0, TITLE_DESCRIPTION_CHARS);
}

/**
 * "Generate title again" (§1.3): first prompt, last prompt, start of the last answer; the current
 * title when the transcript holds no prompt (e.g. only imported turns were cut); null = nothing.
 */
export function regenerateTitleDescription(items: readonly TranscriptItem[], title: string): string | null {
  const { first, last } = exchanges(items);
  const parts: string[] = [];
  if (first.prompt !== null) parts.push(clip(first.prompt, 600));
  if (last.prompt !== null && last.prompt !== first.prompt) parts.push(clip(last.prompt, 600));
  if (last.answer !== null) parts.push(clip(last.answer, 600));
  if (parts.length === 0 && title.trim() !== '') parts.push(title.trim());
  return parts.length === 0 ? null : parts.join('\n\n').slice(0, TITLE_DESCRIPTION_CHARS);
}

/**
 * The usage query merged into the profile's last limit info (ADR-114): its windows replace the
 * stored ones, `cleared` windows are dropped; status/type/reset of the last `rate_limit` event stay.
 */
export function mergeUsage(prev: RateLimitInfo | undefined, usage: UsageLimits, at: string): RateLimitInfo {
  const windows: RateLimitInfo['windows'] = {};
  for (const [name, window] of Object.entries(prev?.windows ?? {})) {
    if (!usage.cleared.includes(name)) windows[name] = window;
  }
  for (const [name, window] of Object.entries(usage.windows)) {
    windows[name] = { utilization: window.utilization, resetsAt: window.resetsAt };
  }
  const base = prev ?? { status: 'allowed', rateLimitType: null, resetsAt: null, utilization: null };
  const own = base.rateLimitType === null ? undefined : usage.windows[base.rateLimitType];
  return {
    status: base.status,
    rateLimitType: base.rateLimitType,
    resetsAt: own?.resetsAt ?? base.resetsAt,
    utilization: own?.utilization ?? base.utilization,
    windows,
    at,
  };
}
