import { LIMITS } from '@shared/common';
import { editorSettingsSchema, type EditorPreset, type EditorSettings } from '@shared/model';

/**
 * The editor setting as a form (section "Files", WP-58; ADR-144): a draft with the path and the
 * argument lines as typed, its conversion to `EditorSettings`, the client check with the server's
 * own schema (`editorSettingsSchema` – issues per field) and the command line preview.
 */

export interface EditorDraft {
  preset: EditorPreset;
  /** Path as typed (notepadpp/vscode: optional own path; custom: required; system: ignored). */
  executable: string;
  /** Argument lines as typed (custom only): one argument per line. */
  args: string;
}

/** Why a field is not acceptable (texts: `preferences.files.issues.<issue>`). */
export const EDITOR_ISSUES = [
  'path',
  'not_exe',
  'blocked',
  'required',
  'file_placeholder',
  'too_long',
  'too_many',
  'invalid',
] as const;
export type EditorIssue = (typeof EDITOR_ISSUES)[number];

export interface EditorIssues {
  executable: EditorIssue | null;
  args: EditorIssue | null;
}

const NO_ISSUES: EditorIssues = { executable: null, args: null };

/** The draft of stored settings (arguments only for "own program"). */
export function draftOf(editor: EditorSettings): EditorDraft {
  return {
    preset: editor.preset,
    executable: editor.preset === 'system' ? '' : (editor.executable ?? ''),
    args: editor.preset === 'custom' ? editor.args.join('\n') : '',
  };
}

/** One argument per non-empty line, without surrounding blanks. */
export function argLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The settings the draft stands for – exactly what `settings.update {editor}` sends: no path for
 * the default program, an empty path = the detected installation, arguments only for "own program".
 */
export function editorOfDraft(draft: EditorDraft): EditorSettings {
  const executable = draft.executable.trim();
  return {
    preset: draft.preset,
    executable: draft.preset === 'system' || executable === '' ? null : executable,
    args: draft.preset === 'custom' ? argLines(draft.args) : [],
  };
}

function isKnownIssue(value: string): value is EditorIssue {
  return (EDITOR_ISSUES as readonly string[]).includes(value);
}

/** The client check: `editorSettingsSchema` (the server's schema), mapped to the two fields. */
export function editorIssues(draft: EditorDraft): EditorIssues {
  const parsed = editorSettingsSchema.safeParse(editorOfDraft(draft));
  if (parsed.success) return NO_ISSUES;
  const issues: EditorIssues = { executable: null, args: null };
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field !== 'executable' && field !== 'args') continue;
    if (issues[field] !== null) continue;
    let mapped: EditorIssue;
    if (issue.code === 'custom' && isKnownIssue(issue.message)) mapped = issue.message;
    else if (issue.code !== 'too_big') mapped = 'invalid';
    // `args` itself too big = too many arguments; one argument or the path = too long.
    else mapped = field === 'args' && issue.path.length === 1 ? 'too_many' : 'too_long';
    issues[field] = mapped;
  }
  return issues;
}

export function hasIssues(issues: EditorIssues): boolean {
  return issues.executable !== null || issues.args !== null;
}

/** Most arguments of an own program (for the hint `too_many`). */
export const EDITOR_ARGS_MAX = LIMITS.editorArgsMax;

/** Example target of the preview. */
export const PREVIEW_TARGET = { file: 'D:\\work\\project\\src\\app.ts', line: 42, col: 7 } as const;

/** One argument as Windows' command line shows it: quoted when empty or with blanks/quotes. */
export function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '\\"')}"`;
}

/** Fills {file} {line} {col} like the server (a missing line/col is 1). */
export function fillPlaceholders(
  arg: string,
  target: { file: string; line: number | null; col: number | null },
): string {
  return arg
    .replaceAll('{file}', target.file)
    .replaceAll('{line}', String(target.line ?? 1))
    .replaceAll('{col}', String(target.col ?? 1));
}

/** The command line of an own program for PREVIEW_TARGET. */
export function commandLinePreview(executable: string, args: readonly string[]): string {
  return [executable, ...args.map((arg) => fillPlaceholders(arg, PREVIEW_TARGET))].map(quoteArg).join(' ');
}

/** Same settings (the form is unchanged against the stored value). */
export function sameEditor(a: EditorSettings, b: EditorSettings): boolean {
  return (
    a.preset === b.preset &&
    a.executable === b.executable &&
    a.args.length === b.args.length &&
    a.args.every((arg, index) => arg === b.args[index])
  );
}
