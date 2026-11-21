import { describe, expect, it } from 'vitest';
import { DEFAULT_CONSOLE_SETTINGS, type SettingsPatch } from '@shared/model';
import { POSIX_PATHS, WIN32_PATHS, type PathRules } from '@shared/paths';
import { SAMPLE_IDS, sampleEditorSettings } from '@shared/samples';
import { CommandError } from '../sync/ports';
import { assertHostSettings, assertSettingsAccess } from './commands';

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

describe('assertSettingsAccess (security review WP-109)', () => {
  const ctx = { clientId: SAMPLE_IDS.client, cmdId: SAMPLE_IDS.cmdId };
  const refused = (patch: SettingsPatch, access: 'local' | 'control' | 'manage' | undefined): unknown => {
    try {
      assertSettingsAccess(patch, access === undefined ? ctx : { ...ctx, access });
    } catch (error) {
      return error instanceof CommandError ? error.error : error;
    }
    return null;
  };

  it('editor and console change only from a window of this computer; the rest also from "Manage"', () => {
    const editor: SettingsPatch = { editor: sampleEditorSettings() };
    const terminal: SettingsPatch = {
      console: { ...DEFAULT_CONSOLE_SETTINGS, terminalEmulator: '/usr/bin/kitty' },
    };
    expect(refused(editor, undefined)).toBeNull();
    expect(refused(terminal, 'local')).toBeNull();
    for (const patch of [editor, terminal, { ...editor, port: 4800 }]) {
      expect(refused(patch, 'manage')).toEqual({
        code: 'REMOTE_NOT_ALLOWED',
        params: { command: 'settings.update' },
      });
    }
    expect(refused({ port: 4800, theme: 'light' }, 'manage')).toBeNull();
  });
});
