import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import {
  activePastes,
  convertPaste,
  DRAFT_PASTES_MAX_CHARS,
  expandPastes,
  insertAt,
  isLargePaste,
  lineCount,
  nextPasteId,
  normalizePastedText,
  pasteRefusal,
  removePasteToken,
  type DraftPaste,
} from './pastes';

function paste(id: number, text: string): DraftPaste {
  return { id, token: `[#${String(id)} · ${String(lineCount(text))} lines]`, text };
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${String(i + 1)}`).join('\n');
}

describe('paste thresholds (ADR-146)', () => {
  it('a chip from 2 000 characters on', () => {
    expect(isLargePaste('x'.repeat(1999))).toBe(false);
    expect(isLargePaste('x'.repeat(2000))).toBe(true);
  });

  it('… or from 30 lines on (a final line break starts no line)', () => {
    expect(lineCount(lines(29))).toBe(29);
    expect(isLargePaste(lines(29))).toBe(false);
    expect(isLargePaste(`${lines(29)}\n`)).toBe(false);
    expect(isLargePaste(lines(30))).toBe(true);
    expect(lineCount('')).toBe(0);
    expect(lineCount('a\nb\n')).toBe(2);
  });

  it('normalizes Windows line breaks like a textarea', () => {
    expect(normalizePastedText('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
});

describe('tokens', () => {
  const one = paste(1, lines(40));
  const two = paste(2, 'y'.repeat(2500));

  it('active pastes: only those whose token stands in the text, in text order', () => {
    expect(activePastes(`b ${two.token} a ${one.token}`, [one, two])).toEqual([two, one]);
    expect(activePastes('no tokens', [one, two])).toEqual([]);
    expect(nextPasteId([one, two])).toBe(3);
    expect(nextPasteId([])).toBe(1);
  });

  it('expand: every token replaced, each used text once and verbatim in the result', () => {
    const text = `see ${one.token} and ${two.token} and again ${one.token}`;
    const result = expandPastes(text, [one, two, paste(3, 'unused')]);
    expect(result.text).toBe(`see ${one.text} and ${two.text} and again ${one.text}`);
    expect(result.pastes).toEqual([one.text, two.text]);
    for (const pasted of result.pastes) expect(result.text.includes(pasted)).toBe(true);
    expect(expandPastes('plain', [one])).toEqual({ text: 'plain', pastes: [] });
  });

  it('expand is one pass: a paste that contains another token stays as it is', () => {
    const inner = paste(1, 'inner text');
    const outer = paste(2, `quoted ${inner.token} verbatim`);
    const result = expandPastes(`${outer.token} ${inner.token}`, [inner, outer]);
    expect(result.text).toBe(`quoted ${inner.token} verbatim ${inner.text}`);
    expect(result.pastes).toEqual([outer.text, inner.text]);
  });

  it('remove deletes the token, convert puts the text in its place (caret behind it)', () => {
    expect(removePasteToken(`a ${one.token} b`, one)).toBe('a  b');
    const converted = convertPaste(`a ${one.token} b`, one);
    expect(converted.text).toBe(`a ${one.text} b`);
    expect(converted.caret).toBe(2 + one.text.length);
  });

  it('insertAt replaces the selection and puts the caret after the insert', () => {
    expect(insertAt('hello world', 6, 11, 'there')).toEqual({ text: 'hello there', caret: 11 });
    expect(insertAt('abc', 99, 99, 'd')).toEqual({ text: 'abcd', caret: 4 });
  });
});

describe('limits', () => {
  it(`at most ${String(LIMITS.pastesMax)} chips; then the paste goes in as text`, () => {
    const pastes = Array.from({ length: LIMITS.pastesMax }, (_, i) => paste(i + 1, `text ${String(i)}`));
    const text = pastes.map((p) => p.token).join(' ');
    expect(pasteRefusal(text, pastes, lines(40))).toBe('count');
    // Pastes whose token was deleted do not count.
    expect(pasteRefusal(text.replace(pastes[0]?.token ?? '', ''), pastes, lines(40))).toBeNull();
  });

  it('over ~200 kB per draft the paste goes in as text (no chip)', () => {
    const big = paste(1, 'z'.repeat(DRAFT_PASTES_MAX_CHARS - 10));
    expect(pasteRefusal(big.token, [big], 'x'.repeat(2000))).toBe('size');
    expect(pasteRefusal('', [], 'x'.repeat(DRAFT_PASTES_MAX_CHARS))).toBeNull();
  });
});
