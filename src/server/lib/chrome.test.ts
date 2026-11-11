import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exeProductVersion, findChrome, readExeVersion } from './chrome';
import { parseRegDefaultValue, type RegQuery } from './registry';
import { createMemoryFs } from './windows';

const SYSTEM = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const X86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const USER = 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

describe('Chrome lookup (ADR-136)', () => {
  const EN = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    `    (Default)    REG_SZ    ${SYSTEM}`,
    '    Path    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application',
    '',
  ].join('\r\n');
  const DE = EN.replace('(Default)', '(Standard)');
  const EXPAND =
    '    (Standard)    REG_EXPAND_SZ    "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe"\r\n';

  it.each([
    ['English', EN, SYSTEM],
    ['German', DE, SYSTEM],
    ['expand + quotes', EXPAND, USER],
    ['nothing', 'ERROR: not found', null],
  ])('parseRegDefaultValue: %s', (_name, output, value) => {
    expect(parseRegDefaultValue(output, { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe(value);
  });

  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  };

  it('asks App Paths in HKCU first, then HKLM 64/32, and takes the first existing exe', async () => {
    const queries: string[] = [];
    const regQuery: RegQuery = (key, view) => {
      queries.push(`${key.slice(0, 4)}@${String(view)}`);
      if (key.startsWith('HKCU')) return Promise.resolve(EXPAND);
      return Promise.resolve(view === 64 ? EN : null);
    };
    // A per-user install registered in HKCU wins (Windows resolves `chrome` the same way) …
    expect(await findChrome({ regQuery, fs: createMemoryFs({ [USER]: '', [SYSTEM]: '' }), env })).toBe(USER);
    expect(queries).toEqual(['HKCU@64', 'HKLM@64', 'HKLM@32']);
    // … a stale HKCU entry (file gone) falls through to HKLM.
    expect(await findChrome({ regQuery, fs: createMemoryFs({ [SYSTEM]: '' }), env })).toBe(SYSTEM);
  });

  it('falls back to Program Files, Program Files (x86), %LOCALAPPDATA% and returns null without Chrome', async () => {
    const none: RegQuery = () => Promise.resolve(null);
    const found = (files: string[]) =>
      findChrome({ regQuery: none, fs: createMemoryFs(Object.fromEntries(files.map((f) => [f, '']))), env });
    expect(await found([USER, X86, SYSTEM])).toBe(SYSTEM);
    expect(await found([USER, X86])).toBe(X86);
    expect(await found([USER])).toBe(USER);
    expect(await found([])).toBeNull();
    // Never a bare name or the current directory: without env roots nothing is probed.
    const fs = createMemoryFs({ 'chrome.exe': '' });
    expect(await findChrome({ regQuery: none, fs, env: {} })).toBeNull();
    expect(fs.touched).toEqual([]);
  });

  it('never touches an unsafe or non-exe registry value', async () => {
    const fs = createMemoryFs({});
    const unc: RegQuery = () => Promise.resolve('    (Default)    REG_SZ    \\\\evil\\share\\chrome.exe\r\n');
    expect(await findChrome({ regQuery: unc, fs, env: {} })).toBeNull();
    const cmd: RegQuery = () => Promise.resolve('    (Default)    REG_SZ    C:\\evil\\chrome.cmd\r\n');
    expect(await findChrome({ regQuery: cmd, fs, env: {} })).toBeNull();
    expect(fs.touched).toEqual([]);
  });
});

/** A fake executable: noise, a decoy signature (as in code), then a version resource. */
function fakeExe(version: [number, number, number, number], options: { decoy?: boolean } = {}): Buffer {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x00010000, 4);
  // File version 1.2.3.4 (must not be reported), product version = `version`.
  fixed.writeUInt32LE((1 << 16) | 2, 8);
  fixed.writeUInt32LE((3 << 16) | 4, 12);
  fixed.writeUInt32LE(((version[0] << 16) | version[1]) >>> 0, 16);
  fixed.writeUInt32LE(((version[2] << 16) | version[3]) >>> 0, 20);
  const header = Buffer.from([0x34, 0x03, 0x34, 0x00, 0x00, 0x00]);
  const key = Buffer.from('VS_VERSION_INFO\0', 'utf16le');
  const decoy = Buffer.alloc(16);
  decoy.writeUInt32LE(0xfeef04bd, 0);
  decoy.writeUInt32LE(0x00010000, 4);
  decoy.writeUInt32LE(0x00ff00ff, 8);
  return Buffer.concat([
    Buffer.from('MZ noise'),
    options.decoy === false ? Buffer.alloc(0) : decoy,
    Buffer.alloc(10),
    header,
    key,
    Buffer.alloc(2),
    fixed,
  ]);
}

describe('exeProductVersion (preflight: Chrome version without starting it)', () => {
  it('reads the product version behind the VS_VERSION_INFO key, ignoring a signature in code', () => {
    expect(exeProductVersion(fakeExe([156, 0, 8078, 76]))).toBe('156.0.8078.76');
    expect(exeProductVersion(fakeExe([157, 0, 8103, 40], { decoy: false }))).toBe('157.0.8103.40');
  });

  it('null without a version resource or with a damaged one', () => {
    expect(exeProductVersion(Buffer.from('MZ no resources'))).toBeNull();
    const broken = fakeExe([156, 0, 8078, 76]);
    broken.writeUInt32LE(0x12345678, broken.length - 52);
    expect(exeProductVersion(broken)).toBeNull();
    expect(exeProductVersion(fakeExe([156, 0, 8078, 76]).subarray(0, -40))).toBeNull();
  });

  it('readExeVersion reads a real file and never an unsafe path', async () => {
    const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'chrome-version-'));
    try {
      const file = path.join(dir, 'chrome.exe');
      await writeFile(file, fakeExe([156, 0, 8078, 76]));
      expect(await readExeVersion(file)).toBe('156.0.8078.76');
      expect(await readExeVersion(path.join(dir, 'missing.exe'))).toBeNull();
      expect(await readExeVersion(dir)).toBeNull();
      expect(await readExeVersion('\\\\evil\\share\\chrome.exe')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
