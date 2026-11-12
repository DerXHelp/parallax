import { afterEach, describe, expect, it } from 'vitest';
import {
  getSidePanelFile,
  goBackSidePanelFile,
  resetSidePanelState,
  setSidePanelFile,
  SIDE_PANEL_HISTORY_MAX,
} from './state';
import { clampSidePanelWidth, defaultSidePanelWidth, isSidePanelOverlay, sidePanelMaxWidth } from './width';

const KEY = 'local:en_00000000000000000000000000000001';

function open(path: string, line: number | null = null): void {
  setSidePanelFile(KEY, { path, line, col: null });
}

afterEach(() => {
  resetSidePanelState();
});

describe('side panel state (WP-54)', () => {
  it('keeps a back stack: newest first, no duplicates, at most SIDE_PANEL_HISTORY_MAX', () => {
    open('D:\\a.ts');
    open('D:\\b.ts');
    open('D:\\c.ts');
    open('d:\\A.TS'); // a again: leaves the stack, becomes current
    expect(getSidePanelFile(KEY)?.path).toBe('d:\\A.TS');
    expect(goBackSidePanelFile(KEY)).toBe(true);
    expect(getSidePanelFile(KEY)?.path).toBe('D:\\c.ts');
    expect(goBackSidePanelFile(KEY)).toBe(true);
    expect(getSidePanelFile(KEY)?.path).toBe('D:\\b.ts');
    expect(goBackSidePanelFile(KEY)).toBe(false);

    resetSidePanelState();
    for (let index = 0; index < SIDE_PANEL_HISTORY_MAX + 5; index++) open(`D:\\f${String(index)}.ts`);
    let steps = 0;
    while (goBackSidePanelFile(KEY)) steps++;
    expect(steps).toBe(SIDE_PANEL_HISTORY_MAX);
  });

  it('the same file at another line moves the line; the same target again bumps the revision', () => {
    open('D:\\a.ts', 3);
    expect(getSidePanelFile(KEY)).toEqual({ path: 'D:\\a.ts', line: 3, col: null, revision: 0 });
    open('D:\\a.ts', 9);
    expect(getSidePanelFile(KEY)).toEqual({ path: 'D:\\a.ts', line: 9, col: null, revision: 0 });
    open('D:\\A.ts', 9);
    expect(getSidePanelFile(KEY)?.revision).toBe(1);
    // Going back remounts the target as well.
    open('D:\\b.ts');
    goBackSidePanelFile(KEY);
    expect(getSidePanelFile(KEY)).toMatchObject({ path: 'D:\\A.ts', line: 9, revision: 2 });
  });

  it('goBack to an older entry drops it and the newer ones from the stack', () => {
    for (const name of ['a', 'b', 'c', 'd']) open(`D:\\${name}.ts`);
    expect(goBackSidePanelFile(KEY, 2)).toBe(true);
    expect(getSidePanelFile(KEY)?.path).toBe('D:\\a.ts');
    expect(goBackSidePanelFile(KEY)).toBe(false);
  });
});

describe('side panel width (WP-54)', () => {
  it('320 px … 70 % of the area, default min(672, 45 %), overlay below 1100 px', () => {
    expect(sidePanelMaxWidth(1400)).toBe(980);
    expect(sidePanelMaxWidth(300)).toBe(320);
    expect(defaultSidePanelWidth(2000)).toBe(672);
    expect(defaultSidePanelWidth(1000)).toBe(450);
    expect(defaultSidePanelWidth(500)).toBe(320);
    expect(clampSidePanelWidth(100, 1400)).toBe(320);
    expect(clampSidePanelWidth(5000, 1400)).toBe(980);
    expect(clampSidePanelWidth(700.4, 1400)).toBe(700);
    // Never wider than a tiny area.
    expect(clampSidePanelWidth(400, 300)).toBe(300);
    expect(isSidePanelOverlay(1099)).toBe(true);
    expect(isSidePanelOverlay(1100)).toBe(false);
    expect(isSidePanelOverlay(null)).toBe(false);
  });
});
