import type { PathRules } from '@shared/paths';

/**
 * WP-114: the projects (git repository roots) of one computer for the settings section "Projects":
 * the keys of `settings.projects`, the `repoRoot` of its worktree sessions and – asked from git with
 * `worktree.list` – the repositories of its other session folders. Pure helpers; compared by the
 * computer's rules (case-insensitive on Windows), the first spelling wins.
 */

export interface ProjectSource {
  cwd: string;
  worktree: { repoRoot: string } | null;
  lastActivityAt: string;
}

/** Session folders asked from git at most (newest first) – one `worktree.list` after the other. */
export const PROJECT_FOLDERS_MAX = 30;

/** Distinct roots in order: the settings keys first, then the worktree sessions' roots. */
export function knownProjectRoots(
  settingsRoots: readonly string[],
  sessions: readonly ProjectSource[],
  rules: PathRules,
): string[] {
  return distinctRoots(
    [
      ...settingsRoots,
      ...sessions.flatMap((session) => (session.worktree === null ? [] : [session.worktree.repoRoot])),
    ],
    rules,
  );
}

/** `roots` without a second spelling of the same folder. */
export function distinctRoots(roots: readonly string[], rules: PathRules): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    const key = rules.key(root);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(root);
  }
  return result;
}

/**
 * Folders of sessions without a worktree whose repository is not known yet: distinct, newest
 * activity first, none inside a known root, at most `limit`.
 */
export function foldersToResolve(
  sessions: readonly ProjectSource[],
  roots: readonly string[],
  rules: PathRules,
  limit = PROJECT_FOLDERS_MAX,
): string[] {
  const sorted = sessions
    .filter((session) => session.worktree === null)
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const { cwd } of sorted) {
    const key = rules.key(cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    if (roots.some((root) => rules.isInside(cwd, root))) continue;
    result.push(cwd);
    if (result.length >= limit) break;
  }
  return result;
}

/** Roots for display: by folder name, then by path (stable for the same input). */
export function sortProjectRoots(roots: readonly string[], rules: PathRules): string[] {
  return [...roots].sort((a, b) => {
    const byName = rules.baseName(a).localeCompare(rules.baseName(b), undefined, { sensitivity: 'base' });
    return byName === 0 ? a.localeCompare(b) : byName;
  });
}
