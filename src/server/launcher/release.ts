/**
 * `release.json` of a release package (WP-85, docs/wp/WP-83.md §5): written unsigned by
 * `scripts/release-pack.ts`, signed in CI (`release.json.sig`, Ed25519 over the exact bytes).
 *
 * Its presence next to `dist/` switches the launcher into package mode: no build check against git
 * or `repo.config.ts`, the expected build id comes from here. The signature and the file hashes are
 * checked by the installer (WP-86) with the code of the installed version, never by the launcher.
 *
 * New fields need a default or a new `schemaVersion` (the bytes are signed; older readers strip
 * unknown keys).
 */
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { toError } from '../lib/async';
import { fsErrorCode } from '../lib/paths';

export const RELEASE_FILE = 'release.json';
export const RELEASE_SIGNATURE_FILE = 'release.json.sig';
export const RELEASE_SCHEMA_VERSION = 1;
export const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * Node flags of every process of an installation (WP-86, docs/wp/WP-83.md §8.2): certificates from
 * the Windows store (company TLS inspection) and the proxy from the environment. Node >= 24.5.
 */
export const PACKAGE_NODE_FLAGS: readonly string[] = ['--use-system-ca', '--use-env-proxy'];

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
/** A release version: `X.Y.Z` or a release candidate `X.Y.Z-rc.N` (tag `v<version>`). */
export const releaseVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u);
const semver = releaseVersionSchema;

export const releaseInfoSchema = z.object({
  schemaVersion: z.literal(RELEASE_SCHEMA_VERSION),
  name: z.literal('parallax'),
  version: semver,
  /** Full commit hash of the tag. */
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  /** Same id as the banner of dist/server.js and dist/web/build.json. */
  buildId: z.string().min(1).max(200),
  /** Lowest Node version (`engines.node` without `>=`), checked with minor and patch. */
  minNode: z.string().regex(/^\d+\.\d+\.\d+$/u),
  createdAt: z.iso.datetime(),
  /** Store id (`settings.json`, `entries/*\/decisions.json`, …) → hash of its JSON schema (§9.4). */
  schemas: z.record(z.string().min(1), sha256Hex),
  /** Not in the package (proprietary): fetched from the registry and checked against `integrity`. */
  sdk: z.object({
    name: z.literal(AGENT_SDK_PACKAGE),
    version: semver,
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/u),
  }),
  /** Every file of the package except release.json(.sig), `/`-separated → SHA-256. */
  files: z.record(z.string().min(1), sha256Hex),
});
export type ReleaseInfo = z.infer<typeof releaseInfoSchema>;

/**
 * Public release keys (Ed25519; JWK `x` = base64url of the raw 32 bytes). Created once by the user
 * with `scripts/release-key.ts`; the private key is a CI secret and never enters a Claude session
 * (WP-83 §7). A successor key is added here before the old one is retired.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  // Key 1, created 17.11.2026. SHA-256 of the raw key:
  // 51c9335f 62940cc6 354c975a 82549be6 3dafd87f 9c6ec763 1069ff8c 9312b39e
  'NH6dcmQHBqP2H2pTBjzY3Kd4ZFeljx_mTB8LGuiyNpQ',
];

const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/u;

/**
 * Ed25519 signature (base64, as in `release.json.sig`/`latest.json.sig`) of the exact bytes `data`
 * by one of `keys`. False for a malformed signature or key.
 */
export function verifyReleaseSignature(
  data: Uint8Array,
  signature: string,
  keys: readonly string[] = RELEASE_PUBLIC_KEYS,
): boolean {
  const text = signature.trim();
  if (!SIGNATURE_BASE64.test(text)) return false;
  const bytes = Buffer.from(text, 'base64');
  return keys.some((x) => {
    try {
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
      return verify(null, data, key, bytes);
    } catch {
      return false;
    }
  });
}

export class ReleaseInfoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReleaseInfoError';
  }
}

/** `<root>/release.json`, or null without one (checkout); a broken file throws `ReleaseInfoError`. */
export async function readReleaseInfo(root: string): Promise<ReleaseInfo | null> {
  const file = path.join(root, RELEASE_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return null;
    throw new ReleaseInfoError(`${file} could not be read: ${toError(error).message}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ReleaseInfoError(`${file} is not valid JSON`, { cause: error });
  }
  const parsed = releaseInfoSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReleaseInfoError(`${file} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
