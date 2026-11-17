import { describe, expect, it } from 'vitest';
import { handOverArgs, parseInstallerArgs } from './args';

const CWD = 'D:\\downloads\\parallax-1.1.0';

describe('installer arguments (WP-86)', () => {
  it('defaults to installing this package; both value forms; relative paths from the console folder', () => {
    expect(parseInstallerArgs([], CWD)).toMatchObject({
      action: { kind: 'install', packageDir: null },
      problem: null,
    });
    const args = parseInstallerArgs(
      ['--dir', 'D:\\apps\\Parallax', '--registry=https://registry.example/', '--sdk-tarball', 'sdk.tgz'],
      CWD,
    );
    expect(args).toMatchObject({
      dir: 'D:\\apps\\Parallax',
      registry: 'https://registry.example/',
      sdkTarball: 'D:\\downloads\\parallax-1.1.0\\sdk.tgz',
      problem: null,
    });
  });

  it('knows --install, --use and --uninstall, one at a time', () => {
    expect(parseInstallerArgs(['--install-root=C:\\P', '--install', 'D:\\pkg'], CWD).action).toEqual({
      kind: 'install',
      packageDir: 'D:\\pkg',
    });
    expect(parseInstallerArgs(['--use', '1.0.0'], CWD).action).toEqual({ kind: 'use', version: '1.0.0' });
    expect(parseInstallerArgs(['--uninstall'], CWD).action).toEqual({ kind: 'uninstall' });
    expect(parseInstallerArgs(['--use', '1.0.0', '--uninstall'], CWD).problem).toMatch(/cannot be combined/);
  });

  it('refuses unknown options, missing values, bad versions, unsafe paths and --dir next to --install-root', () => {
    const problem = (argv: string[]) => parseInstallerArgs(argv, CWD).problem;
    expect(problem(['--force'])).toMatch(/unknown option "--force"/);
    expect(problem(['--dir'])).toMatch(/--dir needs a value/);
    expect(problem(['--dir=D:\\a', '--dir=D:\\b'])).toMatch(/twice/);
    expect(problem(['--use', '../1.0.0'])).toMatch(/--use needs a version/);
    expect(problem(['--dir', '\\\\server\\share'])).toMatch(/absolute local path \(unc\)/);
    expect(problem(['--install-root=C:\\P', '--dir=D:\\Q'])).toMatch(/--dir cannot be used here/);
    expect(problem(['--registry', 'file:///x'])).toMatch(/http\(s\) URL/);
    expect(parseInstallerArgs(['--help'], CWD).help).toBe(true);
  });

  it('hands the same action over to the installed version, an install with this package', () => {
    const own = 'D:\\downloads\\parallax-1.1.0';
    expect(
      handOverArgs(parseInstallerArgs(['--dir=D:\\apps', '--registry=https://r.example/'], CWD), own),
    ).toEqual(['--install', own, '--registry', 'https://r.example/']);
    expect(handOverArgs(parseInstallerArgs(['--uninstall'], CWD), own)).toEqual(['--uninstall']);
    expect(handOverArgs(parseInstallerArgs(['--use=1.0.0'], CWD), own)).toEqual(['--use', '1.0.0']);
  });
});
