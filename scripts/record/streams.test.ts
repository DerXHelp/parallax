import { describe, expect, it } from 'vitest';
import { createSanitizer, PLACEHOLDERS } from './sanitize';
import { deltaGroups, resplit } from './streams';
import { sanitizeRecording } from './writer';

function delta(index: number, partial: string, messageId = 'msg_1'): { kind: string; payload: unknown } {
  return {
    kind: 'message',
    payload: {
      type: 'stream_event',
      api_message_id: messageId,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: partial },
      },
    },
  };
}

describe('resplit', () => {
  it('keeps the part count and the concatenation', () => {
    const parts = resplit('<HOME>\\notes.txt', [5, 5, 3]);
    expect(parts).toHaveLength(3);
    expect(parts.join('')).toBe('<HOME>\\notes.txt');
  });

  it('handles empty parts', () => {
    expect(resplit('abc', [0, 0])).toEqual(['', 'abc']);
  });
});

describe('deltaGroups', () => {
  it('groups deltas per message and block index', () => {
    const groups = deltaGroups([delta(0, 'a'), delta(1, 'x'), delta(0, 'b'), delta(0, 'c', 'msg_2')]);
    expect(groups.map((group) => group.map((ref) => ref.eventIndex))).toEqual([[0, 2], [1], [3]]);
  });
});

describe('sanitizeRecording with split secrets', () => {
  it('sanitizes a path that is split across input_json_delta chunks', () => {
    const sanitizer = createSanitizer({ home: 'C:\\Users\\Jane.Doe', username: 'Jane.Doe' });
    const raw = [delta(1, '{"file_path": "C:\\\\Users\\\\Ja'), delta(1, 'ne.Doe\\\\notes.txt"}')].map(
      (event, index) => ({ seq: index + 1, tMs: index, kind: 'message' as const, payload: event.payload }),
    );
    const header = {
      fixtureVersion: 1,
      scenario: 'split',
      sdkVersion: '0',
      cliVersion: '0',
      recordedAt: 'now',
      options: {},
    };
    const text = sanitizeRecording(header, raw, sanitizer, 'split');
    expect(text).not.toMatch(/Ja(?:ne)?/);
    const joined = text
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => {
        const parsed = JSON.parse(line) as { payload: { event: { delta: { partial_json: string } } } };
        return parsed.payload.event.delta.partial_json;
      })
      .join('');
    expect(joined).toBe(`{"file_path": "${PLACEHOLDERS.home}\\\\notes.txt"}`);
  });
});
