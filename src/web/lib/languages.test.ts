import { describe, expect, it } from 'vitest';
import { languageForPath, resolveLanguage } from './languages';

describe('languages', () => {
  it('resolves fence info strings and file names', () => {
    expect(resolveLanguage('ts')).toBe('typescript');
    expect(resolveLanguage('TypeScript {1,3}')).toBe('typescript');
    expect(resolveLanguage('ps1')).toBe('powershell');
    expect(resolveLanguage('brainfuck')).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
    expect(languageForPath('D:\\work\\a.tsx')).toBe('tsx');
    expect(languageForPath('/x/Dockerfile')).toBe('docker');
    expect(languageForPath('README')).toBeNull();
  });
});
