/**
 * Command line of the installer (`install.cmd` / `node dist\install.js`, and `start.mjs --install
 * | --uninstall | --use` of an installation; WP-86, docs/wp/WP-83.md §8.3). Options take their
 * value as `--name value` or `--name=value`.
 */
import path from 'node:path';
import { windowsPathIssue } from '@shared/paths';
import { releaseVersionSchema } from '../launcher/release';

export type InstallerAction =
  { kind: 'install'; packageDir: string | null } | { kind: 'use'; version: string } | { kind: 'uninstall' };

export interface InstallerArgs {
  action: InstallerAction;
  /** `--dir`: the installation root (default `%LOCALAPPDATA%\Programs\Parallax`). */
  dir: string | null;
  /** `--install-root` (set by start.mjs): runs as the installed version of this root. */
  installRoot: string | null;
  registry: string | null;
  sdkTarball: string | null;
  help: boolean;
  problem: string | null;
}

const VALUE_FLAGS = ['--dir', '--install-root', '--install', '--use', '--registry', '--sdk-tarball'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

export const INSTALLER_USAGE = [
  'Usage: install.cmd [--dir <folder>] [--registry <url>] [--sdk-tarball <file>]',
  '       install.cmd --use <version> | --uninstall [--dir <folder>]',
  '       parallax.cmd --install <unpacked package> | --use <version> | --uninstall',
  '',
  'Installs Parallax from this unpacked package into %LOCALAPPDATA%\\Programs\\Parallax (or --dir).',
  'With an installation there, the installed version checks and installs the package.',
  '',
  '  --dir <folder>         installation folder (absolute, local)',
  '  --registry <url>       npm registry for the Agent SDK (default: npm configuration, .npmrc)',
  '  --sdk-tarball <file>   the Agent SDK from this file (when no registry can be reached)',
  '  --use <version>        switch to another installed version',
  '  --uninstall            remove the installation, its Start menu entry, autostart and link',
  '                         handler; the data in %LOCALAPPDATA%\\Parallax stay',
  '  --help                 this text',
].join('\n');

/** `cwd`: base of relative paths (`--dir`, `--install`, `--sdk-tarball`; default `process.cwd()`). */
export function parseInstallerArgs(argv: readonly string[], cwd: string = process.cwd()): InstallerArgs {
  const args: InstallerArgs = {
    action: { kind: 'install', packageDir: null },
    dir: null,
    installRoot: null,
    registry: null,
    sdkTarball: null,
    help: false,
    problem: null,
  };
  const values = new Map<ValueFlag, string>();
  let uninstall = false;
  for (let i = 0; i < argv.length && args.problem === null; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h' || arg === '/?') {
      args.help = true;
      continue;
    }
    if (arg === '--uninstall') {
      uninstall = true;
      continue;
    }
    const flag = VALUE_FLAGS.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (flag === undefined) {
      args.problem = `unknown option "${arg.slice(0, 100)}"`;
      break;
    }
    const value = arg === flag ? argv[++i] : arg.slice(flag.length + 1);
    if (value === undefined || value === '') args.problem = `${flag} needs a value`;
    else if (values.has(flag)) args.problem = `${flag} was given twice`;
    else values.set(flag, value);
  }
  if (args.problem !== null || args.help) return args;

  for (const flag of ['--dir', '--install-root', '--install', '--sdk-tarball'] as const) {
    const given = values.get(flag);
    if (given === undefined) continue;
    // start.mjs passes its root absolute; the others may be relative to the console's folder.
    const value = flag === '--install-root' ? given : path.win32.resolve(cwd, given);
    values.set(flag, value);
    const issue = windowsPathIssue(value);
    if (issue !== null) {
      args.problem = `${flag} needs an absolute local path (${issue})`;
      return args;
    }
  }
  const use = values.get('--use');
  const install = values.get('--install');
  const actions = [uninstall, use !== undefined, install !== undefined].filter(Boolean).length;
  if (actions > 1) {
    args.problem = '--install, --use and --uninstall cannot be combined';
    return args;
  }
  if (use !== undefined && !releaseVersionSchema.safeParse(use).success) {
    args.problem = `--use needs a version like 1.2.3, got "${use.slice(0, 40)}"`;
    return args;
  }
  args.dir = values.get('--dir') ?? null;
  args.installRoot = values.get('--install-root') ?? null;
  if (args.dir !== null && args.installRoot !== null) {
    args.problem = '--dir cannot be used here: this installation lives in its own folder';
    return args;
  }
  const registry = values.get('--registry') ?? null;
  if (registry !== null && !/^https?:\/\/\S+$/iu.test(registry)) {
    args.problem = '--registry needs an http(s) URL';
    return args;
  }
  args.registry = registry;
  args.sdkTarball = values.get('--sdk-tarball') ?? null;
  args.action = uninstall
    ? { kind: 'uninstall' }
    : use !== undefined
      ? { kind: 'use', version: use }
      : { kind: 'install', packageDir: install ?? null };
  return args;
}

/**
 * The arguments for the installed version's start.mjs (hand-over, §8.3 step 2): the same action,
 * an install with this package folder; `--dir` stays behind (start.mjs adds its own root).
 */
export function handOverArgs(args: InstallerArgs, ownPackage: string): string[] {
  const out: string[] = [];
  if (args.action.kind === 'uninstall') out.push('--uninstall');
  else if (args.action.kind === 'use') out.push('--use', args.action.version);
  else out.push('--install', args.action.packageDir ?? ownPackage);
  if (args.registry !== null) out.push('--registry', args.registry);
  if (args.sdkTarball !== null) out.push('--sdk-tarball', args.sdkTarball);
  return out;
}
