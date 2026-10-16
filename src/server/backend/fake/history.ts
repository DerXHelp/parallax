/**
 * FakeHistoryStore (WP-13 §3.3): what `getSessionMessages`/`getSubagentMessages`/`getSessionInfo`
 * would return, in memory and in the RAW SDK shapes – the FakeBackend maps them with
 * `history/parse.ts` exactly like the SdkBackend. Filled live by every played user/assistant
 * message (and sent prompt) or imported from the `history` fixture.
 */
import { z } from 'zod';
import type { ParsedFixture } from '../fixture';
import { fixtureCallPayloadSchema } from '../fixture';
import { toSessionInfo } from '../history/parse';

export interface FakeHistoryStore {
  /** A live SDK message (user/assistant, no replays) → SessionMessage of `sessionId`; others are ignored. */
  record(sessionId: string, raw: unknown): void;
  /** Raw SessionMessage[] of the main conversation. */
  messages(sessionId: string): unknown[];
  /** Subagent conversations (listSubagents + getSubagentMessages). */
  subagents(sessionId: string): { agentId: string; messages: unknown[] }[];
  /** Raw SDKSessionInfo or null. */
  info(sessionId: string): unknown;
  /** The CLI's AI title (summary) of a session. */
  setAiTitle(sessionId: string, title: string): void;
  /** renameSession (custom title). */
  rename(sessionId: string, title: string): void;
  /** Imports the first array/object answer per session id of the `history` fixture. */
  seedFromHistoryFixture(parsed: ParsedFixture): void;
  sessionIds(): string[];
}

interface SessionRecord {
  messages: unknown[];
  subagents: Map<string, unknown[]>;
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  /** summary of an imported getSessionInfo answer. */
  importedSummary: string | null;
  /** Further imported SDKSessionInfo fields (cwd, gitBranch …). */
  extra: Record<string, unknown>;
  lastModified: number;
  seededMessages: boolean;
  seededInfo: boolean;
}

const liveMessageSchema = z.looseObject({
  type: z.enum(['user', 'assistant']),
  uuid: z.string().min(1),
  message: z.unknown().optional(),
  parent_tool_use_id: z.string().nullable().optional().catch(null),
  timestamp: z.string().optional().catch(undefined),
  origin: z.unknown().optional(),
  isReplay: z.boolean().optional().catch(undefined),
  agent_id: z.string().optional().catch(undefined),
});

const textContentSchema = z.union([
  z.string(),
  z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
]);

function promptText(message: unknown): string | null {
  const parsed = z.looseObject({ content: textContentSchema }).safeParse(message);
  if (!parsed.success) return null;
  const content = parsed.data.content;
  if (typeof content === 'string') return content;
  const texts = content.filter((b) => b.type === 'text' && b.text !== undefined).map((b) => b.text ?? '');
  return texts.length === 0 ? null : texts.join('\n');
}

export function createFakeHistoryStore(options: { now?: () => Date } = {}): FakeHistoryStore {
  const now = options.now ?? (() => new Date());
  const sessions = new Map<string, SessionRecord>();

  const recordFor = (sessionId: string): SessionRecord => {
    let record = sessions.get(sessionId);
    if (record === undefined) {
      record = {
        messages: [],
        subagents: new Map(),
        customTitle: null,
        aiTitle: null,
        firstPrompt: null,
        importedSummary: null,
        extra: {},
        lastModified: now().getTime(),
        seededMessages: false,
        seededInfo: false,
      };
      sessions.set(sessionId, record);
    }
    return record;
  };

  return {
    record(sessionId, raw) {
      if (sessionId === '') return;
      const parsed = liveMessageSchema.safeParse(raw);
      if (!parsed.success || parsed.data.isReplay === true) return;
      const m = parsed.data;
      const record = recordFor(sessionId);
      const parentToolUseId = m.parent_tool_use_id ?? null;
      const entry: Record<string, unknown> = {
        type: m.type,
        uuid: m.uuid,
        session_id: sessionId,
        message: m.message,
        parent_tool_use_id: parentToolUseId,
        parent_agent_id: null,
        timestamp: m.timestamp ?? now().toISOString(),
      };
      if (m.origin !== undefined) entry.origin = m.origin;
      if (parentToolUseId !== null) {
        // Subagent messages are not part of the main transcript (F.15, getSubagentMessages).
        const agentId = m.agent_id ?? parentToolUseId;
        const list = record.subagents.get(agentId) ?? [];
        list.push(entry);
        record.subagents.set(agentId, list);
      } else {
        record.messages.push(entry);
        if (m.type === 'user' && record.firstPrompt === null) {
          const text = promptText(m.message);
          if (text !== null && !text.startsWith('/') && !text.startsWith('[Request interrupted'))
            record.firstPrompt = text;
        }
      }
      record.lastModified = now().getTime();
    },

    messages: (sessionId) => [...(sessions.get(sessionId)?.messages ?? [])],

    subagents: (sessionId) =>
      [...(sessions.get(sessionId)?.subagents ?? new Map<string, unknown[]>())].map(
        ([agentId, messages]) => ({
          agentId,
          messages: [...messages],
        }),
      ),

    info(sessionId) {
      const record = sessions.get(sessionId);
      if (record === undefined) return null;
      const summary =
        record.customTitle ?? record.aiTitle ?? record.importedSummary ?? record.firstPrompt ?? '';
      // Like SDK 0.3.296 (WP22-02): customTitle = custom title ‖ AI title.
      const customTitle = record.customTitle ?? record.aiTitle;
      return {
        ...record.extra,
        sessionId,
        summary,
        lastModified: record.lastModified,
        ...(customTitle === null ? {} : { customTitle }),
        ...(record.firstPrompt === null ? {} : { firstPrompt: record.firstPrompt }),
      };
    },

    setAiTitle(sessionId, title) {
      const record = recordFor(sessionId);
      record.aiTitle = title;
      record.lastModified = now().getTime();
    },

    rename(sessionId, title) {
      const record = recordFor(sessionId);
      record.customTitle = title;
      record.lastModified = now().getTime();
    },

    seedFromHistoryFixture(parsed) {
      for (const event of parsed.events) {
        if (event.kind !== 'call') continue;
        const call = fixtureCallPayloadSchema.safeParse(event.payload);
        if (!call.success) continue;
        const { fn, args, result } = call.data;
        const sessionId = typeof args[0] === 'string' ? args[0] : null;
        if (sessionId === null) continue;
        if (fn === 'getSessionMessages' && Array.isArray(result)) {
          const record = recordFor(sessionId);
          if (record.seededMessages) continue;
          record.seededMessages = true;
          record.messages = z.array(z.unknown()).parse(result);
          for (const message of record.messages) {
            if (record.firstPrompt !== null) break;
            const m = liveMessageSchema.safeParse(message);
            if (m.success && m.data.type === 'user') record.firstPrompt = promptText(m.data.message);
          }
        } else if (fn === 'getSubagentMessages' && Array.isArray(result) && typeof args[1] === 'string') {
          const record = recordFor(sessionId);
          if (record.subagents.has(args[1])) continue;
          record.subagents.set(args[1], z.array(z.unknown()).parse(result));
        } else if (fn === 'getSessionInfo') {
          const info = toSessionInfo(result);
          const extra = z.record(z.string(), z.unknown()).safeParse(result);
          if (info === null || !extra.success) continue;
          const record = recordFor(sessionId);
          if (record.seededInfo) continue;
          record.seededInfo = true;
          const {
            sessionId: _id,
            summary: _summary,
            customTitle: _custom,
            firstPrompt: _first,
            lastModified: _modified,
            ...rest
          } = extra.data;
          record.extra = rest;
          record.importedSummary = info.summary;
          record.customTitle = info.customTitle;
          if (info.firstPrompt !== null) record.firstPrompt = info.firstPrompt;
          record.lastModified = info.lastModified;
        }
      }
    },

    sessionIds: () => [...sessions.keys()],
  };
}
