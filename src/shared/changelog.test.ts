import { describe, expect, it } from 'vitest';
import { changelogNotes, parseChangelog, releaseSection, sectionsBetween } from './changelog';

// Parser rules in detail: scripts/release/changelog.test.ts (it tests the re-export).
const TEXT = [
  '# Changelog',
  '',
  '## [Unveröffentlicht]',
  '',
  '### Behoben',
  '- Something works again (WP-90).',
  '',
  '## [1.1.0] – 2026-12-05',
  '',
  '### Neu',
  '- A feature (WP-88).',
  '',
  '## [1.0.1] – 2026-11-30',
  '',
  '### Behoben',
  '- A fix (WP-87).',
  '',
  '## [1.0.0] – 2026-11-28',
  '',
  'First release.',
  '',
].join('\n');

const changelog = parseChangelog(TEXT);
const versionsOf = (from: string | null, to: string) =>
  sectionsBetween(changelog, from, to).map((section) => section.version);

describe('parseChangelog (shared)', () => {
  it('parses without node APIs', () => {
    expect(changelog.errors).toEqual([]);
    expect(changelog.sections.map((section) => section.version)).toEqual([null, '1.1.0', '1.0.1', '1.0.0']);
  });
});

describe('sectionsBetween (WP-87 §1.6)', () => {
  it.each<[string | null, string, (string | null)[]]>([
    ['1.0.0', '1.1.0', ['1.1.0', '1.0.1']],
    ['1.0.1', '1.1.0', ['1.1.0']],
    [null, '1.0.1', ['1.0.1', '1.0.0']],
    ['1.0.0-rc.4', '1.0.0', ['1.0.0']],
    ['1.0.0-rc.4', '1.1.0', ['1.1.0', '1.0.1', '1.0.0']],
    ['1.0.0', '1.2.0-rc.1', ['1.1.0', '1.0.1']],
    ['1.1.0', '1.1.0', []],
    ['1.1.0', '1.2.0', []],
    ['1.1.0', '1.0.0', []],
    ['not-a-version', '1.1.0', []],
  ])('from %s to %s', (from, to, expected) => {
    expect(versionsOf(from, to)).toEqual(expected);
  });

  it('takes the unreleased section for a pre-release without released sections in between', () => {
    expect(versionsOf('1.0.0-rc.2', '1.0.0-rc.3')).toEqual([null]);
    expect(versionsOf('1.1.0', '1.2.0-rc.1')).toEqual([null]);
    expect(sectionsBetween(changelog, '1.1.0', '1.2.0-rc.1')).toEqual([
      { version: null, date: null, body: '### Behoben\n- Something works again (WP-90).' },
    ]);
    const withoutUnreleased = parseChangelog(
      TEXT.replace(/## \[Unveröffentlicht\][^#]*### Behoben\n[^\n]*\n\n/u, ''),
    );
    expect(withoutUnreleased.sections[0]?.version).toBe('1.1.0');
    expect(sectionsBetween(withoutUnreleased, '1.1.0', '1.2.0-rc.1')).toEqual([]);
  });

  it('returns version, date and body only (changelogSectionSchema)', () => {
    expect(sectionsBetween(changelog, '1.0.0', '1.0.1')).toEqual([
      { version: '1.0.1', date: '2026-11-30', body: '### Behoben\n- A fix (WP-87).' },
    ]);
    for (const section of sectionsBetween(changelog, null, '1.1.0')) {
      expect(Object.keys(section).sort()).toEqual(['body', 'date', 'version']);
    }
  });
});

describe('releaseSection and changelogNotes', () => {
  it('own section, a pre-release the unreleased one, else nothing', () => {
    expect(releaseSection(changelog, '1.0.0')?.body).toBe('First release.');
    expect(releaseSection(changelog, '1.3.0-rc.1')?.version).toBeNull();
    expect(releaseSection(changelog, '1.3.0')).toBeUndefined();
    const own = releaseSection(changelog, '1.1.0');
    expect(own === undefined ? null : changelogNotes(own)).toEqual({
      version: '1.1.0',
      date: '2026-12-05',
      body: '### Neu\n- A feature (WP-88).',
    });
  });
});
