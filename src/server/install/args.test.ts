import { describe, expect, it } from 'vitest';
import { handOverArgs, installerUsage, parseInstallerArgs } from './args';

const CWD = 'D:\\downloads\\parallax-1.1.0';

describe('installer arguments (WP-86)', () => {
  it('defaults to installing this package; both value forms; relative paths from the console folder', () => {
    expect(parseInstallerArgs([], CWD, 'win32')).toMatchObject({
      action: { kind: 'install', packageDir: null },
      problem: null,
    });
    const args = parseInstallerArgs(
      ['--dir', 'D:\\apps\\Parallax', '--registry=https://registry.example/', '--sdk-tarball', 'sdk.tgz'],
      CWD,
      'win32',
    );
    expect(args).toMatchObject({
      dir: 'D:\\apps\\Parallax',
      registry: 'https://registry.example/',
      sdkTarball: 'D:\\downloads\\parallax-1.1.0\\sdk.tgz',
      problem: null,
    });
  });

  it('knows --install, --use and --uninstall, one at a time', () => {
    expect(parseInstallerArgs(['--install-root=C:\\P', '--install', 'D:\\pkg'], CWD, 'win32').action).toEqual(
      {
        kind: 'install',
        packageDir: 'D:\\pkg',
      },
    );
    expect(parseInstallerArgs(['--use', '1.0.0'], CWD, 'win32').action).toEqual({
      kind: 'use',
      version: '1.0.0',
    });
    expect(parseInstallerArgs(['--uninstall'], CWD, 'win32').action).toEqual({ kind: 'uninstall' });
    expect(parseInstallerArgs(['--use', '1.0.0', '--uninstall'], CWD, 'win32').problem).toMatch(
      /cannot be combined/,
    );
  });

  it('refuses unknown options, missing values, bad versions, unsafe paths and --dir next to --install-root', () => {
    const problem = (argv: string[]) => parseInstallerArgs(argv, CWD, 'win32').problem;
    expect(problem(['--force'])).toMatch(/unknown option "--force"/);
    expect(problem(['--dir'])).toMatch(/--dir needs a value/);
    expect(problem(['--dir=D:\\a', '--dir=D:\\b'])).toMatch(/twice/);
    expect(problem(['--use', '../1.0.0'])).toMatch(/--use needs a version/);
    expect(problem(['--dir', '\\\\server\\share'])).toMatch(/absolute local path \(unc\)/);
    expect(problem(['--install-root=C:\\P', '--dir=D:\\Q'])).toMatch(/--dir cannot be used here/);
    expect(problem(['--registry', 'file:///x'])).toMatch(/http\(s\) URL/);
    expect(parseInstallerArgs(['--help'], CWD, 'win32').help).toBe(true);
  });

  it('hands the same action over to the installed version, an install with this package', () => {
    const own = 'D:\\downloads\\parallax-1.1.0';
    expect(
      handOverArgs(
        parseInstallerArgs(['--dir=D:\\apps', '--registry=https://r.example/'], CWD, 'win32'),
        own,
      ),
    ).toEqual(['--install', own, '--registry', 'https://r.example/']);
    expect(handOverArgs(parseInstallerArgs(['--uninstall'], CWD, 'win32'), own)).toEqual(['--uninstall']);
    expect(handOverArgs(parseInstallerArgs(['--use=1.0.0'], CWD, 'win32'), own)).toEqual(['--use', '1.0.0']);
  });

  it('Linux (WP-108): POSIX paths relative to the console folder, POSIX rules, its own usage text', () => {
    const cwd = '/home/demo/Downloads/parallax-1.1.0';
    const args = parseInstallerArgs(['--dir', '../apps/parallax', '--sdk-tarball=sdk.tgz'], cwd, 'linux');
    expect(args).toMatchObject({
      dir: '/home/demo/Downloads/apps/parallax',
      sdkTarball: '/home/demo/Downloads/parallax-1.1.0/sdk.tgz',
      problem: null,
    });
    expect(
      parseInstallerArgs(['--install-root=/home/demo/.local/lib/parallax', '--uninstall'], cwd, 'linux'),
    ).toMatchObject({ installRoot: '/home/demo/.local/lib/parallax', action: { kind: 'uninstall' } });
    expect(parseInstallerArgs(['--dir', '/proc/self'], cwd, 'linux').problem).toMatch(
      /absolute local path \(pseudo_fs\)/,
    );
    // A backslash is an ordinary character on Linux: a relative name below the console folder.
    expect(parseInstallerArgs(['--dir', 'D:\\apps'], cwd, 'linux').dir).toBe(`${cwd}/D:\\apps`);
    expect(installerUsage('linux')).toContain('sh install.sh');
    expect(installerUsage('linux')).toContain('~/.local/bin/parallax');
    expect(installerUsage('win32')).toContain('install.cmd');
  });
});
