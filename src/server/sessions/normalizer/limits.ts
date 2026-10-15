/**
 * Size rules of the item model (docs/architecture.md §6, R0-11): text fields over
 * LIMITS.itemTextChars and structured results over LIMITS.itemStructuredChars move into the blob
 * cache (`truncated.blobId`); every item stays within LIMITS.itemTotalChars (assistant text and
 * plan text exempt). Pure apart from `storeBlob` (content-addressed, synchronous hash).
 */
import { LIMITS, type JsonValue } from '@shared/common';
import type { CappedText, ToolCallItem, ToolResultContent, Truncation } from '@shared/model';
import type { NormalizerContext } from '../ports';

export type BlobSink = Pick<NormalizerContext, 'storeBlob'>;

/** JSON size in UTF-16 code units, the unit of every LIMITS.*Chars value. */
export function jsonChars(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Cut position that never splits a surrogate pair. */
function safeCut(text: string, limit: number): number {
  if (limit <= 0) return 0;
  const code = text.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

/** Text capped at `limit`; the full text goes to a blob (`text/plain`). */
export function capText(text: string, sink: BlobSink, limit: number = LIMITS.itemTextChars): CappedText {
  if (text.length <= limit) return { text, truncated: null };
  const ref = sink.storeBlob(text, 'text/plain; charset=utf-8');
  return { text: text.slice(0, safeCut(text, limit)), truncated: { totalChars: text.length, blobId: ref.blobId } };
}

/** Shortens an already capped text further; keeps the blob of the original full text. */
export function shrinkCapped(value: CappedText, limit: number, sink: BlobSink): CappedText {
  if (value.text.length <= limit) return value;
  if (value.truncated !== null) {
    return { text: value.text.slice(0, safeCut(value.text, limit)), truncated: value.truncated };
  }
  return capText(value.text, sink, limit);
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns `value` with every string longer than `limit` cut (exempt top-level keys untouched). */
function cutStrings(value: JsonValue, limit: number, exempt: ReadonlySet<string>, depth = 0): JsonValue {
  if (typeof value === 'string') return value.length > limit ? value.slice(0, safeCut(value, limit)) : value;
  if (Array.isArray(value)) return value.map((v) => cutStrings(v, limit, exempt, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = depth === 0 && exempt.has(key) ? v : cutStrings(v, limit, exempt, depth + 1);
    }
    return out;
  }
  return value;
}

function longestString(value: JsonValue, exempt: ReadonlySet<string>, depth = 0): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce<number>((m, v) => Math.max(m, longestString(v, exempt, depth + 1)), 0);
  if (isRecord(value)) {
    let max = 0;
    for (const [key, v] of Object.entries(value)) {
      if (depth === 0 && exempt.has(key)) continue;
      max = Math.max(max, longestString(v, exempt, depth + 1));
    }
    return max;
  }
  return 0;
}

/** Input keys that are never capped: ExitPlanMode's plan text (LIMITS: "plan text exempt"). */
export function exemptInputKeys(toolName: string): ReadonlySet<string> {
  return toolName === 'ExitPlanMode' ? PLAN_KEYS : NO_KEYS;
}
const PLAN_KEYS: ReadonlySet<string> = new Set(['plan']);
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Tool input with long string values capped in place (Write.content …). The full input goes to
 * ONE blob (`application/json`); `previous` keeps an existing blob of the original input.
 */
export function capInput(
  input: JsonValue,
  toolName: string,
  sink: BlobSink,
  limit: number = LIMITS.itemTextChars,
  previous: Truncation | null = null,
): { input: JsonValue; inputTruncated: Truncation | null } {
  const exempt = exemptInputKeys(toolName);
  if (longestString(input, exempt) <= limit) return { input, inputTruncated: previous };
  if (previous !== null) return { input: cutStrings(input, limit, exempt), inputTruncated: previous };
  const full = JSON.stringify(input);
  const ref = sink.storeBlob(full, 'application/json');
  return {
    input: cutStrings(input, limit, exempt),
    inputTruncated: { totalChars: full.length, blobId: ref.blobId },
  };
}

/** `tool_use_result` capped as a whole: over LIMITS.itemStructuredChars it moves into a blob. */
export function capStructured(
  structured: JsonValue | null,
  sink: BlobSink,
  limit: number = LIMITS.itemStructuredChars,
): { structured: JsonValue | null; structuredTruncated: Truncation | null } {
  if (structured === null) return { structured: null, structuredTruncated: null };
  const full = JSON.stringify(structured);
  if (full.length <= limit) return { structured, structuredTruncated: null };
  const ref = sink.storeBlob(full, 'application/json');
  return { structured: null, structuredTruncated: { totalChars: full.length, blobId: ref.blobId } };
}

const LINE_NUMBER_PREFIX = /^ *\d+\t/gm;

/**
 * R0-11: for Bash/PowerShell/Read, fields of `structured` that are already contained in the
 * tool_result text (`stdout`, `stderr`, `file.content`) are removed – no duplicate text.
 */
export function dedupeStructured(toolName: string, structured: JsonValue, contentText: string): JsonValue {
  if (!isRecord(structured)) return structured;
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return Object.fromEntries(
      Object.entries(structured).filter(
        ([key, value]) => !((key === 'stdout' || key === 'stderr') && typeof value === 'string' && contentText.includes(value)),
      ),
    );
  }
  if (toolName === 'Read') {
    const file = structured.file;
    if (file !== undefined && isRecord(file) && typeof file.content === 'string') {
      const plain = contentText.replace(LINE_NUMBER_PREFIX, '');
      if (plain.includes(file.content) || contentText.includes(file.content)) {
        const { content: _content, ...rest } = file;
        return { ...structured, file: rest };
      }
    }
  }
  return structured;
}

/** Progressive caps used to fit an item into LIMITS.itemTotalChars. */
const SHRINK_STEPS = [16 * 1024, 4 * 1024, 1024, 256] as const;

function shrinkContent(content: ToolResultContent[], limit: number, sink: BlobSink): ToolResultContent[] {
  return content.map((part) => (part.type === 'text' ? { ...part, text: shrinkCapped(part.text, limit, sink) } : part));
}

/**
 * R0-11 budget: over LIMITS.itemTotalChars move content into blobs in this order –
 * result.structured → result text parts → input strings (→ raw partial input). Deterministic.
 */
export function fitToolCall(item: ToolCallItem, sink: BlobSink, budget: number = LIMITS.itemTotalChars): ToolCallItem {
  let current = item;
  if (jsonChars(current) <= budget) return current;

  const result = current.result;
  if (result !== null && result.structured !== null) {
    const full = JSON.stringify(result.structured);
    const ref = sink.storeBlob(full, 'application/json');
    current = {
      ...current,
      result: { ...result, structured: null, structuredTruncated: { totalChars: full.length, blobId: ref.blobId } },
    };
    if (jsonChars(current) <= budget) return current;
  }

  for (const step of SHRINK_STEPS) {
    const r = current.result;
    if (r === null) break;
    current = { ...current, result: { ...r, content: shrinkContent(r.content, step, sink) } };
    if (jsonChars(current) <= budget) return current;
  }

  for (const step of SHRINK_STEPS) {
    const capped = capInput(current.input, current.toolName, sink, step, current.inputTruncated);
    current = { ...current, input: capped.input, inputTruncated: capped.inputTruncated };
    if (current.inputPartial !== null && current.inputPartial.length > step) {
      current = { ...current, inputPartial: current.inputPartial.slice(0, safeCut(current.inputPartial, step)) };
    }
    if (jsonChars(current) <= budget) return current;
  }
  return current;
}

/** Caps a list of capped texts so that together they stay below `budget` chars (memory_recall). */
export function shareBudget<T extends { content: CappedText | null }>(entries: T[], budget: number, sink: BlobSink): T[] {
  const withContent = entries.filter((e) => e.content !== null).length;
  if (withContent === 0) return entries;
  const each = Math.max(256, Math.floor(budget / withContent));
  return entries.map((e) => (e.content === null ? e : { ...e, content: shrinkCapped(e.content, each, sink) }));
}
