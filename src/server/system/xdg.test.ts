import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunFileFn } from '../lib/process';
import type { StartCommand } from './autostart';
import { entryMarkers } from './markers';
import {
  FOREIGN_ENTRY,
  HOME_MISSING,
  URL_HANDLER_FILE,
  URL_HANDLER_MIME,
  autostartEntryPath,
  desktopEntryText,
  desktopExecArg,
  desktopExecLine,
  desktopExecValue,
  memoryDesktopFs,
  nodeDesktopFs,
  parseDesktopExec,
  programEntryPath,
  registerUrlHandler,
  removeDesktopEntry,
  schemeDefault,
  unregisterUrlHandler,
  urlHandlerEntryPath,
  writeDesktopEntry,
} from './xdg';

const HOME = '/home/demo';
const COMMAND: StartCommand = {
  node: '/usr/bin/node',
  args: ['/home/demo/dev/parallax/src/server/launcher/main.ts', '--autostart'],
  cwd: '/home/demo/dev/parallax',
};
const CLONE = entryMarkers(null, 'posix');

describe('XDG locations (WP-106)', () => {
  it('from HOME and XDG_* (absolute only); none without a safe HOME', () => {
    const env = { HOME };
    expect(programEntryPath(env)).toBe('/home/demo/.local/share/applications/parallax.desktop');
    expect(urlHandlerEntryPath(env)).toBe(`/home/demo/.local/share/applications/${URL_HANDLER_FILE}`);
    expect(autostartEntryPath(env)).toBe('/home/demo/.config/autostart/parallax.desktop');
    const xdg = { HOME, XDG_DATA_HOME: '/data/demo', XDG_CONFIG_HOME: '/cfg/demo' };
    expect(programEntryPath(xdg)).toBe('/data/demo/applications/parallax.desktop');
    expect(autostartEntryPath(xdg)).toBe('/cfg/demo/autostart/parallax.desktop');
    // A relative XDG_* is ignored (Base Directory Specification).
    expect(autostartEntryPath({ HOME, XDG_CONFIG_HOME: 'cfg' })).toBe(
      '/home/demo/.config/autostart/parallax.desktop',
    );
    for (const bad of [{}, { HOME: '' }, { HOME: 'demo' }, { HOME: '/proc/1/root' }]) {
      expect(programEntryPath(bad)).toBeNull();
      expect(autostartEntryPath(bad)).toBeNull();
    }
  });
});

describe('Exec line (Desktop Entry Specification)', () => {
  it.each<[string, string]>([
    ['/usr/bin/node', '/usr/bin/node'],
    ['--home=/srv/px', '--home=/srv/px'],
    ['/home/demo/my repo/main.ts', '"/home/demo/my repo/main.ts"'],
    ['50%', '50%%'],
    ['a"b`c$d\\e', '"a\\"b\\`c\\$d\\\\e"'],
    ["it's", `"it's"`],
    ['', '""'],
  ])('%j → %s', (arg, expected) => {
    expect(desktopExecArg(arg)).toBe(expected);
  });

  it('parses back to the same argv; field codes dropped; control characters refused', () => {
    const command: StartCommand = {
      node: '/usr/bin/node',
      args: ['/home/demo/my repo/main.ts', '--home=/srv/p x', 'a"b`c$d\\e', '100%', "it's"],
      cwd: '/home/demo',
    };
    const line = desktopExecLine(command, '%u');
    expect(line).not.toBeNull();
    expect(line).toMatch(/ %u$/);
    expect(parseDesktopExec(line ?? '')).toEqual([command.node, ...command.args]);
    expect(desktopExecLine({ ...command, args: ['a\nb'] })).toBeNull();
    expect(parseDesktopExec('"unbalanced')).toBeNull();
  });

  it('entry texts: the Exec value survives the string escapes of the file format', () => {
    const command: StartCommand = { ...COMMAND, args: ['C:\\odd\\path', '--autostart'] };
    const text = desktopEntryText('autostart', command) ?? '';
    expect(text).toContain('Exec=/usr/bin/node "C:\\\\\\\\odd\\\\\\\\path" --autostart');
    expect(parseDesktopExec(desktopExecValue(text) ?? '')).toEqual([command.node, ...command.args]);
    expect(text).toContain('X-GNOME-Autostart-enabled=true');
    expect(text).toContain('StartupWMClass=parallax');
    expect(text).toContain('Terminal=false');
    const program = desktopEntryText('program', COMMAND, '/opt/parallax/parallax.svg') ?? '';
    expect(program).toContain('Icon=/opt/parallax/parallax.svg');
    expect(program).toContain('Categories=Development;');
    expect(program).not.toContain('NoDisplay');
    const handler = desktopEntryText('url-handler', { ...COMMAND, args: ['/x/main.ts', '--open'] }) ?? '';
    expect(handler).toContain(`MimeType=${URL_HANDLER_MIME};`);
    expect(handler).toContain('NoDisplay=true');
    expect(desktopExecValue(handler)).toBe('/usr/bin/node /x/main.ts --open %u');
    expect(desktopEntryText('program', { ...COMMAND, cwd: '/x\n' })).toBeNull();
    // Only the [Desktop Entry] group counts.
    expect(desktopExecValue('[Desktop Action new]\nExec=/x\n[Desktop Entry]\nExec=/y --z\n')).toBe('/y --z');
    expect(desktopExecValue('[Desktop Entry]\nName=x\n')).toBeNull();
  });
});

describe('entry ownership (system/markers.ts rules on the Exec line)', () => {
  const FILE = '/home/demo/.config/autostart/parallax.desktop';
  const entry = (exec: string) => `[Desktop Entry]\nType=Application\nExec=${exec}\n`;

  it('own: replaced and removed; foreign: never; deferred (an installation): left alone', async () => {
    const text = desktopEntryText('autostart', COMMAND) ?? '';
    const fs = memoryDesktopFs();
    expect(await writeDesktopEntry(FILE, text, { fs, markers: CLONE })).toEqual({ ok: true });
    expect(fs.files.get(FILE)).toBe(text);
    expect(await writeDesktopEntry(FILE, `${text}# again\n`, { fs, markers: CLONE })).toEqual({ ok: true });
    expect(await removeDesktopEntry(FILE, { fs, markers: CLONE })).toEqual({ ok: true });
    expect(fs.files.has(FILE)).toBe(false);
    expect(await removeDesktopEntry(FILE, { fs, markers: CLONE })).toEqual({ ok: true });

    for (const foreign of [entry('/usr/bin/other-app'), '[Desktop Entry]\nName=x\n', entry('"broken')]) {
      const other = memoryDesktopFs({ [FILE]: foreign });
      expect(await writeDesktopEntry(FILE, text, { fs: other, markers: CLONE })).toEqual({
        ok: false,
        reason: FOREIGN_ENTRY,
      });
      expect(await removeDesktopEntry(FILE, { fs: other, markers: CLONE })).toEqual({ ok: true });
      expect(other.files.get(FILE)).toBe(foreign);
    }

    const installed = memoryDesktopFs({ [FILE]: entry('/usr/bin/node /opt/parallax/start.mjs --autostart') });
    expect(await writeDesktopEntry(FILE, text, { fs: installed, markers: CLONE })).toEqual({
      ok: true,
      deferred: true,
    });
    expect(await removeDesktopEntry(FILE, { fs: installed, markers: CLONE })).toEqual({
      ok: true,
      deferred: true,
    });
    expect(installed.files.get(FILE)).toContain('/opt/parallax/start.mjs');
  });

  it('file errors are results with the error code, never thrown', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    const broken = {
      ...memoryDesktopFs(),
      readText: () => Promise.reject(error),
    };
    expect(await writeDesktopEntry('/x/a.desktop', 'x', { fs: broken, markers: CLONE })).toEqual({
      ok: false,
      reason: 'read /x/a.desktop: EACCES',
    });
    const readOnly = { ...memoryDesktopFs(), write: () => Promise.reject(error) };
    expect(await writeDesktopEntry('/x/a.desktop', 'x', { fs: readOnly, markers: CLONE })).toEqual({
      ok: false,
      reason: 'write /x/a.desktop: EACCES',
    });
  });
});

describe('parallax: handler (xdg-mime)', () => {
  const HANDLER = `${HOME}/.local/share/applications/${URL_HANDLER_FILE}`;

  function mime(handler: string | null, fail: 'exit' | 'timeout' | 'spawn' | null = null) {
    const state = { handler };
    const calls: { file: string; args: readonly string[]; env: Record<string, string> | undefined }[] = [];
    const run: RunFileFn = (file, args, options) => {
      calls.push({ file, args, env: options.env });
      if (fail === 'spawn') return Promise.reject(new Error('spawn ENOENT'));
      if (fail === 'timeout')
        return Promise.resolve({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true });
      if (fail === 'exit')
        return Promise.resolve({
          exitCode: 4,
          signal: null,
          stdout: '',
          stderr: 'no desktop\n',
          timedOut: false,
        });
      if (args[0] === 'default') state.handler = args[1] ?? null;
      const stdout = args[0] === 'query' && state.handler !== null ? `${state.handler}\n` : '';
      return Promise.resolve({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false });
    };
    return { run, calls, state };
  }

  it('registers: file with --open %u, then xdg-mime default; already ours → no second default', async () => {
    const m = mime(null);
    const fs = memoryDesktopFs();
    const deps = { run: m.run, env: { HOME, DISPLAY: ':0', CLAUDECODE: '1' }, fs, markers: CLONE };
    expect(await registerUrlHandler(COMMAND, deps)).toEqual({ ok: true });
    expect(m.calls.map((c) => [path.posix.basename(c.file), ...c.args])).toEqual([
      ['xdg-mime', 'query', 'default', URL_HANDLER_MIME],
      ['xdg-mime', 'default', URL_HANDLER_FILE, URL_HANDLER_MIME],
    ]);
    expect(path.posix.isAbsolute(m.calls[0]?.file ?? '')).toBe(true);
    // The environment of a desktop program: no Claude session variables.
    expect(m.calls[0]?.env).toEqual({ HOME, DISPLAY: ':0' });
    expect(parseDesktopExec(desktopExecValue(fs.files.get(HANDLER) ?? '') ?? '')).toEqual([
      COMMAND.node,
      ...COMMAND.args,
      '--open',
    ]);
    expect(await registerUrlHandler(COMMAND, deps)).toEqual({ ok: true });
    expect(m.calls).toHaveLength(3);
    expect(await unregisterUrlHandler(deps)).toEqual({ ok: true });
    expect(fs.files.has(HANDLER)).toBe(false);
  });

  it("another program's default stays (foreign); xdg-mime failures and a missing HOME are reasons", async () => {
    const other = mime('org.example.Other.desktop');
    const fs = memoryDesktopFs();
    expect(await registerUrlHandler(COMMAND, { run: other.run, env: { HOME }, fs, markers: CLONE })).toEqual({
      ok: false,
      reason: FOREIGN_ENTRY,
    });
    expect(other.state.handler).toBe('org.example.Other.desktop');
    expect(fs.files.size).toBe(0);
    for (const [fail, reason] of [
      ['exit', 'xdg-mime exit 4: no desktop'],
      ['timeout', 'xdg-mime timed out'],
      ['spawn', 'xdg-mime could not be started: spawn ENOENT'],
    ] as const) {
      const m = mime(null, fail);
      expect(await schemeDefault({ run: m.run, env: { HOME }, fs, markers: CLONE })).toEqual({
        kind: 'failed',
        reason,
      });
      expect(await registerUrlHandler(COMMAND, { run: m.run, env: { HOME }, fs, markers: CLONE })).toEqual({
        ok: false,
        reason,
      });
    }
    const none = mime(null);
    expect(await registerUrlHandler(COMMAND, { run: none.run, env: {}, fs, markers: CLONE })).toEqual({
      ok: false,
      reason: HOME_MISSING,
    });
    expect(none.calls).toEqual([]);
  });
});

describe.runIf(process.platform === 'linux')('nodeDesktopFs on a real Linux file system', () => {
  it('writes atomically (folder created), reads, states and removes', async () => {
    // test/setup points PARALLAX_HOME at a temp folder of this run.
    const root = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'xdg-'));
    const file = path.posix.join(root, 'applications', 'parallax.desktop');
    expect(await nodeDesktopFs.readText(file)).toBeNull();
    expect(await nodeDesktopFs.state(file)).toBe('absent');
    await nodeDesktopFs.write(file, '[Desktop Entry]\nExec=/usr/bin/node /x/launcher/main.ts\n');
    expect(await readFile(file, 'utf8')).toContain('launcher/main.ts');
    expect(await nodeDesktopFs.state(file)).not.toBe('absent');
    await writeFile(file, 'changed');
    expect(await nodeDesktopFs.readText(file)).toBe('changed');
    await nodeDesktopFs.remove(file);
    await nodeDesktopFs.remove(file);
    expect(await nodeDesktopFs.readText(file)).toBeNull();
  });
});
