import { describe, expect, it } from 'vitest';
import { findEdge } from './edge';
import { parseRegDefaultValue, type RegQuery } from './registry';
import { createMemoryFs } from './windows';

describe('Edge (C.9)', () => {
  const EN = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    '    (Default)    REG_SZ    C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '    Path    REG_SZ    C:\\Program Files (x86)\\Microsoft\\Edge\\Application',
    '',
  ].join('\r\n');
  const DE = EN.replace('(Default)', '(Standard)');
  const EXPAND =
    '    (Standard)    REG_EXPAND_SZ    "%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe"\r\n';
  const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

  it.each([
    ['English', EN, EDGE],
    ['German', DE, EDGE],
    ['expand + quotes', EXPAND, 'C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['nothing', 'ERROR: not found', null],
  ])('parseRegDefaultValue: %s', (_name, output, value) => {
    expect(parseRegDefaultValue(output, { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe(value);
  });

  const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' };

  it('prefers App Paths', async () => {
    const queries: string[] = [];
    const regQuery: RegQuery = (key, view) => {
      queries.push(`${key}@${String(view)}`);
      return Promise.resolve(key.startsWith('HKLM') && view === 64 ? EN : null);
    };
    expect(await findEdge({ regQuery, fs: createMemoryFs({ [EDGE]: '' }), env })).toBe(EDGE);
    expect(queries).toHaveLength(3);
  });

  it('falls back to Program Files and returns null if Edge is missing', async () => {
    const none: RegQuery = () => Promise.resolve(null);
    const programFiles = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
    expect(await findEdge({ regQuery: none, fs: createMemoryFs({ [programFiles]: '' }), env })).toBe(
      programFiles,
    );
    expect(await findEdge({ regQuery: none, fs: createMemoryFs({}), env })).toBeNull();
  });

  it('never touches an unsafe registry value', async () => {
    const fs = createMemoryFs({});
    const unc: RegQuery = () => Promise.resolve('    (Default)    REG_SZ    \\\\evil\\share\\msedge.exe\r\n');
    expect(await findEdge({ regQuery: unc, fs, env: {} })).toBeNull();
    expect(fs.touched).toEqual([]);
  });
});
