import { describe, expect, it } from 'vitest';
import type { SettingsPatch } from '@shared/model';
import { POSIX_PATHS, WIN32_PATHS, type PathRules } from '@shared/paths';
import { sampleEditorSettings } from '@shared/samples';
import { CommandError } from '../sync/ports';
import { assertHostSettings } from './commands';

/** The error payload `assertHostSettings` throws, or null when the patch passes. */
function rejection(patch: SettingsPatch, rules: PathRules): unknown {
  try {
    assertHostSettings(patch, rules);
  } catch (error) {
    return error instanceof CommandError ? error.error : error;
  }
  return null;
}

describe('assertHostSettings (WP-102)', () => {
  const editor = (executable: string | null) => ({
    editor: { ...sampleEditorSettings(), preset: 'custom' as const, executable, args: ['{file}'] },
  });

  it('a Windows host stores only Windows editor paths', () => {
    expect(rejection(editor('C:\\Tools\\ed.exe'), WIN32_PATHS)).toBeNull();
    expect(rejection(editor('/usr/bin/code'), WIN32_PATHS)).toEqual({
      code: 'VALIDATION_FAILED',
      params: { field: 'editor.executable', reason: 'path' },
    });
  });

  it('a Linux host stores only POSIX editor paths', () => {
    expect(rejection(editor('/usr/bin/code'), POSIX_PATHS)).toBeNull();
    expect(rejection(editor('/usr/bin/bash'), POSIX_PATHS)).toEqual({
      code: 'VALIDATION_FAILED',
      params: { field: 'editor.executable', reason: 'blocked' },
    });
    expect(rejection(editor('C:\\Tools\\ed.exe'), POSIX_PATHS)).toEqual({
      code: 'VALIDATION_FAILED',
      params: { field: 'editor.executable', reason: 'path' },
    });
  });

  it('patches without an editor path pass', () => {
    expect(rejection({}, WIN32_PATHS)).toBeNull();
    expect(rejection(editor(null), POSIX_PATHS)).toBeNull();
    expect(rejection({ theme: 'dark' }, POSIX_PATHS)).toBeNull();
  });
});
