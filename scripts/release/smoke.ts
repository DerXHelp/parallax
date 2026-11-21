/**
 * Smoke test of a release package (WP-85/WP-86, docs/wp/WP-83.md §6, job "smoke"): the real
 * installer into a temp root, a second run (hand-over to the installed version), start through
 * start.mjs with the FakeBackend and a temp home, health and build id, the backup bookkeeping, then
 * `--uninstall`. CI runs it under the minimum Node and Node 26; locally only by hand (network, a
 * started server - not part of the tests).
 *
 *   … scripts/release/smoke.ts --zip <parallax-X-win.zip> --latest <latest.json> --work <empty dir>
 *   … scripts/release/smoke.ts --archive <parallax-X-linux-x64.tar.gz> --latest <latest.json> --work <dir>
 *   … scripts/release/smoke.ts --dir <release-pack output folder> --work <empty dir>   (unsigned trial)
 *
 * The installer gets its own APPDATA/LOCALAPPDATA below `--work`: the Start menu entry and the
 * default data directory stay inside the work folder. An unsigned trial (`--dir`) is signed with a
 * throwaway key and installed in-process with that key (the installer's command line never accepts
 * another key).
 *
 * Linux (WP-108): the archive of the platform (`--archive`, `--zip` is the same option), listed and
 * unpacked like the in-app update does (update/zip.ts); HOME and the XDG folders point below
 * `--work` (command `~/.local/bin/parallax`, menu entry, data); the server starts through the shell
 * script `<root>/parallax`, the uninstall through the command.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { access, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { healthResponseSchema } from '@shared/http';
import { createNodeInstallerDeps } from '../../src/server/install/nodeDeps';
import { runInstallerCli } from '../../src/server/install/cli';
import {
  COMMAND_NAME,
  CURRENT_FILE,
  currentFileSchema,
  PACKAGE_ROOT_DIR,
  START_SCRIPT,
  START_SH,
  startCommandFile,
} from '../../src/server/install/layout';
import { commandScriptRoot } from '../../src/server/install/templates';
import {
  PACKAGE_NODE_FLAGS,
  RELEASE_FILE,
  RELEASE_SIGNATURE_FILE,
  releaseInfoSchema,
  verifyReleaseSignature,
} from '../../src/server/launcher/release';
import { sha256File } from '../../src/server/launcher/packageFiles';
import { killProcessTree, runFile, systemTool } from '../../src/server/lib/process';
import { LAST_VERSION_FILE } from '../../src/server/store/backup';
import { releaseTarget, type ReleaseTarget } from '../../src/server/update/endpoints';
import { latestInfoSchema, releaseAssetOf } from '../../src/server/update/latest';
import { extractZip, listZip } from '../../src/server/update/zip';

const WINDOWS = process.platform === 'win32';
/** Linux: the user folders the installer and the server read, all below `--work`. */
const LINUX_USER_DIRS = {
  HOME: 'home',
  XDG_DATA_HOME: 'data',
  XDG_CONFIG_HOME: 'config',
  XDG_STATE_HOME: 'state',
  XDG_CACHE_HOME: 'cache',
} as const;

const RUN_TIMEOUT_MS = 10 * 60_000;

function log(line: string): void {
  process.stdout.write(`[smoke] ${line}\n`);
}

class SmokeError extends Error {}

/** The runner's environment without Parallax, npm-run and Claude variables, with own user folders. */
function smokeEnv(work: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        !/^(?:PARALLAX|npm_|CLAUDE)/iu.test(entry[0]) &&
        !/^(?:APPDATA|LOCALAPPDATA|HOME|XDG_[A-Z_]+)$/iu.test(entry[0]),
    ),
  );
  if (WINDOWS) {
    env.APPDATA = path.join(work, 'user', 'Roaming');
    env.LOCALAPPDATA = path.join(work, 'user', 'Local');
  } else {
    for (const [name, dir] of Object.entries(LINUX_USER_DIRS)) env[name] = path.join(work, 'user', dir);
  }
  env.PARALLAX_NO_PAUSE = '1';
  return env;
}

async function run(
  file: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const result = await runFile(file, args, { cwd, env, timeoutMs: RUN_TIMEOUT_MS });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new SmokeError(
      `${path.basename(file)} ${args.join(' ')} failed (${result.timedOut ? 'timeout' : `exit ${String(result.exitCode)}`}):\n` +
        `${result.stdout}\n${result.stderr}`.trim(),
    );
  }
  return result.stdout;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** The asset this archive is: the Linux tarball by its name, else the Windows zip. */
function targetOf(archive: string): ReleaseTarget {
  return path.basename(archive).endsWith('-linux-x64.tar.gz') ? 'linux-x64' : 'win';
}

/**
 * latest.json: signature, then size and SHA-256 of the archive against its asset (the Windows zip
 * at the top level, every asset in `assets`); returns its `minNode` (ADR-232).
 */
async function checkLatest(latestFile: string, archive: string): Promise<string> {
  const bytes = await readFile(latestFile);
  const signature = await readFile(`${latestFile}.sig`, 'utf8');
  if (!verifyReleaseSignature(bytes, signature)) throw new SmokeError('latest.json: invalid signature');
  const latest = latestInfoSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (latest.minNode === null) throw new SmokeError('latest.json names no minNode');
  const asset = releaseAssetOf(latest, targetOf(archive));
  if (asset?.name !== path.basename(archive)) {
    throw new SmokeError(`latest.json lists no asset ${path.basename(archive)}`);
  }
  const size = (await readFile(archive)).length;
  if (size !== asset.size || (await sha256File(archive)) !== asset.sha256) {
    throw new SmokeError(`${asset.name} does not match latest.json (size or SHA-256)`);
  }
  log(`latest.json ${latest.version}: signature and hash of ${asset.name} ok`);
  return latest.minNode;
}

/** Lists (the checks of the in-app update) and unpacks the archive with the tar of this platform. */
async function unpack(archive: string, work: string): Promise<string> {
  if (targetOf(archive) !== (releaseTarget() ?? 'win')) {
    throw new SmokeError(`${path.basename(archive)} is not the archive of this platform`);
  }
  const listing = await listZip(archive, null, { cwd: work });
  const target = path.join(work, 'unpacked');
  await mkdir(target, { recursive: true });
  await extractZip(archive, target, {});
  const folders = await readdir(target);
  if (folders.length !== 1 || folders[0] !== listing.rootDir)
    throw new SmokeError(`the archive must contain one folder, got ${folders.join(', ')}`);
  log(`${path.basename(archive)}: ${String(listing.entries)} entries, one folder ${listing.rootDir}`);
  return path.join(target, folders[0]);
}

/** The menu entry the installer writes (Windows: the Start menu shortcut). */
function menuEntry(env: Record<string, string>): string {
  return WINDOWS
    ? path.join(env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Parallax.lnk')
    : path.join(env.XDG_DATA_HOME ?? '', 'applications', 'parallax.desktop');
}

/** `--dir`: sign the copied package with a throwaway key; returns its public `x`. */
async function signTrial(pkgDir: string): Promise<string> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const bytes = await readFile(path.join(pkgDir, RELEASE_FILE));
  await writeFile(
    path.join(pkgDir, RELEASE_SIGNATURE_FILE),
    `${sign(null, bytes, privateKey).toString('base64')}\n`,
  );
  const x = publicKey.export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new SmokeError('no public key');
  log('release.json signed with a throwaway key (unsigned local trial)');
  return x;
}

/** The installer in-process with `keys` (only the unsigned trial). */
async function installInProcess(
  pkgDir: string,
  argv: string[],
  keys: string[],
  env: Record<string, string>,
): Promise<void> {
  const lines: string[] = [];
  const deps = createNodeInstallerDeps({
    env,
    ownDir: pkgDir,
    installerScript: path.join(pkgDir, 'dist', 'install.js'),
    execArgv: PACKAGE_NODE_FLAGS,
    keys,
    out: (line) => {
      lines.push(line);
      log(`  ${line}`);
    },
    fail: (line) => lines.push(line),
  });
  const code = await runInstallerCli(argv, deps);
  if (code !== 0) throw new SmokeError(`installer exit ${String(code)}:\n${lines.join('\n')}`);
}

async function main(argv: readonly string[]): Promise<void> {
  const zip = option(argv, '--zip') ?? option(argv, '--archive');
  const dir = option(argv, '--dir');
  const latestFile = option(argv, '--latest');
  const workArg = option(argv, '--work');
  if (workArg === undefined || (zip === undefined) === (dir === undefined)) {
    throw new SmokeError(
      'usage: smoke.ts (--zip|--archive <archive> [--latest <latest.json>] | --dir <folder>) --work <empty dir>',
    );
  }
  const work = path.resolve(workArg);
  await mkdir(work, { recursive: true });
  if ((await readdir(work)).length > 0) throw new SmokeError(`${work} is not empty`);
  const env = smokeEnv(work);
  const userDirs = WINDOWS
    ? [env.APPDATA, env.LOCALAPPDATA]
    : Object.keys(LINUX_USER_DIRS).map((name) => env[name]);
  for (const folder of userDirs) await mkdir(folder ?? '', { recursive: true });

  let pkgDir: string;
  let trialKey: string | null = null;
  let latestMinNode: string | null = null;
  if (zip !== undefined) {
    if (latestFile !== undefined) latestMinNode = await checkLatest(latestFile, path.resolve(zip));
    pkgDir = await unpack(path.resolve(zip), work);
  } else {
    pkgDir = path.join(work, 'package');
    await cp(path.resolve(dir ?? ''), pkgDir, { recursive: true });
    trialKey = await signTrial(pkgDir);
  }
  const release = releaseInfoSchema.parse(
    JSON.parse(await readFile(path.join(pkgDir, RELEASE_FILE), 'utf8')),
  );
  if (latestMinNode !== null && latestMinNode !== release.minNode) {
    throw new SmokeError(`latest.json names minNode ${latestMinNode}, release.json ${release.minNode}`);
  }
  const root = path.join(work, 'Programs', 'Parallax');
  const installer = path.join(pkgDir, 'dist', 'install.js');

  // 1. Install (no Node flags: install.js adds them itself), 2. again = hand-over to the installation.
  for (const round of ['install', 'hand-over']) {
    if (trialKey === null) {
      const output = await run(process.execPath, [installer, '--dir', root], work, env);
      log(`${round}:\n${output.trim().replace(/^/gmu, '  ')}`);
      if (round === 'hand-over' && !output.includes('checks and installs this package'))
        throw new SmokeError('the second run did not hand over to the installation');
    } else {
      // In-process there is no hand-over (it would start the installed version without the trial key).
      if (round === 'hand-over') continue;
      await installInProcess(pkgDir, ['--dir', root], [trialKey], env);
    }
  }
  const current = currentFileSchema.parse(JSON.parse(await readFile(path.join(root, CURRENT_FILE), 'utf8')));
  if (current.version !== release.version) throw new SmokeError(`current.json names ${current.version}`);
  const link = menuEntry(env);
  if (WINDOWS) {
    if (!(await exists(link))) throw new SmokeError(`no Start menu entry at ${link}`);
    log(`installed ${release.version} in ${root}, Start menu entry ok`);
  } else {
    // The menu entry belongs to the system integration (WP-106): reported, not required here.
    log(`installed ${release.version} in ${root}, menu entry ${(await exists(link)) ? 'ok' : 'not written'}`);
  }
  const command = path.join(env.HOME ?? '', '.local', 'bin', COMMAND_NAME);
  if (!WINDOWS) {
    const named = commandScriptRoot(await readFile(command, 'utf8').catch(() => ''));
    if (named !== root) throw new SmokeError(`${command} does not run the installation in ${root}`);
    log(`command ${command} ok`);
  }
  // WP-87: the root files come from the package (`root/`), so an update brings its own start script.
  for (const file of [START_SCRIPT, startCommandFile()]) {
    const packaged = await readFile(path.join(pkgDir, PACKAGE_ROOT_DIR, file));
    if (!packaged.equals(await readFile(path.join(root, file)))) {
      throw new SmokeError(`${file} in the root differs from ${PACKAGE_ROOT_DIR}/${file} of the package`);
    }
  }
  log(`root files match ${PACKAGE_ROOT_DIR}/ of the package`);

  // 3. Start through start.mjs like parallax.cmd does (Linux: through the shell script itself).
  const home = path.join(work, 'home');
  const serverArgs = [
    `--home=${home}`,
    '--backend=fake',
    '--port=0',
    '--system-integration=off',
    '--print-url',
  ];
  const output = WINDOWS
    ? await run(
        process.execPath,
        [...PACKAGE_NODE_FLAGS, path.join(root, START_SCRIPT), ...serverArgs],
        work,
        env,
      )
    : await run(systemTool('sh'), [path.join(root, START_SH), ...serverArgs], work, env);
  const match = /runs on (http:\/\/127\.0\.0\.1:\d+) \(PID (\d+)/u.exec(output);
  if (match?.[1] === undefined || match[2] === undefined)
    throw new SmokeError(`unexpected launcher output:\n${output}`);
  const pid = Number(match[2]);
  try {
    const response = await fetch(`${match[1]}/api/health`);
    const health = healthResponseSchema.parse(await response.json());
    if (health.buildId !== release.buildId) {
      throw new SmokeError(`health reports build ${health.buildId}, expected ${release.buildId}`);
    }
    const last = JSON.parse(await readFile(path.join(home, LAST_VERSION_FILE), 'utf8')) as {
      buildId?: unknown;
    };
    if (last.buildId !== release.buildId)
      throw new SmokeError(`${LAST_VERSION_FILE} names ${String(last.buildId)}`);
    log(
      `server ${health.serverVersion} on ${match[1]} healthy (build ${health.buildId}, Node ${process.version})`,
    );
  } finally {
    await killProcessTree(pid);
  }

  // 4. Uninstall: the root goes, the data stay (Linux: through the command).
  if (trialKey === null) {
    const removed = WINDOWS
      ? await run(
          process.execPath,
          [...PACKAGE_NODE_FLAGS, path.join(root, START_SCRIPT), '--uninstall'],
          work,
          env,
        )
      : await run(systemTool('sh'), [command, '--uninstall'], work, env);
    log(`uninstall:\n${removed.trim().replace(/^/gmu, '  ')}`);
  } else {
    // As the installed version (no hand-over to a second process).
    await installInProcess(pkgDir, [`--install-root=${root}`, '--uninstall'], [trialKey], env);
  }
  if (await exists(root)) throw new SmokeError(`${root} still exists after --uninstall`);
  if (await exists(link)) throw new SmokeError(`the menu entry ${link} still exists after --uninstall`);
  if (!WINDOWS && (await exists(command))) throw new SmokeError(`${command} still exists after --uninstall`);
  if (!(await exists(home))) throw new SmokeError('--uninstall removed the data');
  log('ok');
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`[smoke] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
