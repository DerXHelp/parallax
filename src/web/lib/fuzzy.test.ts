import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it.each([
    // query, text, matches
    ['', 'anything', true],
    ['   ', 'anything', true],
    ['abc', 'abc', true],
    ['abc', 'a_b_c', true],
    ['ABC', 'abc', true],
    ['auth', 'Refactoring Auth-Service', true],
    ['rfas', 'Refactoring Auth-Service', true],
    ['uber', 'Über die Session', true],
    ['über', 'Uber die Session', true],
    ['feat login', 'feature/login', true],
    ['cba', 'abc', false],
    ['xyz', 'abc', false],
    ['abcd', 'abc', false],
    ['a', '', false],
  ])('%j in %j → %s', (query, text, matches) => {
    expect(fuzzyScore(query, text) !== null).toBe(matches);
  });

  it('scores an empty query 0', () => {
    expect(fuzzyScore('', 'abc')).toBe(0);
  });

  it('prefers prefixes, word starts and runs', () => {
    const score = (query: string, text: string) => fuzzyScore(query, text) ?? Number.NEGATIVE_INFINITY;
    expect(score('fb', 'foo bar')).toBeGreaterThan(score('fb', 'afbx'));
    expect(score('abc', 'abc')).toBeGreaterThan(score('abc', 'a_b_c'));
    expect(score('log', 'login page')).toBeGreaterThan(score('log', 'my catalog'));
    // camelCase humps count as word starts.
    expect(score('ps', 'parseSession')).toBeGreaterThan(score('ps', 'lapsxxxxxxxx'));
    // Ties: the shorter text wins.
    expect(score('ab', 'ab')).toBeGreaterThan(score('ab', 'ab cd'));
  });
});

describe('fuzzyFilter', () => {
  const items = [
    { title: 'Landing page copy', branch: 'main' },
    { title: 'Refactoring Auth-Service', branch: 'feature/login' },
    { title: 'Fix the login redirect', branch: 'fix/redirect-loop' },
  ];
  const keys = (item: (typeof items)[number]) => [item.title, item.branch];

  it('keeps all items in order for an empty query', () => {
    expect(fuzzyFilter(items, '  ', keys)).toEqual(items);
  });

  it('needs every token somewhere in the keys and sorts best first', () => {
    expect(
      fuzzyFilter(items, 'login', keys)
        .map((item) => item.title)
        .sort(),
    ).toEqual(['Fix the login redirect', 'Refactoring Auth-Service']);
    expect(fuzzyFilter(['my catalog', 'login page'], 'log', (text) => [text])).toEqual([
      'login page',
      'my catalog',
    ]);
    // Tokens may match different keys.
    expect(fuzzyFilter(items, 'auth login', keys).map((item) => item.title)).toEqual([
      'Refactoring Auth-Service',
    ]);
    expect(fuzzyFilter(items, 'nothing-like-this', keys)).toEqual([]);
  });

  it('keeps the input order for equal scores', () => {
    const twins = [{ title: 'same' }, { title: 'same' }];
    const result = fuzzyFilter(twins, 'sa', (item) => [item.title]);
    expect(result[0]).toBe(twins[0]);
    expect(result[1]).toBe(twins[1]);
  });
});
