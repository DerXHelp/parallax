/**
 * Smoke test of a release package (WP-85, docs/wp/WP-83.md §6, job "smoke"): verify, add the Agent SDK
 * from the registry (checked against `integrity`), start it with the FakeBackend and a temp home,
 * compare the health answer, stop it. CI runs it under the minimum Node and Node 26; locally only by
 * hand (network, a started server - not part of the tests).
 *
 *   … scripts/release/smoke.ts --zip <parallax-X-win.zip> --latest <latest.json> --work <empty dir>
 *   … scripts/release/smoke.ts --dir <release-pack output folder> --work <empty dir>   (unsigned trial)
 *
 * WP-86 replaces the SDK step with the real installer (`install.js`).
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { healthResponseSchema } from '@shared/http';
import { compareVersions } from '@shared/version';
import {
  comparePackageFiles,
  hashFiles,
  sha256File,
  walkPackage,
} from '../../src/server/launcher/packageFiles';
import {
  AGENT_SDK_PACKAGE,
  RELEASE_FILE,
  RELEASE_SIGNATURE_FILE,
  releaseInfoSchema,
  verifyReleaseSignature,
} from '../../src/server/launcher/release';
import { killProcessTree, runFile, systemTool } from '../../src/server/lib/process';

const RUN_TIMEOUT_MS = 5 * 60_000;

function log(line: string): void {
  process.stdout.write(`[smoke] ${line}\n`);
}

class SmokeError extends Error {}

function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !/^(?:PARALLAX|npm_|CLAUDE)/iu.test(entry[0]),
    ),
  );
}

async function run(file: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await runFile(file, args, { cwd, env: cleanEnv(), timeoutMs: RUN_TIMEOUT_MS });
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

const latestSchema = z.object({
  version: z.string(),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

/** latest.json: signature, then size and SHA-256 of the zip. */
async function checkLatest(latestFile: string, zip: string): Promise<void> {
  const bytes = await readFile(latestFile);
  const signature = await readFile(`${latestFile}.sig`, 'utf8');
  if (!verifyReleaseSignature(bytes, signature)) throw new SmokeError('latest.json: invalid signature');
  const latest = latestSchema.parse(JSON.parse(bytes.toString('utf8')));
  const size = (await readFile(zip)).length;
  if (size !== latest.size || (await sha256File(zip)) !== latest.sha256) {
    throw new SmokeError('the zip does not match latest.json (size or SHA-256)');
  }
  log(`latest.json ${latest.version}: signature and zip hash ok`);
}

async function unpack(zip: string, work: string): Promise<string> {
  const target = path.join(work, 'unpacked');
  await mkdir(target, { recursive: true });
  await run(systemTool('tar.exe'), ['-x', '-f', zip, '-C', target], work);
  const folders = await readdir(target);
  if (folders.length !== 1 || folders[0] === undefined)
    throw new SmokeError(`the zip must contain one folder, got ${folders.join(', ')}`);
  return path.join(target, folders[0]);
}

/** npm next to node (WP-83 §8.2, way 1): `npm pack`, then the SHA-512 against the signed integrity. */
async function addSdk(pkgDir: string, work: string, version: string, integrity: string): Promise<void> {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const dest = path.join(work, 'sdk');
  await mkdir(dest, { recursive: true });
  const output = await run(
    process.execPath,
    [npmCli, 'pack', `${AGENT_SDK_PACKAGE}@${version}`, '--pack-destination', dest, '--json'],
    work,
  );
  const [packed] = z.array(z.object({ filename: z.string() })).parse(JSON.parse(output));
  if (packed === undefined) throw new SmokeError('npm pack returned nothing');
  const tarball = path.join(dest, path.basename(packed.filename));
  const actual = `sha512-${createHash('sha512')
    .update(await readFile(tarball))
    .digest('base64')}`;
  if (actual !== integrity) throw new SmokeError(`SDK tarball: integrity ${actual} != ${integrity}`);
  const target = path.join(pkgDir, 'node_modules', ...AGENT_SDK_PACKAGE.split('/'));
  await mkdir(target, { recursive: true });
  await run(systemTool('tar.exe'), ['-x', '-z', '-f', tarball, '--strip-components=1', '-C', target], work);
  log(`Agent SDK ${version}: integrity ok, unpacked`);
}

async function main(argv: readonly string[]): Promise<void> {
  const zip = option(argv, '--zip');
  const dir = option(argv, '--dir');
  const latestFile = option(argv, '--latest');
  const workArg = option(argv, '--work');
  if (workArg === undefined || (zip === undefined) === (dir === undefined)) {
    throw new SmokeError(
      'usage: smoke.ts (--zip <zip> [--latest <latest.json>] | --dir <folder>) --work <empty dir>',
    );
  }
  const work = path.resolve(workArg);
  await mkdir(work, { recursive: true });
  if ((await readdir(work)).length > 0) throw new SmokeError(`${work} is not empty`);

  let pkgDir: string;
  if (zip !== undefined) {
    if (latestFile !== undefined) await checkLatest(latestFile, zip);
    pkgDir = await unpack(path.resolve(zip), work);
  } else {
    pkgDir = path.join(work, 'package');
    await cp(path.resolve(dir ?? ''), pkgDir, { recursive: true });
  }

  // release.json: signature (a zip from CI must carry one), Node version, every file.
  const releaseBytes = await readFile(path.join(pkgDir, RELEASE_FILE));
  const signature = await readFile(path.join(pkgDir, RELEASE_SIGNATURE_FILE), 'utf8').catch(() => null);
  if (signature === null) {
    if (zip !== undefined) throw new SmokeError('release.json.sig is missing');
    log('release.json is unsigned (local trial)');
  } else if (!verifyReleaseSignature(releaseBytes, signature)) {
    throw new SmokeError('release.json: invalid signature');
  } else {
    log('release.json: signature ok');
  }
  const release = releaseInfoSchema.parse(JSON.parse(releaseBytes.toString('utf8')));
  if ((compareVersions(process.version, release.minNode) ?? -1) < 0) {
    throw new SmokeError(`Node ${process.version} is below minNode ${release.minNode}`);
  }
  const walk = await walkPackage(pkgDir);
  const problems = comparePackageFiles(walk, await hashFiles(pkgDir, walk.files), release.files, [
    RELEASE_FILE,
    RELEASE_SIGNATURE_FILE,
  ]);
  if (problems.length > 0)
    throw new SmokeError(`package check failed:\n  ${problems.slice(0, 30).join('\n  ')}`);
  log(`${String(walk.files.length)} files match release.json (${release.version}, build ${release.buildId})`);

  await addSdk(pkgDir, work, release.sdk.version, release.sdk.integrity);

  // Start like start.mjs will (WP-86): system CA, proxy from the environment, install root as cwd.
  const home = path.join(work, 'home');
  const output = await run(
    process.execPath,
    [
      '--use-system-ca',
      '--use-env-proxy',
      path.join(pkgDir, 'dist', 'launcher.js'),
      '--install-root',
      work,
      `--home=${home}`,
      '--backend=fake',
      '--port=0',
      '--system-integration=off',
      '--print-url',
    ],
    work,
  );
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
    log(
      `server ${health.serverVersion} on ${match[1]} healthy (build ${health.buildId}, Node ${process.version})`,
    );
  } finally {
    await killProcessTree(pid);
  }
  log('ok');
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`[smoke] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
