import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledCliProfile, isNewerThanTested, parseCliProfile, testedCliVersion } from './cliProfile';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('CLI profile (WP-62)', () => {
  it('the committed profile is valid; its lists are sorted and free of duplicates (diff-friendly)', () => {
    const raw: unknown = JSON.parse(readFileSync(path.join(here, 'cli-profile.json'), 'utf8'));
    const profile = parseCliProfile(raw);
    expect(profile).not.toBeNull();
    if (profile === null) return;
    for (const [key, value] of Object.entries(profile)) {
      if (!Array.isArray(value)) continue;
      expect([...new Set(value)].sort(), key).toEqual(value);
    }
    expect(profile.tools.some((tool) => tool.startsWith('mcp__'))).toBe(false);
    // The bundled copy is the same file; the server reports its version as testedVersion.
    expect(bundledCliProfile()).toEqual(profile);
    expect(testedCliVersion()).toBe(profile.cliVersion);
  });

  it('rejects files that do not match the schema', () => {
    expect(parseCliProfile({})).toBeNull();
    expect(parseCliProfile({ schemaVersion: 2 })).toBeNull();
    expect(parseCliProfile(null)).toBeNull();
  });

  it('isNewerThanTested: only a known, parsable, newer version', () => {
    expect(isNewerThanTested('2.1.330', '2.1.322')).toBe(true);
    expect(isNewerThanTested('2.1.322', '2.1.322')).toBe(false);
    expect(isNewerThanTested('2.1.300', '2.1.322')).toBe(false);
    expect(isNewerThanTested(null, '2.1.322')).toBe(false);
    expect(isNewerThanTested('2.1.330', null)).toBe(false);
    expect(isNewerThanTested('garbage', '2.1.322')).toBe(false);
  });
});
