/**
 * Where updates come from (WP-87 §1.7): GitHub release downloads (no API limit, WP-83 §9.1) and the
 * release keys of this build. Only a test build (esbuild `define __PARALLAX_UPDATE_TEST__: 'true'`,
 * scripts/build-server.ts `--update-test`) reads a local release server, test keys and a registry
 * from the environment – `isTestRun` is not enough, any environment could set it (WP-83 §12).
 */
import { z } from 'zod';
import { RELEASE_PUBLIC_KEYS } from '../launcher/release';

declare const __PARALLAX_UPDATE_TEST__: boolean | undefined;

export const RELEASES_URL = 'https://github.com/DerXHelp/parallax/releases';
export const LATEST_FILE = 'latest.json';
export const CHANGELOG_ASSET = 'CHANGELOG.md';

/** Asset name of a release zip (scripts/release/sign.ts `writeLatest`). */
export function releaseZipName(version: string): string {
  return `parallax-${version}-win.zip`;
}

export interface UpdateEndpoints {
  /** `<base>/latest/download/latest.json` – GitHub serves only full releases there (404 otherwise). */
  latestUrl: string;
  latestSignatureUrl: string;
  assetUrl: (version: string) => string;
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

function endpointsFor(
  base: string,
): Pick<UpdateEndpoints, 'latestUrl' | 'latestSignatureUrl' | 'assetUrl' | 'changelogUrl'> {
  const root = base.replace(/\/+$/u, '');
  return {
    latestUrl: `${root}/latest/download/${LATEST_FILE}`,
    latestSignatureUrl: `${root}/latest/download/${LATEST_FILE}.sig`,
    assetUrl: (version) => `${root}/download/v${version}/${releaseZipName(version)}`,
    changelogUrl: (version) => `${root}/download/v${version}/${CHANGELOG_ASSET}`,
  };
}

/**
 * The endpoints of this build. In a test build an invalid test variable throws (a broken E2E setup
 * must not silently fall back to GitHub).
 */
export function updateEndpoints(
  env: NodeJS.ProcessEnv = process.env,
  testBuild: boolean = isUpdateTestBuild(),
): UpdateEndpoints {
  if (!testBuild) {
    return {
      ...endpointsFor(RELEASES_URL),
      releaseKeys: RELEASE_PUBLIC_KEYS,
      registry: undefined,
      allowLoopbackHttp: false,
    };
  }
  const test = testEnvSchema.parse({
    PARALLAX_TEST_UPDATE_BASE: env.PARALLAX_TEST_UPDATE_BASE,
    PARALLAX_TEST_RELEASE_KEYS: env.PARALLAX_TEST_RELEASE_KEYS,
    PARALLAX_TEST_REGISTRY: env.PARALLAX_TEST_REGISTRY,
  });
  return {
    ...endpointsFor(test.PARALLAX_TEST_UPDATE_BASE ?? RELEASES_URL),
    releaseKeys: test.PARALLAX_TEST_RELEASE_KEYS?.split(',') ?? RELEASE_PUBLIC_KEYS,
    registry: test.PARALLAX_TEST_REGISTRY,
    allowLoopbackHttp: true,
  };
}
