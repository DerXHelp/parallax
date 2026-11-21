import type { ErrorPayload } from '@shared/errors';
import {
  branchExistsParamsSchema,
  gitFailedParamsSchema,
  gitPushFailedParamsSchema,
  notAGitRepoParamsSchema,
  worktreeExistsParamsSchema,
} from '@shared/errors';
import {
  isValidGitRefName,
  type GitWorktree,
  type ProjectSettings,
  type ProjectSettingsMap,
} from '@shared/model';
import type { PathRules } from '@shared/paths';
import type { SessionWorktreeRequest } from '@shared/protocol';

/**
 * Pure helpers of the worktree part of "New session" (WP-114, ADR-250) – also used by
 * `features/worktrees` (cleanup dialog) and `features/preferences` (section "Projects"): the
 * settings of a project, the branch to suggest, the worktrees one may pick, the git details of an
 * error. No React, no store.
 */

/** Prefix of the suggested branch of a new worktree (`parallax/<short id>`). */
export const WORKTREE_BRANCH_PREFIX = 'parallax/';

const SHORT_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `parallax/<6 random chars>` – a valid ref name; `bytes` for tests. */
export function defaultWorktreeBranch(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(6))): string {
  const id = Array.from(bytes, (byte) => SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length] ?? 'x').join('');
  return `${WORKTREE_BRANCH_PREFIX}${id}`;
}

/**
 * The settings of the project `repoRoot` (`settings.projects`): the key exactly as written, else one
 * that names the same folder by the host's rules (case-insensitive on Windows); null = none.
 */
export function projectSettingsFor(
  projects: ProjectSettingsMap,
  repoRoot: string,
  rules: PathRules,
): ProjectSettings | null {
  const exact = projects[repoRoot];
  if (exact !== undefined) return exact;
  const key = rules.key(repoRoot);
  for (const [root, settings] of Object.entries(projects)) {
    if (rules.key(root) === key) return settings;
  }
  return null;
}

/** The key of `repoRoot` in `settings.projects` (an existing spelling wins); `repoRoot` when there is none. */
export function projectKeyFor(projects: ProjectSettingsMap, repoRoot: string, rules: PathRules): string {
  if (Object.hasOwn(projects, repoRoot)) return repoRoot;
  const key = rules.key(repoRoot);
  return Object.keys(projects).find((root) => rules.key(root) === key) ?? repoRoot;
}

/** Some project starts "New session" in a worktree – then "Create" waits for the repository check. */
export function anyWorktreeDefault(projects: ProjectSettingsMap): boolean {
  return Object.values(projects).some((project) => project.worktreeDefault);
}

/** The branch of the main worktree (the default base); null = detached or unknown. */
export function mainWorktreeBranch(worktrees: readonly GitWorktree[]): string | null {
  return worktrees.find((worktree) => worktree.main)?.branch ?? null;
}

/** Worktrees one may start a session in: not the main one, not detached (the server refuses both). */
export function pickableWorktrees(worktrees: readonly GitWorktree[]): GitWorktree[] {
  return worktrees.filter((worktree) => !worktree.main && worktree.branch !== null);
}

export type RefIssue = 'empty' | 'invalid';

/** Why `text` (trimmed) cannot be a branch or base name; empty is allowed only when `optional`. */
export function refIssue(text: string, optional = false): RefIssue | null {
  const value = text.trim();
  if (value === '') return optional ? null : 'empty';
  return isValidGitRefName(value) ? null : 'invalid';
}

export type WorktreeMode = SessionWorktreeRequest['mode'];

export interface WorktreeInput {
  mode: WorktreeMode;
  branch: string;
  /** '' = the server's default (the branch of the main worktree). */
  base: string;
  /** `existing`: the chosen worktree folder (exactly as `worktree.list` reported it). */
  path: string | null;
}

/** `session.create.worktree` for the input; null = the input is not valid yet. */
export function worktreeRequest(input: WorktreeInput): SessionWorktreeRequest | null {
  if (input.mode === 'existing') {
    return input.path === null || input.path === '' ? null : { mode: 'existing', path: input.path };
  }
  if (refIssue(input.branch) !== null || refIssue(input.base, true) !== null) return null;
  const branch = input.branch.trim();
  const base = input.base.trim();
  return base === '' ? { mode: 'new', branch } : { mode: 'new', branch, baseRef: base };
}

/**
 * The detail of a git error the generic text leaves out: git's first message line (`GIT_FAILED`,
 * `GIT_PUSH_FAILED`), the folder (`WORKTREE_EXISTS`, `NOT_A_GIT_REPO`) or the branch
 * (`BRANCH_EXISTS`); null = none. Params are read tolerantly (zod).
 */
export function gitErrorDetail(error: ErrorPayload): string | null {
  const params: unknown = error.params;
  switch (error.code) {
    case 'GIT_FAILED': {
      const parsed = gitFailedParamsSchema.safeParse(params);
      return parsed.success ? (parsed.data.detail ?? null) : null;
    }
    case 'GIT_PUSH_FAILED': {
      const parsed = gitPushFailedParamsSchema.safeParse(params);
      return parsed.success ? (parsed.data.detail ?? null) : null;
    }
    case 'WORKTREE_EXISTS': {
      const parsed = worktreeExistsParamsSchema.safeParse(params);
      return parsed.success ? parsed.data.path : null;
    }
    case 'NOT_A_GIT_REPO': {
      const parsed = notAGitRepoParamsSchema.safeParse(params);
      return parsed.success ? parsed.data.path : null;
    }
    case 'BRANCH_EXISTS': {
      const parsed = branchExistsParamsSchema.safeParse(params);
      return parsed.success ? parsed.data.branch : null;
    }
    default:
      return null;
  }
}
