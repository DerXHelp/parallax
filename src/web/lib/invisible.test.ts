import { describe, expect, it } from 'vitest';
import { revealInvisible } from './invisible';

describe('revealInvisible', () => {
  it('leaves ordinary text alone', () => {
    expect(revealInvisible('Bash(npm run test:*)')).toBe('Bash(npm run test:*)');
    expect(revealInvisible('Größe ü 漢字 🙂')).toBe('Größe ü 漢字 🙂');
  });

  it('marks control, zero-width and bidi characters', () => {
    expect(revealInvisible('Bash(rm​ -rf)')).toBe('Bash(rm\\u{200B} -rf)');
    expect(revealInvisible('a‮b')).toBe('a\\u{202E}b');
    expect(revealInvisible('x\u0000y\u001bz')).toBe('x\\u{0000}y\\u{001B}z');
    expect(revealInvisible('line next')).toBe('line\\u{2028}next');
  });

  it('marks line breaks and tabs unless the layout is kept', () => {
    expect(revealInvisible('a\nb\tc')).toBe('a\\u{000A}b\\u{0009}c');
    expect(revealInvisible('a\nb\tc​', { keepLayout: true })).toBe('a\nb\tc\\u{200B}');
  });
});
