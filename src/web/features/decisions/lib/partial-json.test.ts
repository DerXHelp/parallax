import { describe, expect, it } from 'vitest';
import { partialJsonString } from './partial-json';

describe('partialJsonString (streamed tool input, ADR-148)', () => {
  it.each([
    // [partial input, field, expected]
    ['', 'content', null],
    ['   ', 'content', null],
    ['[', 'content', null],
    ['{', 'content', null],
    ['{"', 'content', null],
    ['{"cont', 'content', null],
    ['{"content"', 'content', null],
    ['{"content":', 'content', null],
    ['{"content": ', 'content', null],
    ['{"content":"', 'content', { value: '', complete: false }],
    ['{"content":"# Pl', 'content', { value: '# Pl', complete: false }],
    ['{"content":"# Plan"', 'content', { value: '# Plan', complete: true }],
    ['{"content":"# Plan"}', 'content', { value: '# Plan', complete: true }],
    ['{ "content" : "a" }', 'content', { value: 'a', complete: true }],
    // Other keys first: strings with quotes, escapes and braces are skipped as a whole.
    ['{"file_path":"C:\\\\plans\\\\a.md","content":"x', 'content', { value: 'x', complete: false }],
    ['{"file_path":"say \\"content\\": no","content":"y"', 'content', { value: 'y', complete: true }],
    ['{"meta":{"content":"inner","n":[1,"}"]},"content":"z', 'content', { value: 'z', complete: false }],
    ['{"n":12,"ok":true,"none":null,"content":"v"', 'content', { value: 'v', complete: true }],
    // A value of another key still incomplete: the field cannot have arrived yet.
    ['{"file_path":"C:\\\\pla', 'content', null],
    ['{"meta":{"a":1', 'content', null],
    ['{"n":12', 'content', null],
    // The key exists but holds no string.
    ['{"content":42}', 'content', null],
    ['{"content":{"a":"b"}}', 'content', null],
    // Only top-level keys match.
    ['{"meta":{"content":"inner"}}', 'content', null],
    ['{"file_path":"C:\\\\plans\\\\a.md"', 'file_path', { value: 'C:\\plans\\a.md', complete: true }],
  ] as const)('%j → %s = %j', (partial, field, expected) => {
    expect(partialJsonString(partial, field)).toEqual(expected);
  });

  it.each([
    // Simple escapes.
    ['{"content":"a\\nb\\tc\\"d\\\\e\\/f\\rg"', 'a\nb\tc"d\\e/f\rg', true],
    ['{"content":"\\b\\f"', '\b\f', true],
    // A cut escape is left out until it is complete.
    ['{"content":"line\\', 'line', false],
    ['{"content":"line\\n', 'line\n', false],
    ['{"content":"\\u', '', false],
    ['{"content":"x\\u00', 'x', false],
    ['{"content":"x\\u00e', 'x', false],
    ['{"content":"x\\u00e4', 'xä', false],
    ['{"content":"x\\u00E4y"', 'xäy', true],
    // Surrogate pairs: the high half waits for the low half.
    ['{"content":"\\ud83d', '', false],
    ['{"content":"\\ud83d\\', '', false],
    ['{"content":"\\ud83d\\u', '', false],
    ['{"content":"\\ud83d\\ude0', '', false],
    ['{"content":"\\ud83d\\ude00', '😀', false],
    ['{"content":"\\ud83d\\ude00!"', '😀!', true],
    // A lone high surrogate followed by text is kept as it is (never throws).
    ['{"content":"\\ud83dx"', '\ud83dx', true],
    // Lenient: unknown escapes keep the character, a malformed \\u is skipped.
    ['{"content":"\\q"', 'q', true],
    ['{"content":"\\uZZZZ!"', 'ZZZZ!', true],
    // Raw text and Unicode pass through.
    ['{"content":"Größe – ok"', 'Größe – ok', true],
  ] as const)('decodes %j to %j (complete: %s)', (partial, value, complete) => {
    expect(partialJsonString(partial, 'content')).toEqual({ value, complete });
  });

  it('reads a JSON.stringify output at every cut point without throwing', () => {
    const content = '# Plan\n\n- "quoted" \\ path C:\\x\n- emoji 😀 and ä\n';
    const raw = JSON.stringify({ file_path: 'C:\\Users\\u\\.claude\\plans\\p.md', content });
    let last = '';
    for (let end = 0; end <= raw.length; end++) {
      const read = partialJsonString(raw.slice(0, end), 'content');
      const value = read?.value ?? '';
      // The decoded text only ever grows and is always a prefix of the final text.
      expect(content.startsWith(value)).toBe(true);
      expect(value.length).toBeGreaterThanOrEqual(last.length);
      last = value;
    }
    expect(partialJsonString(raw, 'content')).toEqual({ value: content, complete: true });
  });
});
