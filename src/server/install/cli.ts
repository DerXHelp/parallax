/**
 * The installer's flow (WP-86, docs/wp/WP-83.md §8.3); main.ts runs it with the real dependencies.
 *
 * 1. Arguments; the Node version against `minNode` of the own release.json (before anything else,
 *    with a clear message); without the network flags (`PACKAGE_NODE_FLAGS`) it starts itself again
 *    with them – install.cmd passes none, so an old Node can still print which version it needs.
 * 2. Started from a package (no `--install-root`) with an installation in the root: hand-over to
 *    the installed version (`<root>\start.mjs --install <this package>`), which checks the package
 *    with its own code and keys (§7). Only the first installation trusts the downloaded installer.
 * 3. One installer per root at a time (pipe lock `install`), then install, `--use` or `--uninstall`.
 *
 * Exit codes: 0 = done, 2 = bad option, else 1. Messages are English like the launcher's.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { isWindowsPathInside } from '@shared/paths';
import { toError } from '../lib/async';
import { PACKAGE_NODE_FLAGS, readReleaseInfo, ReleaseInfoError } from '../launcher/release';
import { handOverArgs, INSTALLER_USAGE, parseInstallerArgs, type InstallerArgs } from './args';
import {
  checkNodeVersion,
  installPackage,
  useVersion,
  type InstallDeps,
  type InstallResult,
} from './install';
import { InstallError, START_CMD, START_SCRIPT, defaultInstallRoot, readCurrent } from './layout';
import { SdkError } from './sdk';
import { uninstall, type UninstallDeps } from './uninstall';

export interface InstallerCliDeps {
  env: NodeJS.ProcessEnv;
  /** Base of relative paths. */
  cwd: string;
  /** The package (or version folder) this installer belongs to: the parent of `dist/`. */
  ownDir: string;
  /** This installer's script (`dist/install.js`) – for the restart with the network flags. */
  installerScript: string;
  /** Node flags of this process (`process.execArgv`). */
  execArgv: readonly string[];
  /** Default `process.versions.node`. */
  nodeVersion?: string;
  /** Runs `node.exe <args>` with this console; resolves with the exit code. */
  runNode: (args: readonly string[]) => Promise<number>;
  /** The exclusive installer lock of `root`; null = another installer holds it. */
  lockRoot: (root: string) => Promise<{ release(): Promise<void> } | null>;
  /** Install, `--use` and `--uninstall` steps (SDK, Start menu, entries, running server). */
  steps: (root: string) => InstallDeps & UninstallDeps;
  /** The data directory (named after an uninstall). */
  dataDir: string;
  /** Leaves `root` as working directory (the uninstaller deletes it). */
  leave: (root: string) => void;
  /** Test seam: release keys of `installPackage`. */
  keys?: readonly string[];
  out: (line: string) => void;
  fail: (line: string) => void;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function installMessages(result: InstallResult, root: string): string[] {
  const cmd = path.join(root, START_CMD);
  const lines = [`Parallax ${result.version} is installed in ${root}.`];
  if (result.previous !== null) {
    lines.push(
      `The previous version ${result.previous} stays for the way back ("${cmd}" --use ${result.previous}).`,
    );
  }
  if (result.runningOther !== null) {
    lines.push(
      `Parallax ${result.runningOther} is still running: choose "Stop server" in its menu (gear) and start ` +
        `Parallax again to use ${result.version}.`,
    );
  } else if (result.runningForeign) {
    lines.push(
      'A Parallax from another folder (e.g. a git checkout) is running on the data directory: choose ' +
        '"Stop server" in its menu (gear), then start Parallax from the Start menu.',
    );
  }
  lines.push(
    result.startMenuProblem === null
      ? `Start Parallax from the Start menu ("Parallax") or with "${cmd}".`
      : `Note: no Start menu entry (${result.startMenuProblem}) - start Parallax with "${cmd}".`,
  );
  if (result.cleanup.problems.length > 0) {
    lines.push(
      `Note: old versions could not be removed yet (${result.cleanup.problems.join('; ')}) - the next ` +
        'installation tries again.',
    );
  }
  return lines;
}

async function act(args: InstallerArgs, root: string, deps: InstallerCliDeps): Promise<number> {
  const steps = deps.steps(root);
  switch (args.action.kind) {
    case 'install': {
      const result = await installPackage(
        {
          packageDir: args.action.packageDir ?? deps.ownDir,
          root,
          ...(args.sdkTarball === null ? {} : { sdkTarball: args.sdkTarball }),
          ...(args.registry === null ? {} : { registry: args.registry }),
          ...(deps.keys === undefined ? {} : { keys: deps.keys }),
          ...(deps.nodeVersion === undefined ? {} : { nodeVersion: deps.nodeVersion }),
        },
        steps,
      );
      for (const line of installMessages(result, root)) deps.out(line);
      return 0;
    }
    case 'use': {
      const result = await useVersion(root, args.action.version, steps);
      deps.out(
        result.unchanged
          ? `Parallax ${result.version} is the current version already.`
          : `Parallax now starts version ${result.version}${result.previous === null ? '' : ` (before: ${result.previous})`}.`,
      );
      if (result.runningOther !== null) {
        deps.out(
          `Parallax ${result.runningOther} is still running: choose "Stop server" in its menu (gear) and start ` +
            'Parallax again.',
        );
      }
      return 0;
    }
    case 'uninstall': {
      deps.leave(root);
      const result = await uninstall(root, steps);
      deps.out(
        result.leftovers.length === 0
          ? `Parallax was removed from ${root}.`
          : `Parallax was removed; ${root} keeps files that are not Parallax's: ${result.leftovers.join(', ')}.`,
      );
      for (const problem of result.problems) deps.out(`Note: ${problem}`);
      deps.out(`Your data stay in ${deps.dataDir} - delete that folder to remove them too.`);
      return 0;
    }
  }
}

export async function runInstallerCli(argv: readonly string[], deps: InstallerCliDeps): Promise<number> {
  const args = parseInstallerArgs(argv, deps.cwd);
  if (args.help) {
    deps.out(INSTALLER_USAGE);
    return 0;
  }
  if (args.problem !== null) {
    deps.fail(`Invalid option: ${args.problem}\n\n${INSTALLER_USAGE}`);
    return 2;
  }
  try {
    const own = await readReleaseInfo(deps.ownDir);
    if (own === null) {
      deps.fail(`${deps.ownDir} is no Parallax package (release.json is missing).`);
      return 1;
    }
    checkNodeVersion(own, deps.nodeVersion);
    if (!PACKAGE_NODE_FLAGS.every((flag) => deps.execArgv.includes(flag))) {
      return await deps.runNode([...PACKAGE_NODE_FLAGS, deps.installerScript, ...argv]);
    }
    const root = args.installRoot ?? args.dir ?? defaultInstallRoot(deps.env);
    if (root === null) {
      deps.fail('LOCALAPPDATA is not set - choose the installation folder with --dir <folder>.');
      return 2;
    }
    if (
      isWindowsPathInside(deps.ownDir, root) &&
      args.installRoot === null &&
      args.action.kind === 'install'
    ) {
      deps.fail(`Unpack the package outside the installation folder ${root} and start install.cmd there.`);
      return 2;
    }

    if (args.installRoot === null) {
      let installed: string | null = null;
      try {
        installed = (await readCurrent(root))?.version ?? null;
      } catch (error) {
        deps.out(`Note: ${toError(error).message} - this package repairs the installation.`);
      }
      const start = path.join(root, START_SCRIPT);
      if (installed !== null && (await exists(start))) {
        deps.out(`Parallax ${installed} is installed in ${root} - it checks and installs this package.`);
        return await deps.runNode([...PACKAGE_NODE_FLAGS, start, ...handOverArgs(args, deps.ownDir)]);
      }
      if (args.action.kind !== 'install') {
        deps.fail(`There is no Parallax installation in ${root}.`);
        return 1;
      }
    }

    const lock = await deps.lockRoot(root);
    if (lock === null) {
      deps.fail(`Another Parallax installation into ${root} is running - wait for it and try again.`);
      return 1;
    }
    try {
      return await act(args, root, deps);
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (error instanceof InstallError || error instanceof ReleaseInfoError || error instanceof SdkError) {
      deps.fail(error.message);
      return 1;
    }
    deps.fail(
      `Unexpected installer error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 1;
  }
}
