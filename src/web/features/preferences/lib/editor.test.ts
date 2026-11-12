import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { EDITOR_BLOCKED_EXECUTABLES, editorSettingsSchema } from '@shared/model';
import { sampleEditorSettings } from '@shared/samples';
import {
  argLines,
  commandLinePreview,
  draftOf,
  editorIssues,
  editorOfDraft,
  fillPlaceholders,
  quoteArg,
  sameEditor,
  type EditorDraft,
} from './editor';

const custom = (executable: string, args: string): EditorDraft => ({ preset: 'custom', executable, args });

describe('editor form (WP-58, ADR-144)', () => {
  it('draft ↔ settings: an empty path = the detected one, arguments only for an own program', () => {
    expect(draftOf(sampleEditorSettings())).toEqual({ preset: 'notepadpp', executable: '', args: '' });
    expect(editorOfDraft({ preset: 'notepadpp', executable: '  ', args: 'x' })).toEqual({
      preset: 'notepadpp',
      executable: null,
      args: [],
    });
    expect(editorOfDraft({ preset: 'system', executable: 'C:\\x.exe', args: '' })).toEqual({
      preset: 'system',
      executable: null,
      args: [],
    });
    const stored = { preset: 'custom' as const, executable: 'C:\\Tools\\ed.exe', args: ['-g', '{file}'] };
    expect(draftOf(stored)).toEqual({
      preset: 'custom',
      executable: 'C:\\Tools\\ed.exe',
      args: '-g\n{file}',
    });
    expect(editorOfDraft(draftOf(stored))).toEqual(stored);
  });

  it('one argument per non-empty line, trimmed', () => {
    expect(argLines(' --goto \r\n\n{file}:{line}\n   \n')).toEqual(['--goto', '{file}:{line}']);
  });

  it('checks like editorSettingsSchema: required path, .exe, block list, {file}', () => {
    expect(editorIssues(custom('', ''))).toEqual({ executable: 'required', args: 'file_placeholder' });
    expect(editorIssues(custom('editor.exe', '{file}')).executable).toBe('path');
    expect(editorIssues(custom('\\\\server\\share\\ed.exe', '{file}')).executable).toBe('path');
    expect(editorIssues(custom('C:\\Tools\\editor.bat', '{file}')).executable).toBe('not_exe');
    for (const name of EDITOR_BLOCKED_EXECUTABLES) {
      expect(editorIssues(custom(`C:\\Windows\\System32\\${name.toUpperCase()}`, '{file}')).executable).toBe(
        'blocked',
      );
    }
    expect(editorIssues(custom('C:\\Tools\\ed.exe', '--line {line}')).args).toBe('file_placeholder');
    expect(editorIssues(custom('C:\\Tools\\ed.exe', '{file}'))).toEqual({ executable: null, args: null });
    // An own path of a preset is checked as well; empty is fine there.
    expect(editorIssues({ preset: 'vscode', executable: 'code', args: '' }).executable).toBe('path');
    expect(editorIssues({ preset: 'vscode', executable: '', args: '' })).toEqual({
      executable: null,
      args: null,
    });
  });

  it('limits: too many arguments, too long entries', () => {
    const many = Array.from({ length: LIMITS.editorArgsMax + 1 }, () => '{file}').join('\n');
    expect(editorIssues(custom('C:\\Tools\\ed.exe', many)).args).toBe('too_many');
    const long = `{file}${'x'.repeat(LIMITS.profileArgChars)}`;
    expect(editorIssues(custom('C:\\Tools\\ed.exe', long)).args).toBe('too_long');
    expect(editorIssues(custom(`C:\\${'d'.repeat(LIMITS.pathChars)}.exe`, '{file}')).executable).toBe(
      'too_long',
    );
  });

  it('a draft without issues is accepted by the server schema', () => {
    const drafts: EditorDraft[] = [
      custom('C:\\Program Files\\Sublime Text\\sublime_text.exe', '{file}:{line}:{col}'),
      { preset: 'notepadpp', executable: 'D:\\Apps\\Notepad++\\notepad++.exe', args: '' },
      { preset: 'system', executable: '', args: '' },
    ];
    for (const draft of drafts) {
      expect(editorIssues(draft)).toEqual({ executable: null, args: null });
      expect(editorSettingsSchema.safeParse(editorOfDraft(draft)).success).toBe(true);
    }
  });

  it('preview: placeholders filled (missing line/col = 1), blanks quoted', () => {
    expect(fillPlaceholders('{file}:{line}:{col}', { file: 'a.ts', line: null, col: null })).toBe('a.ts:1:1');
    expect(quoteArg('plain')).toBe('plain');
    expect(quoteArg('with space')).toBe('"with space"');
    expect(quoteArg('')).toBe('""');
    expect(commandLinePreview('C:\\Program Files\\Ed\\ed.exe', ['-n{line}', '{file}'])).toBe(
      '"C:\\Program Files\\Ed\\ed.exe" -n42 D:\\work\\project\\src\\app.ts',
    );
  });

  it('sameEditor compares preset, path and every argument', () => {
    const a = { preset: 'custom' as const, executable: 'C:\\e.exe', args: ['{file}'] };
    expect(sameEditor(a, { ...a, args: ['{file}'] })).toBe(true);
    expect(sameEditor(a, { ...a, args: ['{file}', '-x'] })).toBe(false);
    expect(sameEditor(a, { ...a, executable: null })).toBe(false);
  });
});
