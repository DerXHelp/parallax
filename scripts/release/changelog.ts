/**
 * `CHANGELOG.md` rules of the release scripts (WP-85, docs/wp/WP-83.md §4.2/§4.5). The parser lives
 * in `src/shared/changelog.ts` since WP-87 (the update service shows "What's new" with it) and is
 * re-exported here unchanged; the CI tag rule `checkTag` stays here.
 */
import { releaseSection, type Changelog } from '@shared/changelog';

export {
  findSection,
  GROUPS,
  parseChangelog,
  releaseSection,
  UNRELEASED,
  type Changelog,
  type ChangelogGroup,
  type ParsedChangelogSection as ChangelogSection,
} from '@shared/changelog';

/**
 * CI rule (§4.5): the tag is `v` + package.json version, and that version has a non-empty section
 * (see `releaseSection`). Returns the problems (empty = ok).
 */
export function checkTag(changelog: Changelog, tag: string, packageVersion: string): string[] {
  const problems: string[] = [];
  if (tag !== `v${packageVersion}`)
    problems.push(`tag ${tag} does not match package.json version ${packageVersion}`);
  const section = releaseSection(changelog, packageVersion);
  if (section === undefined) problems.push(`CHANGELOG.md has no section [${packageVersion}]`);
  else if (section.body.length === 0) problems.push(`the changelog section for ${packageVersion} is empty`);
  return problems;
}
