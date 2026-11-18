import { describe, expect, it } from 'vitest';
import { cycleModes, nextPermissionMode, offeredModes } from './modes';

describe('permission mode cycle (WP-91, Shift+Tab)', () => {
  it('follows the picker order; bypass only when allowed, auto only when supported', () => {
    expect(cycleModes({ allowsBypass: false, autoSupported: true })).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
    ]);
    expect(cycleModes({ allowsBypass: true, autoSupported: false })).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ]);
    expect(offeredModes({ allowsBypass: false })).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
  });

  it('steps forward and wraps around', () => {
    const modes = cycleModes({ allowsBypass: true, autoSupported: true });
    expect(nextPermissionMode('default', modes)).toBe('acceptEdits');
    expect(nextPermissionMode('plan', modes)).toBe('auto');
    expect(nextPermissionMode('auto', modes)).toBe('bypassPermissions');
    expect(nextPermissionMode('bypassPermissions', modes)).toBe('default');
  });

  it('not reported counts as default; a mode outside the cycle starts at the first', () => {
    const modes = cycleModes({ allowsBypass: false, autoSupported: false });
    expect(nextPermissionMode(null, modes)).toBe('acceptEdits');
    expect(nextPermissionMode('dontAsk', modes)).toBe('default');
    expect(nextPermissionMode('auto', modes)).toBe('default');
    expect(nextPermissionMode('plan', modes)).toBe('default');
    expect(nextPermissionMode('plan', [])).toBeNull();
  });
});
