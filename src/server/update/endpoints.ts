/**
 * Where updates come from (WP-87 §1.7): GitHub release downloads (no API limit, WP-83 §9.1) and the
 * release keys of this build. Only a test build (esbuild `define __PARALLAX_UPDATE_TEST__: 'true'`,
 * scripts/build-server.ts `--update-test`) reads a local release server, test keys and a registry
 * from the environment – `isTestRun` is not enough, any environment could set it (WP-83 §12).
 * The test branch hangs directly on the define, so esbuild drops it – and every `PARALLAX_TEST_*`
 * name – from a normal bundle (src/server/app/bundle.test.ts). Keep test-only code inside
 * `testEndpoints`; a function call like `isUpdateTestBuild()` is not folded away.
 *
 * Per platform (WP-108): every release carries one asset per target – `parallax-<v>-win.zip` and
 * `parallax-<v>-linux-x64.tar.gz` (same build, other start scripts and archive format). The
 * endpoints know the target of this host (`target`); `assetUrl(version)` names its asset.
 */
import { z } from 'zod';
import { RELEASE_PUBLIC_KEYS } from '../launcher/release';

declare const __PARALLAX_UPDATE_TEST__: boolean | undefined;

export const RELEASES_URL = 'https://github.com/DerXHelp/parallax/releases';
export const LATEST_FILE = 'latest.json';
export const CHANGELOG_ASSET = 'CHANGELOG.md';

/** The release asset of a platform (WP-108). */
export type ReleaseTarget = 'win' | 'linux-x64';
export const RELEASE_TARGETS: readonly ReleaseTarget[] = ['win', 'linux-x64'];
/** Archive format of an asset: zip (bsdtar) on Windows, tar.gz (GNU tar) on Linux. */
export type ArchiveFormat = 'zip' | 'tar.gz';

/**
 * The asset this host installs: `win` on Windows (any architecture: the package is plain
 * JavaScript), `linux-x64` on Linux x64; null elsewhere (no asset: the check offers nothing).
 */
export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseTarget | null {
  if (platform === 'win32') return 'win';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  return null;
}

export function archiveFormatOf(target: ReleaseTarget): ArchiveFormat {
  return target === 'win' ? 'zip' : 'tar.gz';
}

/** Asset name of a release (scripts/release/sign.ts `writeLatest`). */
export function releaseAssetName(version: string, target: ReleaseTarget = 'win'): string {
  return `parallax-${version}-${target}.${archiveFormatOf(target)}`;
}

/** Asset name of the Windows release zip. */
export function releaseZipName(version: string): string {
  return releaseAssetName(version, 'win');
}

export interface UpdateEndpoints {
  /** `<base>/latest/download/latest.json` – GitHub serves only full releases there (404 otherwise). */
  latestUrl: string;
  latestSignatureUrl: string;
  /** The asset of this host (`target`; null → the Windows zip), or of the given target. */
  assetUrl: (version: string, target?: ReleaseTarget) => string;
  /** The asset this host installs (`releaseTarget()`); null = none for this platform. */
  target: ReleaseTarget | null;
  changelogUrl: (version: string) => string;
  releaseKeys: readonly string[];
  /** npm registry for the Agent SDK; undefined = npm configuration (install/sdk.ts). */
  registry: string | undefined;
  /** `http://127.0.0.1` / `localhost` allowed (test build only); else every hop must be https. */
  allowLoopbackHttp: boolean;
}

/** True only in a bundle built with `--update-test`; tsx/Vitest without define: false. */
export function isUpdateTestBuild(): boolean {
  return typeof __PARALLAX_UPDATE_TEST__ === 'boolean' && __PARALLAX_UPDATE_TEST__;
}

function endpointsFor(
  base: string,
  target: ReleaseTarget | null,
): Pick<UpdateEndpoints, 'latestUrl' | 'latestSignatureUrl' | 'assetUrl' | 'changelogUrl' | 'target'> {
  const root = base.replace(/\/+$/u, '');
  return {
    latestUrl: `${root}/latest/download/${LATEST_FILE}`,
    latestSignatureUrl: `${root}/latest/download/${LATEST_FILE}.sig`,
    assetUrl: (version, asset) =>
      `${root}/download/v${version}/${releaseAssetName(version, asset ?? target ?? 'win')}`,
    changelogUrl: (version) => `${root}/download/v${version}/${CHANGELOG_ASSET}`,
    target,
  };
}

/** The endpoints of this build: GitHub and the release keys – in a test build `testEndpoints`. */
export function updateEndpoints(
  env: NodeJS.ProcessEnv = process.env,
  target: ReleaseTarget | null = releaseTarget(),
): UpdateEndpoints {
  // Literal define check (not isUpdateTestBuild()): esbuild removes this branch from normal bundles.
  if (typeof __PARALLAX_UPDATE_TEST__ === 'boolean' && __PARALLAX_UPDATE_TEST__) {
    return testEndpoints(env, target);
  }
  return {
    ...endpointsFor(RELEASES_URL, target),
    releaseKeys: RELEASE_PUBLIC_KEYS,
    registry: undefined,
    allowLoopbackHttp: false,
  };
}

/**
 * Test build only (exported for its unit tests): a local release server, test keys and a registry
 * from the environment. An invalid variable throws – a broken E2E setup must not silently fall back
 * to GitHub. The schema is built here, not at module level, so a normal bundle keeps none of it.
 */
export function testEndpoints(
  env: NodeJS.ProcessEnv,
  target: ReleaseTarget | null = releaseTarget(),
): UpdateEndpoints {
  const loopbackUrl = z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  }, 'only http://127.0.0.1 or http://localhost');
  const testEnvSchema = z.object({
    PARALLAX_TEST_UPDATE_BASE: loopbackUrl.optional(),
    PARALLAX_TEST_RELEASE_KEYS: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}(?:,[A-Za-z0-9_-]{43})*$/u)
      .optional(),
    PARALLAX_TEST_REGISTRY: loopbackUrl.optional(),
  });
  const test = testEnvSchema.parse({
    PARALLAX_TEST_UPDATE_BASE: env.PARALLAX_TEST_UPDATE_BASE,
    PARALLAX_TEST_RELEASE_KEYS: env.PARALLAX_TEST_RELEASE_KEYS,
    PARALLAX_TEST_REGISTRY: env.PARALLAX_TEST_REGISTRY,
  });
  return {
    ...endpointsFor(test.PARALLAX_TEST_UPDATE_BASE ?? RELEASES_URL, target),
    releaseKeys: test.PARALLAX_TEST_RELEASE_KEYS?.split(',') ?? RELEASE_PUBLIC_KEYS,
    registry: test.PARALLAX_TEST_REGISTRY,
    allowLoopbackHttp: true,
  };
}
