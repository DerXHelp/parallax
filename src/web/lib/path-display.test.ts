import { describe, expect, it } from 'vitest';
import { pathTail, splitPathTail } from './path-display';

describe('splitPathTail (WP41-02: the project folder stays visible)', () => {
  it('splits the tail into the part that may shrink, the separator and the last segment', () => {
    expect(splitPathTail('C:\\Users\\me\\AppData\\Local\\Temp\\parallax-live2-20261018-183959\\p1')).toEqual({
      head: 'parallax-live2-20261018-183959',
      separator: '\\',
      last: 'p1',
    });
    expect(splitPathTail('/home/user/project/src')).toEqual({ head: 'project', separator: '/', last: 'src' });
    expect(splitPathTail('D:\\1\\2\\3\\4', 3)).toEqual({ head: '2\\3', separator: '\\', last: '4' });
  });

  it('short paths, drive roots, trailing separators and single segments', () => {
    // Short paths are kept whole by pathTail: the drive is the head.
    expect(splitPathTail('D:\\work')).toEqual({ head: 'D:', separator: '\\', last: 'work' });
    expect(splitPathTail('D:\\work\\demo', 1)).toEqual({ head: '', separator: '', last: 'demo' });
    expect(splitPathTail('C:\\')).toEqual({ head: '', separator: '', last: 'C:\\' });
    expect(splitPathTail('D:\\a\\')).toEqual({ head: 'D:', separator: '\\', last: 'a\\' });
    expect(splitPathTail('/home')).toEqual({ head: '', separator: '/', last: 'home' });
    expect(splitPathTail('project')).toEqual({ head: '', separator: '', last: 'project' });
    expect(splitPathTail('')).toEqual({ head: '', separator: '', last: '' });
  });

  it('the three parts always give the tail back (the visible text stays the same)', () => {
    for (const path of [
      'C:\\a\\b\\c',
      'D:/x/y',
      'D:\\a\\',
      'C:\\',
      '\\\\server\\share',
      'D:\\very-long-folder-name-without-end\\x',
      'D:\\a\\\\b',
    ]) {
      for (const count of [1, 2, 3]) {
        const { head, separator, last } = splitPathTail(path, count);
        expect(head + separator + last, `${path} ${String(count)}`).toBe(pathTail(path, count));
      }
    }
  });
});
