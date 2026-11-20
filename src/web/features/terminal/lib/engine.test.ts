import { describe, expect, it } from 'vitest';
import { isWebLink } from './engine';

describe('isWebLink (WP-99 review)', () => {
  it('accepts absolute http(s) URLs only', () => {
    expect(isWebLink('https://example.com/docs')).toBe(true);
    expect(isWebLink('http://localhost:8080/')).toBe(true);
    expect(isWebLink('javascript:alert(1)')).toBe(false);
    expect(isWebLink('file:///C:/Windows/System32/cmd.exe')).toBe(false);
    expect(isWebLink('vscode://open?file=x')).toBe(false);
    expect(isWebLink('/relative/path')).toBe(false);
    expect(isWebLink('not a url')).toBe(false);
  });
});
