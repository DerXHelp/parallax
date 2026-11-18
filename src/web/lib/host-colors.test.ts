import { describe, expect, it } from 'vitest';
import { HOST_COLORS } from '@shared/model';
import { HOST_BG, HOST_BORDER, HOST_SHORT_NAME_MAX, hostShortName } from './host-colors';

describe('host-colors (WP-80)', () => {
  it('maps every host color to a different token class', () => {
    expect(Object.keys(HOST_BG).sort()).toEqual([...HOST_COLORS].sort());
    expect(new Set(Object.values(HOST_BG)).size).toBe(HOST_COLORS.length);
    expect(new Set(Object.values(HOST_BORDER)).size).toBe(HOST_COLORS.length);
  });

  it('shortens long names for the badge (code points, ellipsis)', () => {
    expect(hostShortName('  Computer B ')).toBe('Computer B');
    const long = hostShortName('Workstation in the lab');
    expect(Array.from(long)).toHaveLength(HOST_SHORT_NAME_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(Array.from(hostShortName('🖥️🖥️🖥️🖥️🖥️🖥️🖥️🖥️')).length).toBeLessThanOrEqual(HOST_SHORT_NAME_MAX);
  });
});
