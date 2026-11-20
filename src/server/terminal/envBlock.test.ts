import { describe, expect, it } from 'vitest';
import { environmentBlock } from './envBlock';

function decode(block: Buffer): string[] {
  const text = block.toString('utf16le');
  expect(text.endsWith('\0\0')).toBe(true);
  return text.slice(0, -2).split('\0');
}

describe('environmentBlock (WP-98)', () => {
  it('sorts by name without case and ends with two NULs', () => {
    expect(decode(environmentBlock({ path: 'C:\\x', Alpha: '1', beta: 'ä ö', ComSpec: 'cmd' }))).toEqual([
      'Alpha=1',
      'beta=ä ö',
      'ComSpec=cmd',
      'path=C:\\x',
    ]);
  });

  it('keeps the first of names that differ only in case and drops invalid entries', () => {
    expect(
      decode(
        environmentBlock({
          Path: 'first',
          PATH: 'second',
          '': 'empty name',
          'A=B': 'equals in the name',
          '=C:': 'C:\\drive',
          NUL: 'a\0b',
          GONE: undefined,
        }),
      ),
    ).toEqual(['=C:=C:\\drive', 'Path=first']);
  });

  it('an empty environment is a valid block', () => {
    expect(environmentBlock({}).toString('utf16le')).toBe('\0\0');
  });
});
