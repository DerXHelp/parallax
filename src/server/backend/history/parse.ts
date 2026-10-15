/**
 * History results of the SDK (worker answers in the SdkBackend, FakeHistoryStore in the
 * FakeBackend) → port types (WP-13 §3.1, F.15, R0-18, R1-07). Tolerant: entries of an unknown
 * type or with broken required fields are skipped and counted in the log, never thrown.
 */
import { z } from 'zod';
import { logger } from '../../lib/logger';
import type { BackendSessionInfo, HistoryMessage } from '../types';

const log = logger.child({ module: 'history' });

/** `SessionMessage` as delivered at runtime (typed without `timestamp`/`origin`, F.15). */
const sessionMessageSchema = z.looseObject({
  type: z.enum(['user', 'assistant', 'system']),
  uuid: z.string().min(1),
  session_id: z.string().min(1),
  message: z.unknown().optional(),
  parent_tool_use_id: z.string().nullable().optional().catch(null),
  timestamp: z.string().nullable().optional().catch(null),
  origin: z.looseObject({ kind: z.string() }).nullable().optional().catch(null),
});

/** `getSessionMessages` / `getSubagentMessages` result → HistoryMessage[] (other types/invalid skipped). */
export function toHistoryMessages(raw: unknown): HistoryMessage[] {
  if (!Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) log.warn({ type: typeof raw }, 'history result is not an array');
    return [];
  }
  const out: HistoryMessage[] = [];
  let skipped = 0;
  for (const entry of raw) {
    const parsed = sessionMessageSchema.safeParse(entry);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const m = parsed.data;
    out.push({
      type: m.type,
      uuid: m.uuid,
      sessionId: m.session_id,
      message: m.message,
      parentToolUseId: m.parent_tool_use_id ?? null,
      timestamp: m.timestamp ?? null,
      origin: m.origin === null || m.origin === undefined ? null : { kind: m.origin.kind },
    });
  }
  if (skipped > 0) log.debug({ skipped, total: raw.length }, 'history: skipped unknown/invalid messages');
  return out;
}

interface Keyed {
  message: HistoryMessage;
  key: number;
}

/** Sort keys of one list: Date.parse(timestamp); without a (valid) timestamp the predecessor's key. */
function keyed(list: readonly HistoryMessage[]): Keyed[] {
  let previous = Number.NEGATIVE_INFINITY;
  return list.map((message) => {
    const time = message.timestamp === null ? Number.NaN : Date.parse(message.timestamp);
    if (!Number.isNaN(time)) previous = time;
    return { message, key: previous };
  });
}

/**
 * Main + subagent messages merged by time (R0-18): a stable k-way merge – every list keeps its own
 * order, the smallest head key wins, ties go to the earlier list (main first). A message without
 * timestamp keeps its predecessor's key, so it stays right behind it.
 */
export function mergeHistory(
  main: HistoryMessage[],
  subagents: readonly HistoryMessage[][],
): HistoryMessage[] {
  const lists = [main, ...subagents].map(keyed);
  const heads = lists.map(() => 0);
  const out: HistoryMessage[] = [];
  for (;;) {
    let best = -1;
    let bestKey = Number.POSITIVE_INFINITY;
    lists.forEach((list, index) => {
      const head = list[heads[index] ?? 0];
      if (head === undefined) return;
      if (best < 0 || head.key < bestKey) {
        best = index;
        bestKey = head.key;
      }
    });
    if (best < 0) return out;
    const list = lists[best];
    const position = heads[best] ?? 0;
    const head = list?.[position];
    if (head === undefined) return out;
    out.push(head.message);
    heads[best] = position + 1;
  }
}

const sessionInfoSchema = z.looseObject({
  sessionId: z.string().min(1),
  summary: z.string().catch(''),
  lastModified: z.number().catch(0),
  customTitle: z.string().nullable().optional().catch(null),
  firstPrompt: z.string().nullable().optional().catch(null),
});

/** `SDKSessionInfo` → port type; null for null/undefined/unusable answers. */
export function toSessionInfo(raw: unknown): BackendSessionInfo | null {
  if (raw === null || raw === undefined) return null;
  const parsed = sessionInfoSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn({ issue: parsed.error.issues[0]?.message ?? 'invalid' }, 'session info unusable');
    return null;
  }
  const info = parsed.data;
  return {
    sessionId: info.sessionId,
    summary: info.summary,
    customTitle: info.customTitle ?? null,
    firstPrompt: info.firstPrompt ?? null,
    lastModified: info.lastModified,
  };
}
