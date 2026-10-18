/**
 * The fake external console (Phase 2, WP-34, ADR-104): what a turn in the visible console leaves
 * in the CLI transcript – one user and one assistant message in the RAW `SessionMessage` shape,
 * both with the timestamp of the turn, appended to the FakeHistoryStore by
 * `FakeBackend.simulateConsoleTurn`. The engine imports them on return (`readHistory` →
 * `normalizeHistory`) like the real ones (Findings F.15: messages carry timestamps).
 */
import { resolveFakeModel } from './defaults';
import type { FakeIds } from './types';

/** Default text of a simulated console turn. */
export const FAKE_CONSOLE_PROMPT = 'Hello from the external console';

/** The fake CLI's answer in the console. */
export function fakeConsoleAnswer(text: string): string {
  return `Fake console: ${text}`;
}

export function consoleTurnMessages(o: {
  sessionId: string;
  at: Date;
  text: string;
  ids: FakeIds;
}): Record<string, unknown>[] {
  const timestamp = o.at.toISOString();
  return [
    {
      type: 'user',
      uuid: o.ids.uuid(),
      session_id: o.sessionId,
      message: { role: 'user', content: o.text },
      parent_tool_use_id: null,
      timestamp,
      origin: { kind: 'human' },
    },
    {
      type: 'assistant',
      uuid: o.ids.uuid(),
      session_id: o.sessionId,
      message: {
        id: o.ids.messageId(),
        type: 'message',
        role: 'assistant',
        model: resolveFakeModel(null),
        content: [{ type: 'text', text: fakeConsoleAnswer(o.text) }],
        stop_reason: 'end_turn',
      },
      parent_tool_use_id: null,
      timestamp,
    },
  ];
}
