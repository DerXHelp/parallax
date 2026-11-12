import type { SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SAMPLE_IDS } from '@shared/samples';
import type { GuiChild, GuiSpawnFn } from '../lib/process';
import { CommandError } from '../sync/ports';
import {
  browserLaunch,
  createLinkCommands,
  createRecordingLinkOpener,
  createSystemLinkOpener,
  defaultBrowserCommand,
  splitCommandLine,
} from './linkCommands';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const URL = 'https://claude.ai/code/session_01QKkfSZajXxCTUVAWr5SbHm';

/** `reg query <UserChoice>` output (all values). */
const userChoice = (progId: string): string =>
  `\r\nHKEY_CURRENT_USER\\Software\\...\\https\\UserChoice\r\n    Hash    REG_SZ    abc=\r\n    ProgId    REG_SZ    ${progId}\r\n\r\n`;
/** `reg query <command> /ve` output. */
const defaultValue = (value: string, type = 'REG_SZ'): string =>
  `\r\nHKEY_CURRENT_USER\\Software\\Classes\\X\\shell\\open\\command\r\n    (Default)    ${type}    ${value}\r\n\r\n`;

function guiHead(subsystem = 2): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'latin1');
  bytes.writeUInt16LE(240, 0x80 + 20);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt16LE(subsystem, 0x98 + 68);
  return bytes;
}

function recordingSpawn(): GuiSpawnFn & { calls: { file: string; args: readonly string[]; options: SpawnOptions }[] } {
  const calls: { file: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const spawn: GuiSpawnFn = (file, args, options) => {
    calls.push({ file, args, options });
    const child: GuiChild = {
      once: (event, listener) => {
        if (event === 'spawn') queueMicrotask(() => { listener(); });
        return child;
      },
      unref: () => undefined,
    };
    return child;
  };
  return Object.assign(spawn, { calls });
}

function registry(entries: Record<string, string>) {
  const asked: string[] = [];
  const query = (key: string) => {
    asked.push(key);
    return Promise.resolve(entries[key] ?? null);
  };
  return { asked, regQuery: query, regKeyQuery: query };
}

const CHOICE = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
const HTTP_CHOICE = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice';
const command = (progId: string, hive = 'HKCU'): string => `${hive}\\Software\\Classes\\${progId}\\shell\\open\\command`;

function opener(entries: Record<string, string>, head = guiHead()) {
  const spawn = recordingSpawn();
  const reg = registry(entries);
  const system = createSystemLinkOpener({
    ...reg,
    env: { ProgramFiles: 'C:\\Program Files' },
    spawn,
    readHead: () => Promise.resolve(head),
    platform: 'win32',
  });
  return { system, spawn, reg };
}

async function reason(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return { code: error.error.code, params: error.error.params };
    throw error;
  }
  return 'resolved';
}

describe('command line parsing', () => {
  it.each<[string, string[]]>([
    [`"${CHROME}" --single-argument %1`, [CHROME, '--single-argument', '%1']],
    [`${FIREFOX} -osint -url "%1"`, ['C:\\Program', 'Files\\Mozilla', 'Firefox\\firefox.exe', '-osint', '-url', '%1']],
    [`"${FIREFOX}" -osint -url "%1"`, [FIREFOX, '-osint', '-url', '%1']],
    ['  ', []],
  ])('%s', (line, tokens) => {
    expect(splitCommandLine(line)).toEqual(tokens);
  });

  it('the URL takes %1/%L, other placeholders drop, none → appended; only absolute .exe', () => {
    expect(browserLaunch(`"${CHROME}" --single-argument %1`, URL)).toEqual({ file: CHROME, args: ['--single-argument', URL] });
    expect(browserLaunch(`"${FIREFOX}" -osint -url "%1"`, URL)).toEqual({ file: FIREFOX, args: ['-osint', '-url', URL] });
    expect(browserLaunch(`"${EDGE}" --flag %* %L`, URL)).toEqual({ file: EDGE, args: ['--flag', URL] });
    expect(browserLaunch(`"${EDGE}"`, URL)).toEqual({ file: EDGE, args: [URL] });
    expect(browserLaunch('chrome.exe %1', URL)).toBeNull();
    expect(browserLaunch('"C:\\Windows\\launch.cmd" %1', URL)).toBeNull();
    expect(browserLaunch('"\\\\server\\share\\b.exe" %1', URL)).toBeNull();
  });
});

describe('default browser from the registry', () => {
  it.each<[string, string, string, string]>([
    ['Chrome', 'ChromeHTML', `"${CHROME}" --single-argument %1`, CHROME],
    ['Edge', 'MSEdgeHTM', `"${EDGE}" --single-argument %1`, EDGE],
    ['Firefox', 'FirefoxURL-308046B0AF4A39CB', `"${FIREFOX}" -osint -url "%1"`, FIREFOX],
  ])('%s: UserChoice → ProgId → shell\\open\\command → spawnGui with the URL', async (_name, progId, line, exe) => {
    const { system, spawn } = opener({ [CHOICE]: userChoice(progId), [command(progId)]: defaultValue(line) });
    await system.open(URL);
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]?.file).toBe(exe);
    expect(spawn.calls[0]?.args).toContain(URL);
    expect(spawn.calls[0]?.options).toMatchObject({ shell: false, detached: true });
  });

  it('HKLM classes and the http choice as fallbacks; REG_EXPAND_SZ is expanded', async () => {
    const reg = registry({
      [HTTP_CHOICE]: userChoice('ChromeHTML'),
      [command('ChromeHTML', 'HKLM')]: defaultValue('"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" %1', 'REG_EXPAND_SZ'),
    });
    await expect(defaultBrowserCommand({ ...reg, env: { ProgramFiles: 'C:\\Program Files' } })).resolves.toBe(`"${CHROME}" %1`);
    expect(reg.asked).toEqual([CHOICE, HTTP_CHOICE, command('ChromeHTML'), command('ChromeHTML', 'HKLM')]);
  });

  it('no choice, a strange ProgId or no command → OPEN_FAILED no_default_browser (nothing starts)', async () => {
    for (const entries of [{}, { [CHOICE]: userChoice('..\\evil') }, { [CHOICE]: userChoice('ChromeHTML') }]) {
      const { system, spawn } = opener(entries);
      expect(await reason(system.open(URL))).toEqual({ code: 'OPEN_FAILED', params: { reason: 'no_default_browser' } });
      expect(spawn.calls).toEqual([]);
    }
  });

  it('a command without absolute .exe, a console program or a blocked program never starts', async () => {
    const relative = opener({ [CHOICE]: userChoice('X'), [command('X')]: defaultValue('browser.exe %1') });
    expect(await reason(relative.system.open(URL))).toMatchObject({ params: { reason: 'browser_command' } });
    const cui = opener({ [CHOICE]: userChoice('X'), [command('X')]: defaultValue(`"${CHROME}" %1`) }, guiHead(3));
    expect(await reason(cui.system.open(URL))).toMatchObject({ params: { reason: 'not_gui' } });
    const blocked = opener({
      [CHOICE]: userChoice('X'),
      [command('X')]: defaultValue('"C:\\Windows\\System32\\cmd.exe" /c start %1'),
    });
    expect(await reason(blocked.system.open(URL))).toMatchObject({ params: { reason: 'blocked' } });
    for (const o of [relative, cui, blocked]) expect(o.spawn.calls).toEqual([]);
  });

  it('not Windows → OPEN_FAILED platform', async () => {
    const system = createSystemLinkOpener({ platform: 'linux' });
    expect(await reason(system.open(URL))).toMatchObject({ params: { reason: 'platform' } });
  });
});

describe('link.open host command', () => {
  it('checks the URL again and hands it to the opener', async () => {
    const recording = createRecordingLinkOpener();
    const handler = createLinkCommands(recording);
    expect(handler.names).toEqual(['link.open']);
    const ctx = { clientId: SAMPLE_IDS.client, cmdId: SAMPLE_IDS.cmdId };
    await expect(handler.handle({ name: 'link.open', url: URL }, ctx)).resolves.toEqual({});
    expect(recording.opened).toEqual([URL]);
    expect(await reason(handler.handle({ name: 'link.open', url: 'javascript:alert(1)' }, ctx))).toMatchObject({
      params: { reason: 'url' },
    });
    expect(recording.opened).toEqual([URL]);
  });
});
