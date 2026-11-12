import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import {
  activePastes,
  convertPaste,
  DRAFT_PASTES_MAX_CHARS,
  expandPastes,
  expandPrompt,
  insertAt,
  isLargePaste,
  lineCount,
  nextPasteId,
  normalizePastedText,
  pasteRefusal,
  removePasteToken,
  SLASH_GUARD,
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
    expect(result.text).toBe(`see ${one.text}\nand ${two.text}\nand again ${one.text}`);
    expect(result.pastes).toEqual([one.text, two.text]);
    for (const pasted of result.pastes) expect(result.text.includes(pasted)).toBe(true);
    expect(expandPastes('plain', [one])).toEqual({ text: 'plain', pastes: [] });
  });

  it('expand is one pass: a paste that contains another token stays as it is', () => {
    const inner = paste(1, 'inner text');
    const outer = paste(2, `quoted ${inner.token} verbatim`);
    const result = expandPastes(`${outer.token} ${inner.token}`, [inner, outer]);
    expect(result.text).toBe(`quoted ${inner.token} verbatim\n${inner.text}`);
    expect(result.pastes).toEqual([outer.text, inner.text]);
  });

  it('V4-07: text after a paste in the same line starts a line of its own', () => {
    // The spaces between token and text go; the paste itself stays verbatim.
    expect(expandPastes(`${one.token} what is wrong?`, [one]).text).toBe(`${one.text}\nwhat is wrong?`);
    expect(expandPastes(`${one.token}\t  x`, [one]).text).toBe(`${one.text}\nx`);
    // Two tokens in a row: each paste on its own lines.
    expect(expandPastes(`${one.token}${two.token}`, [one, two]).text).toBe(`${one.text}\n${two.text}`);
  });

  it('V4-07: no extra line break at the end, before a line break or after a paste ending with one', () => {
    expect(expandPastes(`look: ${one.token}`, [one]).text).toBe(`look: ${one.text}`);
    expect(expandPastes(`${one.token}  `, [one]).text).toBe(`${one.text}  `);
    expect(expandPastes(`${one.token}\nnext`, [one]).text).toBe(`${one.text}\nnext`);
    expect(expandPastes(`${one.token}  \nnext`, [one]).text).toBe(`${one.text}  \nnext`);
    const ending = paste(4, `${lines(30)}\n`);
    expect(expandPastes(`${ending.token} more`, [ending]).text).toBe(`${ending.text} more`);
  });

  it('R5W-03: a prompt that starts with "/" only because of a paste gets the guard in front', () => {
    const command = paste(1, `/clear\n${lines(40)}`);
    const result = expandPrompt(`${command.token} why?`, [command]);
    expect(result.text).toBe(`${SLASH_GUARD}${command.text}\nwhy?`);
    expect(result.text.startsWith('/')).toBe(false);
    expect(result.text.trim().startsWith('/')).toBe(false);
    expect(result.pastes).toEqual([command.text]);
    expect(result.text.includes(command.text)).toBe(true);
    // Leading whitespace in the paste does not help a command through either.
    const indented = paste(2, `  /model opus\n${lines(30)}`);
    expect(expandPrompt(indented.token, [indented]).text).toBe(`${SLASH_GUARD}${indented.text}`);
  });

  it('R5W-03: a typed command stays a command; other prompts stay as they are', () => {
    const command = paste(1, `/clear\n${lines(40)}`);
    expect(expandPrompt(`/review ${command.token}`, [command]).text).toBe(`/review ${command.text}`);
    expect(expandPrompt('/compact', []).text).toBe('/compact');
    expect(expandPrompt(`see ${command.token}`, [command]).text).toBe(`see ${command.text}`);
    expect(expandPrompt(one.token, [one]).text).toBe(one.text);
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
