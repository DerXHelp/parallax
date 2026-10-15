/**
 * Small shared pieces of the FakeBackend modules (session, player, scripts): errors that end a
 * scenario or a turn, the real macrotask, UUID mapping and prompt helpers.
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { OutgoingPrompt } from '../types';

/** Real setImmediate, captured before a test can install fake timers (playback never needs ticks). */
export const realSetImmediate = setImmediate;

export function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    realSetImmediate(resolve);
  });
}

/** The session stopped (close, crash, exit): ends the scenario quietly. */
export class SessionStopped extends Error {
  constructor() {
    super('fake session stopped');
    this.name = 'SessionStopped';
  }
}

/** The current turn was interrupted (interrupt() or a prompt with priority 'now'). */
export class TurnInterrupted extends Error {
  readonly reason: 'interrupt' | 'now';

  constructor(reason: 'interrupt' | 'now') {
    super(`turn interrupted (${reason})`);
    this.name = 'TurnInterrupted';
    this.reason = reason;
  }
}

/** Answer of the SDK wrapper when the canUseTool handler throws (WP-13 §3.2, F.3). */
export const HANDLER_ERROR_RESULT: PermissionResult = {
  behavior: 'deny',
  message: 'Parallax could not process this request.',
};

/** A recorded control/call answer (`result` or `error`). */
export interface RecordedAnswer {
  result?: unknown;
  error?: unknown;
}

/** Deep copy of a JSON-like value with every string equal to a mapped UUID replaced. */
export function mapUuids(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v: unknown) => mapUuids(v, map));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = mapUuids(v, map);
    return out;
  }
  return value;
}

/** Prompt content as SDK user message content (a string for exactly one text block). */
export function promptContent(prompt: OutgoingPrompt): unknown {
  const only = prompt.content[0];
  if (prompt.content.length === 1 && only?.type === 'text') return only.text;
  return prompt.content.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: block.type, source: { type: 'base64', media_type: block.mediaType, data: block.base64 } },
  );
}

/** Text of a prompt (text blocks joined with a newline). */
export function promptText(prompt: OutgoingPrompt): string {
  return prompt.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}
