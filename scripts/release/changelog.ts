/**
 * `CHANGELOG.md` parser (WP-85, docs/wp/WP-83.md §4.2/§4.5): pure, no I/O.
 *
 * Format ("Keep a Changelog", German):
 *   # Changelog
 *   <intro>
 *   ## [Unveröffentlicht]            optional, only as the first section
 *   ## [1.4.0] – 2026-11-28          SemVer (optionally -rc.N), en dash, ISO date; newest first
 *   <free intro text>
 *   ### Neu | Geändert | Behoben | Entfernt | Sicherheit | Hinweise zum Update   (this order, each at most once,
 *                                                                              each with at least one "- " entry)
 */
import { compareVersions } from '@shared/version';

export const UNRELEASED = 'Unveröffentlicht';
export const GROUPS = [
  'Neu',
  'Geändert',
  'Behoben',
  'Entfernt',
  'Sicherheit',
  'Hinweise zum Update',
] as const;

export interface ChangelogGroup {
  name: string;
  entries: number;
}

export interface ChangelogSection {
  /** null = `[Unveröffentlicht]`. */
  version: string | null;
  date: string | null;
  /** 1-based line of the `##` heading. */
  line: number;
  /** Markdown between this heading and the next `##` heading, trimmed. */
  body: string;
  groups: ChangelogGroup[];
}

export interface Changelog {
  sections: ChangelogSection[];
  errors: string[];
}

const VERSION = String.raw`\d+\.\d+\.\d+(?:-rc\.\d+)?`;
const RELEASED_HEADING = new RegExp(`^## \\[(${VERSION})\\] – (\\d{4}-\\d{2}-\\d{2})$`, 'u');
const UNRELEASED_HEADING = `## [${UNRELEASED}]`;

function isValidDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

interface Draft extends ChangelogSection {
  lines: string[];
}

export function parseChangelog(text: string): Changelog {
  const errors: string[] = [];
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  if (firstContent === -1 || lines[firstContent] !== '# Changelog') {
    errors.push(`line ${String(firstContent + 1)}: the file must start with "# Changelog"`);
  }

  const sections: Draft[] = [];
  let current: Draft | null = null;
  let groupIndex = -1;
  let group: ChangelogGroup | null = null;
  lines.forEach((line, index) => {
    const at = `line ${String(index + 1)}`;
    if (line.startsWith('## ')) {
      const released = RELEASED_HEADING.exec(line);
      if (line === UNRELEASED_HEADING) {
        if (sections.length > 0) errors.push(`${at}: [${UNRELEASED}] must be the first section`);
        current = { version: null, date: null, line: index + 1, body: '', groups: [], lines: [] };
      } else if (released !== null) {
        const version = released[1] ?? '';
        const date = released[2] ?? '';
        if (!isValidDate(date)) errors.push(`${at}: invalid date ${date}`);
        current = { version, date, line: index + 1, body: '', groups: [], lines: [] };
      } else {
        errors.push(`${at}: section heading must be "${UNRELEASED_HEADING}" or "## [X.Y.Z] – YYYY-MM-DD"`);
        current = null;
      }
      if (current !== null) sections.push(current);
      groupIndex = -1;
      group = null;
      return;
    }
    if (current === null) {
      if (line.startsWith('### ')) errors.push(`${at}: group heading outside a version section`);
      return;
    }
    current.lines.push(line);
    if (line.startsWith('#### ') || line.startsWith('# ')) {
      errors.push(`${at}: unexpected heading level`);
    } else if (line.startsWith('### ')) {
      const name = line.slice(4).trim();
      const position = GROUPS.indexOf(name as (typeof GROUPS)[number]);
      if (position === -1) {
        errors.push(`${at}: unknown group "${name}" (allowed: ${GROUPS.join(', ')})`);
      } else if (position <= groupIndex) {
        errors.push(`${at}: group "${name}" is out of order or repeated (order: ${GROUPS.join(', ')})`);
      }
      groupIndex = Math.max(groupIndex, position);
      group = { name, entries: 0 };
      current.groups.push(group);
    } else if (group !== null && line.startsWith('- ')) {
      group.entries++;
    }
  });

  for (const section of sections) {
    section.body = section.lines.join('\n').trim();
    const label = section.version ?? UNRELEASED;
    for (const g of section.groups) {
      if (g.entries === 0)
        errors.push(`line ${String(section.line)}: group "${g.name}" of [${label}] has no entries`);
    }
    if (section.version !== null && section.body.length === 0) {
      errors.push(`line ${String(section.line)}: section [${label}] is empty`);
    }
  }

  const released = sections.filter((s) => s.version !== null);
  for (let i = 1; i < released.length; i++) {
    const newer = released[i - 1];
    const older = released[i];
    if (newer === undefined || older === undefined) continue;
    const order = compareVersions(newer.version ?? '', older.version ?? '');
    if (order === 0) errors.push(`line ${String(older.line)}: version ${older.version ?? ''} appears twice`);
    else if (order !== null && order < 0) {
      errors.push(
        `line ${String(older.line)}: versions must be newest first (${older.version ?? ''} after ${newer.version ?? ''})`,
      );
    }
    if ((older.date ?? '') > (newer.date ?? '')) {
      errors.push(`line ${String(older.line)}: date ${older.date ?? ''} is newer than the section above`);
    }
  }

  return {
    sections: sections.map(({ lines: _lines, ...section }) => section),
    errors,
  };
}

/** The section of `version` (`null` = unreleased), or undefined. */
export function findSection(changelog: Changelog, version: string | null): ChangelogSection | undefined {
  return changelog.sections.find((section) => section.version === version);
}

/**
 * The notes of a release: the section of `version`; a pre-release (`X.Y.Z-rc.N`) without its own section uses the
 * unreleased section, so a trial release does not consume it (WP-85).
 */
export function releaseSection(changelog: Changelog, version: string): ChangelogSection | undefined {
  const own = findSection(changelog, version);
  if (own !== undefined || !version.includes('-')) return own;
  return findSection(changelog, null);
}

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
