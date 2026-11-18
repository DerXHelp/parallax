import { afterEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS, readStorage } from '@web/lib/storage';
import {
  effectiveGrouping,
  expandGroups,
  getCollapsedGroups,
  getSidebarGrouping,
  getSidebarMode,
  pruneCollapsedGroups,
  resetSidebarView,
  setGroupCollapsed,
  setSidebarGrouping,
  setSidebarMode,
} from './sidebar-view';

/** WP-80: "Group by" and collapsed groups of the sidebar (window-local view state). */

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetSidebarView();
});

function stored(value: string | null): void {
  if (value === null) window.localStorage.removeItem(STORAGE_KEYS.sidebarMode);
  else window.localStorage.setItem(STORAGE_KEYS.sidebarMode, value);
  resetSidebarView();
}

describe('grouping', () => {
  it('reads the stored values, WP-35 "grouped" as by folder, unknown as flat', () => {
    stored('grouped');
    expect(getSidebarGrouping()).toEqual({ byHost: false, byFolder: true });
    expect(getSidebarMode()).toBe('grouped');
    stored('host');
    expect(getSidebarGrouping()).toEqual({ byHost: true, byFolder: false });
    expect(getSidebarMode()).toBe('flat');
    stored('host+folder');
    expect(getSidebarGrouping()).toEqual({ byHost: true, byFolder: true });
    stored('nonsense');
    expect(getSidebarGrouping()).toEqual({ byHost: false, byFolder: false });
    stored(null);
    expect(getSidebarGrouping()).toEqual({ byHost: false, byFolder: false });
  });

  it('writes "grouped" for folder only (older versions keep reading it) and keeps by computer', () => {
    setSidebarGrouping({ byFolder: true });
    expect(readStorage('local', STORAGE_KEYS.sidebarMode)).toBe('grouped');
    setSidebarGrouping({ byHost: true });
    expect(readStorage('local', STORAGE_KEYS.sidebarMode)).toBe('host+folder');
    setSidebarMode('flat');
    expect(getSidebarGrouping()).toEqual({ byHost: true, byFolder: false });
    expect(readStorage('local', STORAGE_KEYS.sidebarMode)).toBe('host');
  });

  it('by computer only takes effect with other computers', () => {
    expect(effectiveGrouping({ byHost: true, byFolder: true }, false)).toEqual({
      byHost: false,
      byFolder: true,
    });
    expect(effectiveGrouping({ byHost: true, byFolder: false }, true)).toEqual({
      byHost: true,
      byFolder: false,
    });
  });
});

describe('collapsed groups', () => {
  it('kept per window and as the default of new windows', () => {
    setGroupCollapsed('host:computer-b', true);
    setGroupCollapsed('folder:local|d:\\work', true);
    const expected = JSON.stringify(['host:computer-b', 'folder:local|d:\\work']);
    expect(readStorage('session', STORAGE_KEYS.sidebarCollapsedGroups)).toBe(expected);
    expect(readStorage('local', STORAGE_KEYS.sidebarCollapsedGroups)).toBe(expected);
    // A new window (empty sessionStorage) starts with the last state.
    window.sessionStorage.clear();
    resetSidebarView();
    expect([...getCollapsedGroups()]).toEqual(['host:computer-b', 'folder:local|d:\\work']);
    // This window's own state wins over the default.
    window.sessionStorage.setItem(STORAGE_KEYS.sidebarCollapsedGroups, JSON.stringify(['host:local']));
    resetSidebarView();
    expect([...getCollapsedGroups()]).toEqual(['host:local']);
  });

  it('ignores damaged stored values', () => {
    window.sessionStorage.setItem(STORAGE_KEYS.sidebarCollapsedGroups, '{"no":1}');
    window.localStorage.setItem(STORAGE_KEYS.sidebarCollapsedGroups, 'not json');
    resetSidebarView();
    expect(getCollapsedGroups().size).toBe(0);
  });

  it('expands the given groups and drops groups that no longer exist', () => {
    setGroupCollapsed('host:a', true);
    setGroupCollapsed('host:b', true);
    setGroupCollapsed('host:c', true);
    const before = getCollapsedGroups();
    expandGroups(['host:x']);
    expect(getCollapsedGroups()).toBe(before);
    expandGroups(['host:a']);
    expect([...getCollapsedGroups()]).toEqual(['host:b', 'host:c']);
    pruneCollapsedGroups(['host:c', 'host:d']);
    expect([...getCollapsedGroups()]).toEqual(['host:c']);
    expect(readStorage('local', STORAGE_KEYS.sidebarCollapsedGroups)).toBe(JSON.stringify(['host:c']));
    setGroupCollapsed('host:c', false);
    expect(getCollapsedGroups().size).toBe(0);
  });
});
