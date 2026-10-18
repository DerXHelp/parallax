import {
  LIMITS,
  modelNameSchema,
  type EffortLevel,
  type PermissionMode,
  type ProfileId,
} from '@shared/common';
import {
  PROFILE_COLORS,
  profileInputSchema,
  type Profile,
  type ProfileColor,
  type ProfileInput,
  type ProfileIssue,
  type ProfileSummary,
} from '@shared/model';
import { windowsPathKey } from '@shared/paths';
import type { TranslationKey, TranslationParams } from '@web/i18n';
import { issueArgIndex, issueEnvKey, issueField } from '@web/shell/new-session/profile-issues';

/**
 * The editor's working copy of a profile (WP-36): text fields stay text until they are turned
 * into a `ProfileInput` (`buildInput`), so half-typed values never get lost. Env and args are rows
 * with stable ids (React keys, finding placement). Pure functions, table-tested.
 */

export interface EnvRow {
  id: string;
  key: string;
  value: string;
}

export interface ArgRow {
  id: string;
  value: string;
}

export interface ProfileDraft {
  name: string;
  color: ProfileColor;
  executableKind: 'auto' | 'path';
  executablePath: string;
  /** '' = no config folder (Claude Code's default). */
  configDir: string;
  env: EnvRow[];
  args: ArgRow[];
  passRawArgs: boolean;
  /** Digits as typed ('' = none). */
  contextWindow: string;
  /** '' = none. */
  model: string;
  permissionMode: PermissionMode | null;
  effort: EffortLevel | null;
}

let rowCounter = 0;

/** A new row id (only unique within this window; never sent to the server). */
export function newRowId(): string {
  rowCounter += 1;
  return `row-${String(rowCounter)}`;
}

// Limits read from the contract (`profileInputSchema`), never duplicated.
const contextWindowSchema = profileInputSchema.shape.contextWindow.unwrap();
/** Smallest `contextWindow` override (100 000). */
export const CONTEXT_WINDOW_MIN = contextWindowSchema.minValue ?? 0;
/** Largest `contextWindow` override (1 000 000). */
export const CONTEXT_WINDOW_MAX = contextWindowSchema.maxValue ?? Number.MAX_SAFE_INTEGER;
/** Longest profile name (60). */
export const PROFILE_NAME_MAX = profileInputSchema.shape.name.maxLength ?? Number.MAX_SAFE_INTEGER;

/** Bypass flags (parseProfileArgs, C.3): the row is marked red right away, before the check. */
const BYPASS_ARG = /^--(?:allow-)?dangerously-skip-permissions$/;

export function isBypassArg(value: string): boolean {
  return BYPASS_ARG.test(value.trim());
}

/** Draft of a saved profile (`profile.get`). */
export function draftFromProfile(profile: Profile): ProfileDraft {
  return {
    name: profile.name,
    color: profile.color,
    executableKind: profile.executable.kind,
    executablePath: profile.executable.kind === 'path' ? profile.executable.path : '',
    configDir: profile.configDir ?? '',
    env: Object.entries(profile.env).map(([key, value]) => ({ id: newRowId(), key, value })),
    args: profile.args.map((value) => ({ id: newRowId(), value })),
    passRawArgs: profile.passRawArgs,
    contextWindow: profile.contextWindow === null ? '' : String(profile.contextWindow),
    model: profile.defaults.model ?? '',
    permissionMode: profile.defaults.permissionMode,
    effort: profile.defaults.effort,
  };
}

/** Draft of a new profile: the first color no other profile uses. */
export function newDraft(existing: readonly Pick<ProfileSummary, 'color'>[]): ProfileDraft {
  const used = new Set(existing.map((profile) => profile.color));
  return {
    name: '',
    color: PROFILE_COLORS.find((color) => !used.has(color)) ?? 'blue',
    executableKind: 'auto',
    executablePath: '',
    configDir: '',
    env: [],
    args: [],
    passRawArgs: false,
    contextWindow: '',
    model: '',
    permissionMode: null,
    effort: null,
  };
}

/** Where a problem of the draft is shown. */
export type DraftField =
  | 'name'
  | 'executable'
  | 'configDir'
  | 'contextWindow'
  | 'model'
  | 'permissionMode'
  | 'env'
  | 'args'
  | { envRow: string }
  | { argRow: string };

/** A problem the editor finds before asking the server (the server checks again). */
export interface DraftProblem {
  field: DraftField;
  key: TranslationKey;
  params?: TranslationParams;
}

export interface BuiltInput {
  /** null while the draft has problems (no `profile.validate`/`profile.save`). */
  input: ProfileInput | null;
  problems: DraftProblem[];
  /** Row id per position in `input.args` (findings carry `params.index`). */
  argRowIds: string[];
}

/** Digits with optional thousands separators (space, '.', ',', '_', "'"), else null. */
export function parseContextWindow(text: string): number | null {
  const compact = text.trim().replace(/[\s.,_']/g, '');
  if (!/^\d+$/.test(compact)) return null;
  return Number(compact);
}

/**
 * The `ProfileInput` of a draft plus the problems that keep it from being sent. Empty env rows
 * (name and value empty) and empty argument rows are dropped; nothing else is changed (values are
 * not trimmed – the server decides).
 */
export function buildInput(
  draft: ProfileDraft,
  id: ProfileId | null,
  options: { allowsBypass: boolean },
): BuiltInput {
  const problems: DraftProblem[] = [];
  const name = draft.name.trim();
  if (name === '') problems.push({ field: 'name', key: 'profiles.problems.nameRequired' });
  else if (name.length > PROFILE_NAME_MAX) {
    problems.push({ field: 'name', key: 'profiles.problems.tooLong', params: { max: PROFILE_NAME_MAX } });
  }

  const executablePath = draft.executablePath.trim();
  if (draft.executableKind === 'path' && executablePath === '') {
    problems.push({ field: 'executable', key: 'profiles.problems.executableRequired' });
  }

  const configDir = draft.configDir.trim();
  if (configDir.length > LIMITS.pathChars) {
    problems.push({ field: 'configDir', key: 'profiles.problems.tooLong', params: { max: LIMITS.pathChars } });
  }

  const env: Record<string, string> = {};
  const seen = new Map<string, string>();
  const rows = draft.env.filter((row) => row.key !== '' || row.value !== '');
  if (rows.length > LIMITS.profileEnvMax) {
    problems.push({ field: 'env', key: 'profiles.problems.envTooMany', params: { max: LIMITS.profileEnvMax } });
  }
  for (const row of rows) {
    const field = { envRow: row.id };
    if (row.key === '') {
      problems.push({ field, key: 'profiles.problems.envKeyRequired' });
      continue;
    }
    if (!/^[^=\s][^=]*$/.test(row.key)) {
      problems.push({ field, key: 'profiles.problems.envKeyInvalid' });
      continue;
    }
    if (row.key.length > LIMITS.profileEnvKeyChars) {
      problems.push({ field, key: 'profiles.problems.tooLong', params: { max: LIMITS.profileEnvKeyChars } });
      continue;
    }
    if (row.value.length > LIMITS.profileEnvValueChars) {
      problems.push({ field, key: 'profiles.problems.tooLong', params: { max: LIMITS.profileEnvValueChars } });
      continue;
    }
    // Windows env names are case-insensitive (PATH = Path): one of them would win at the start.
    const upper = row.key.toUpperCase();
    if (seen.has(upper)) {
      problems.push({ field, key: 'profiles.problems.envKeyDuplicate' });
      continue;
    }
    seen.set(upper, row.id);
    env[row.key] = row.value;
  }

  const args: string[] = [];
  const argRowIds: string[] = [];
  for (const row of draft.args) {
    if (row.value === '') continue;
    if (row.value.length > LIMITS.profileArgChars) {
      problems.push({
        field: { argRow: row.id },
        key: 'profiles.problems.tooLong',
        params: { max: LIMITS.profileArgChars },
      });
    }
    args.push(row.value);
    argRowIds.push(row.id);
  }
  if (args.length > LIMITS.profileArgsMax) {
    problems.push({ field: 'args', key: 'profiles.problems.argsTooMany', params: { max: LIMITS.profileArgsMax } });
  }

  let contextWindow: number | null = null;
  if (draft.contextWindow.trim() !== '') {
    contextWindow = parseContextWindow(draft.contextWindow);
    if (contextWindow === null || contextWindow < CONTEXT_WINDOW_MIN || contextWindow > CONTEXT_WINDOW_MAX) {
      problems.push({
        field: 'contextWindow',
        key: 'profiles.problems.contextWindow',
        params: { min: CONTEXT_WINDOW_MIN, max: CONTEXT_WINDOW_MAX },
      });
    }
  }

  const model = draft.model.trim();
  if (model !== '' && !modelNameSchema.safeParse(model).success) {
    problems.push({ field: 'model', key: 'profiles.problems.model' });
  }
  if (draft.permissionMode === 'bypassPermissions' && !options.allowsBypass) {
    problems.push({ field: 'permissionMode', key: 'profiles.problems.bypassNotAllowed' });
  }

  if (problems.length > 0) return { input: null, problems, argRowIds };
  const candidate: ProfileInput = {
    ...(id === null ? {} : { id }),
    name,
    color: draft.color,
    executable: draft.executableKind === 'path' ? { kind: 'path', path: executablePath } : { kind: 'auto' },
    configDir: configDir === '' ? null : configDir,
    env,
    contextWindow,
    args,
    passRawArgs: draft.passRawArgs,
    defaults: { model: model === '' ? null : model, permissionMode: draft.permissionMode, effort: draft.effort },
  };
  // zod at the boundary: the command schema rejects anything the checks above missed.
  const parsed = profileInputSchema.safeParse(candidate);
  if (!parsed.success) {
    return { input: null, problems: [{ field: 'name', key: 'profiles.problems.invalid' }], argRowIds };
  }
  return { input: parsed.data, problems: [], argRowIds };
}

/** Comparable form of a draft (row ids and UI state left out): equal keys = no unsaved change. */
export function draftKey(draft: ProfileDraft): string {
  return JSON.stringify([
    draft.name.trim(),
    draft.color,
    draft.executableKind,
    draft.executableKind === 'path' ? draft.executablePath.trim() : '',
    draft.configDir.trim(),
    draft.env.filter((row) => row.key !== '' || row.value !== '').map((row) => [row.key, row.value]),
    draft.args.filter((row) => row.value !== '').map((row) => row.value),
    draft.passRawArgs,
    draft.contextWindow.trim() === '' ? null : parseContextWindow(draft.contextWindow),
    draft.model.trim(),
    draft.permissionMode,
    draft.effort,
  ]);
}

/** The config folder changed in a way that matters (case-insensitive, like Windows). */
export function configDirChanged(before: string | null, after: string): boolean {
  return windowsPathKey((before ?? '').trim()) !== windowsPathKey(after.trim());
}

export function sameField(a: DraftField, b: DraftField): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if ('envRow' in a) return 'envRow' in b && a.envRow === b.envRow;
  return 'argRow' in b && a.argRow === b.argRow;
}

export function problemsFor(problems: readonly DraftProblem[], field: DraftField): DraftProblem[] {
  return problems.filter((problem) => sameField(problem.field, field));
}

/** Findings placed at the field they are about (ADR-102; `index` = argument row). */
export interface PlacedIssues {
  /** Not tied to one field. */
  general: ProfileIssue[];
  executable: ProfileIssue[];
  configDir: ProfileIssue[];
  /** By env row id. */
  env: Map<string, ProfileIssue[]>;
  /** By argument row id. */
  args: Map<string, ProfileIssue[]>;
}

function push(map: Map<string, ProfileIssue[]>, key: string, finding: ProfileIssue): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [finding]);
  else list.push(finding);
}

/**
 * Places findings: argument findings by `params.index` through the row ids of the input they were
 * computed for (rows added since then do not shift them), env findings by variable name,
 * PROFILE_INVALID by `field`; everything else is general.
 */
export function placeIssues(
  issues: readonly ProfileIssue[],
  argRowIds: readonly string[],
  envRows: readonly EnvRow[],
): PlacedIssues {
  const placed: PlacedIssues = { general: [], executable: [], configDir: [], env: new Map(), args: new Map() };
  for (const finding of issues) {
    const field = issueField(finding.issue);
    if (field !== null) {
      placed[field].push(finding);
      continue;
    }
    const envKey = issueEnvKey(finding.issue);
    if (envKey !== null) {
      const row = envRows.find((candidate) => candidate.key === envKey);
      if (row !== undefined) {
        push(placed.env, row.id, finding);
        continue;
      }
    }
    const index = issueArgIndex(finding.issue);
    const rowId = index === null ? undefined : argRowIds[index];
    if (rowId !== undefined) {
      push(placed.args, rowId, finding);
      continue;
    }
    placed.general.push(finding);
  }
  return placed;
}

/** The server considers the profile allowed to bypass permissions (finding PROFILE_BYPASS_ENABLED). */
export function bypassAllowed(issues: readonly ProfileIssue[]): boolean {
  return issues.some((finding) => finding.issue.code === 'PROFILE_BYPASS_ENABLED');
}

/** Splits pasted text into argument rows (one per line, `\r\n` or `\n`). */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}
