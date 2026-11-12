import { describe, expect, it } from 'vitest';
import {
  applyMention,
  indexPaths,
  insideCode,
  matchPaths,
  MENTION_MATCHES_MAX,
  mentionAt,
  mentionText,
  splitPath,
} from './mentions';

describe('mentionAt (ADR-151)', () => {
  it('opens for @ at the text start or after whitespace and brackets', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(mentionAt('see @src/ma', 11)).toEqual({ start: 4, end: 11, query: 'src/ma' });
    expect(mentionAt('line\n@do', 8)).toEqual({ start: 5, end: 8, query: 'do' });
    expect(mentionAt('(@a', 3)?.query).toBe('a');
  });

  it('not inside a word or an e-mail address, not after whitespace was typed', () => {
    expect(mentionAt('mail me at alex@example.org', 27)).toBeNull();
    expect(mentionAt('foo@', 4)).toBeNull();
    expect(mentionAt('@src done', 9)).toBeNull();
    expect(mentionAt('no at sign', 5)).toBeNull();
  });

  it('not in inline code or a fenced block', () => {
    expect(mentionAt('run `npm i @types/node', 22)).toBeNull();
    expect(mentionAt('```\n@decorator', 14)).toBeNull();
    expect(mentionAt('```\ncode\n```\n@after', 19)?.query).toBe('after');
    expect(insideCode('a `b` @c', 6)).toBe(false);
  });

  it('the word end includes text after the caret; a leading quote is not part of the query', () => {
    expect(mentionAt('@srcmore rest', 4)).toEqual({ start: 0, end: 8, query: 'src' });
    expect(mentionAt('@"docs/Meet', 11)?.query).toBe('docs/Meet');
  });
});

describe('applyMention', () => {
  it('inserts @path plus one space and puts the caret behind it', () => {
    const text = 'look at @comp please';
    const mention = mentionAt(text, 13);
    if (mention === null) throw new Error('no mention');
    expect(applyMention(text, mention, 'src/Composer.tsx')).toEqual({
      text: 'look at @src/Composer.tsx please',
      caret: 26,
    });
  });

  it('paths with whitespace are quoted', () => {
    expect(mentionText('docs/Meeting Notes/a.md')).toBe('@"docs/Meeting Notes/a.md"');
    const mention = mentionAt('@meet', 5);
    if (mention === null) throw new Error('no mention');
    expect(applyMention('@meet', mention, 'docs/Meeting Notes/a.md')).toEqual({
      text: '@"docs/Meeting Notes/a.md" ',
      caret: 27,
    });
  });
});

describe('matchPaths', () => {
  const index = indexPaths([
    'README.md',
    'src/web/features/composer/Composer.tsx',
    'src/web/features/composer/lib/mentions.ts',
    'docs/Meeting Notes/Review.md',
  ]);

  it('fuzzy over the relative path; an empty query keeps the list order', () => {
    expect(matchPaths(index, 'compjsx').matches).toEqual([]);
    expect(matchPaths(index, 'composer.tsx').matches[0]).toBe('src/web/features/composer/Composer.tsx');
    expect(matchPaths(index, 'mention').matches).toEqual(['src/web/features/composer/lib/mentions.ts']);
    expect(matchPaths(index, '').matches).toEqual(index.paths);
    expect(matchPaths(index, 'meeting notes').matches).toEqual(['docs/Meeting Notes/Review.md']);
  });

  it(`shows at most ${String(MENTION_MATCHES_MAX)} and counts all matches`, () => {
    const many = indexPaths(Array.from({ length: 20_000 }, (_, i) => `pkg/module-${String(i)}/index.ts`));
    const result = matchPaths(many, 'index');
    expect(result.matches).toHaveLength(MENTION_MATCHES_MAX);
    expect(result.total).toBe(20_000);
  });

  it('splits name and folder', () => {
    expect(splitPath('src/a/b.ts')).toEqual({ name: 'b.ts', folder: 'src/a' });
    expect(splitPath('README.md')).toEqual({ name: 'README.md', folder: '' });
  });
});
