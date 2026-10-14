import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('drops falsy values and merges conflicting utilities', () => {
    expect(cn('px-2 py-1', undefined, null, false, 'px-4')).toBe('py-1 px-4');
  });

  it('supports conditional class objects', () => {
    expect(cn('text-sm', { 'font-bold': true, italic: false })).toBe('text-sm font-bold');
  });
});
