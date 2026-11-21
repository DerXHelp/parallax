import { WIN32_PATHS, type PathRules } from '@shared/paths';
import { fuzzyFilter } from '@web/lib/fuzzy';
import { pathTail } from '@web/lib/path-display';

/** Recent projects offered in "New session" (WP-36 requirement 1). */
export const RECENT_PROJECTS_MAX = 8;

export interface RecentProjectSource {
  summary: { cwd: string; lastActivityAt: string };
}

/**
 * Distinct folders of all sessions – archived ones included –, most recent activity first, at
 * most `limit`. Folders are compared by the rules of their host (`rules.key`: case-insensitive on
 * Windows, WP-104); the spelling of the most recent session wins (the `cwd` itself is never rewritten).
 */
export function recentProjects(
  entries: readonly RecentProjectSource[],
  limit = RECENT_PROJECTS_MAX,
  rules: PathRules = WIN32_PATHS,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const sorted = [...entries].sort(
    (a, b) => Date.parse(b.summary.lastActivityAt) - Date.parse(a.summary.lastActivityAt),
  );
  for (const { summary } of sorted) {
    const key = rules.key(summary.cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(summary.cwd);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * The recent projects that match the typed path (fuzzy, `lib/fuzzy.ts`): all of them while the
 * field is empty or names one of them exactly (by the host's rules), else the matches, best first.
 */
export function filterRecentProjects(
  projects: readonly string[],
  typed: string,
  rules: PathRules = WIN32_PATHS,
): string[] {
  const query = typed.trim();
  if (query === '') return [...projects];
  const key = rules.key(query);
  if (projects.some((project) => rules.key(project) === key)) return [...projects];
  return fuzzyFilter(projects, query, (project) => [project, pathTail(project, 1)]);
}
