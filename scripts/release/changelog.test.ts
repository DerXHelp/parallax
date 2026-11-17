import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkTag, findSection, parseChangelog, releaseSection } from './changelog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const VALID = [
  '# Changelog',
  '',
  'Intro.',
  '',
  '## [Unveröffentlicht]',
  '',
  '### Behoben',
  '- Something works again (WP-90).',
  '',
  '## [1.1.0] – 2026-12-05',
  '',
  'Short intro.',
  '',
  '### Neu',
  '- A feature (WP-88).',
  '  Continued line.',
  '',
  '### Hinweise zum Update',
  '- A note.',
  '',
  '## [1.0.0] – 2026-11-28',
  '',
  'First release.',
  '',
].join('\n');

function errorsOf(text: string): string[] {
  return parseChangelog(text).errors;
}

function replaceLine(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

describe('parseChangelog', () => {
  it('accepts the documented format', () => {
    const changelog = parseChangelog(VALID);
    expect(changelog.errors).toEqual([]);
    expect(changelog.sections.map((s) => [s.version, s.date, s.line])).toEqual([
      [null, null, 5],
      ['1.1.0', '2026-12-05', 10],
      ['1.0.0', '2026-11-28', 21],
    ]);
    expect(findSection(changelog, '1.1.0')?.groups).toEqual([
      { name: 'Neu', entries: 1 },
      { name: 'Hinweise zum Update', entries: 1 },
    ]);
    expect(findSection(changelog, '1.1.0')?.body).toBe(
      [
        'Short intro.',
        '',
        '### Neu',
        '- A feature (WP-88).',
        '  Continued line.',
        '',
        '### Hinweise zum Update',
        '- A note.',
      ].join('\n'),
    );
  });

  it('accepts CRLF line endings and an empty unreleased section', () => {
    const text = replaceLine(VALID, '### Behoben\n- Something works again (WP-90).\n', '').replace(
      /\n/gu,
      '\r\n',
    );
    const changelog = parseChangelog(text);
    expect(changelog.errors).toEqual([]);
    expect(findSection(changelog, null)?.body).toBe('');
  });

  it.each<[string, string, string, RegExp]>([
    ['missing title', '# Changelog', '# Release notes', /must start with "# Changelog"/u],
    [
      'hyphen instead of en dash',
      '## [1.1.0] – 2026-12-05',
      '## [1.1.0] - 2026-12-05',
      /section heading must be/u,
    ],
    ['invalid date', '## [1.1.0] – 2026-12-05', '## [1.1.0] – 2026-02-30', /invalid date 2026-02-30/u],
    ['no semver', '## [1.1.0] – 2026-12-05', '## [1.1] – 2026-12-05', /section heading must be/u],
    ['unknown group', '### Neu', '### Features', /unknown group "Features"/u],
    [
      'group out of order',
      '- Something works again (WP-90).',
      '- Fixed.\n### Neu\n- New.',
      /out of order or repeated/u,
    ],
    ['repeated group', '### Hinweise zum Update', '### Neu', /out of order or repeated/u],
    [
      'empty group',
      '- A note.',
      'No list entry.',
      /group "Hinweise zum Update" of \[1\.1\.0\] has no entries/u,
    ],
    [
      'duplicate version',
      '## [1.0.0] – 2026-11-28',
      '## [1.1.0] – 2026-11-28',
      /version 1\.1\.0 appears twice/u,
    ],
    ['wrong order', '## [1.0.0] – 2026-11-28', '## [1.2.0] – 2026-11-28', /newest first/u],
    ['date order', '## [1.0.0] – 2026-11-28', '## [1.0.0] – 2026-12-06', /date 2026-12-06 is newer/u],
    ['heading level', 'Short intro.', '#### Detail', /unexpected heading level/u],
  ])('rejects: %s', (_name, from, to, error) => {
    const errors = errorsOf(replaceLine(VALID, from, to));
    expect(
      errors.some((e) => error.test(e)),
      errors.join('\n'),
    ).toBe(true);
  });

  it('rejects an unreleased section below a release and an empty release section', () => {
    const moved = ['# Changelog', '', '## [1.0.0] – 2026-11-28', '', '## [Unveröffentlicht]', ''].join('\n');
    const errors = errorsOf(moved);
    expect(errors).toContainEqual(expect.stringMatching(/\[Unveröffentlicht\] must be the first section/u));
    expect(errors).toContainEqual(expect.stringMatching(/section \[1\.0\.0\] is empty/u));
  });

  it('rejects group headings before the first section', () => {
    expect(errorsOf(['# Changelog', '', '### Neu', '- x'].join('\n'))).toContainEqual(
      expect.stringMatching(/group heading outside a version section/u),
    );
  });
});

describe('release notes and tags', () => {
  const changelog = parseChangelog(VALID);

  it('uses the own section, for a pre-release otherwise the unreleased one', () => {
    expect(releaseSection(changelog, '1.1.0')?.version).toBe('1.1.0');
    expect(releaseSection(changelog, '1.2.0')).toBeUndefined();
    expect(releaseSection(changelog, '1.2.0-rc.1')?.version).toBeNull();
  });

  it('checks tag, package version and section', () => {
    expect(checkTag(changelog, 'v1.1.0', '1.1.0')).toEqual([]);
    expect(checkTag(changelog, 'v1.2.0-rc.1', '1.2.0-rc.1')).toEqual([]);
    expect(checkTag(changelog, 'v1.1.1', '1.1.0')).toEqual([
      'tag v1.1.1 does not match package.json version 1.1.0',
    ]);
    expect(checkTag(changelog, 'v1.3.0', '1.3.0')).toEqual(['CHANGELOG.md has no section [1.3.0]']);
    const empty = parseChangelog(replaceLine(VALID, '### Behoben\n- Something works again (WP-90).\n', ''));
    expect(checkTag(empty, 'v1.2.0-rc.1', '1.2.0-rc.1')).toEqual([
      'the changelog section for 1.2.0-rc.1 is empty',
    ]);
  });
});

describe('CHANGELOG.md of the repo', () => {
  it('follows the format', () => {
    const changelog = parseChangelog(readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8'));
    expect(changelog.errors).toEqual([]);
    expect(changelog.sections[0]?.version ?? null).toBeNull();
  });
});
