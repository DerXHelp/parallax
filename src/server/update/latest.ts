/**
 * The update check (WP-87 §2.1 "Prüfen", §1.6, docs/wp/WP-83.md §7, §9.1): `latest.json` of the
 * latest full release and its signature, checked with the keys of the RUNNING version before
 * anything of it is trusted; then the downgrade guard (only versions above the running one, no
 * pre-release) and the signed `CHANGELOG.md` of that release for "What's new".
 *
 * `latest.json` is written by `scripts/release/sign.ts` (`writeLatest`); `latestInfoSchema` follows
 * it and is the one schema for it (the release smoke test reads it from here, WP-89). New fields
 * only with a default (older readers strip unknown keys).
 *
 * GitHub serves `releases/latest/download/…` only for full releases: a 404 means "no update", not a
 * failure (WP-87 §0.3 point 11).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isoDateTimeSchema } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import { UPDATE_PACKAGE_MAX_BYTES } from '@shared/http';
import { appVersionSchema } from '@shared/model';
import { compareVersions } from '@shared/version';
import { verifyReleaseSignature } from '../launcher/release';
import { CommandError } from '../sync/ports';
import type { UpdateEndpoints } from './endpoints';
import { FetchError, fetchBytes, safeUrl, type UpdateFetchOptions } from './fetch';

export const LATEST_MAX_BYTES = 256 * 1024;
export const LATEST_SIGNATURE_MAX_BYTES = 1024;
/** The `CHANGELOG.md` asset of a release (kept in memory). */
export const CHANGELOG_ASSET_MAX_BYTES = 2 * 1024 * 1024;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);

/** `latest.json` (scripts/release/sign.ts `writeLatest`). */
export const latestInfoSchema = z.object({
  schemaVersion: z.literal(1),
  version: appVersionSchema,
  prerelease: z.boolean(),
  /** Must be exactly `assetUrl(version)` of the endpoints. */
  url: z.string().min(1).max(2048),
  /** Zip bytes. */
  size: z.number().int().positive().max(UPDATE_PACKAGE_MAX_BYTES),
  sha256: sha256Hex,
  changelogSha256: sha256Hex,
  /** The release's own section of CHANGELOG.md (fallback for "What's new"). */
  notes: z.string().max(200_000),
  createdAt: isoDateTimeSchema,
});
export type LatestInfo = z.infer<typeof latestInfoSchema>;

export type LatestCheck =
  /** `not_found` = 404 (no full release yet), `prerelease`, `not_newer` (downgrade guard). */
  | { kind: 'none'; reason: 'not_found' | 'prerelease' | 'not_newer' }
  /** `changelog` = the signed CHANGELOG.md of that release, null when it failed (then `notes`). */
  | { kind: 'available'; latest: LatestInfo; changelog: string | null };

export interface CheckLatestOptions extends UpdateFetchOptions {
  endpoints: Pick<
    UpdateEndpoints,
    'latestUrl' | 'latestSignatureUrl' | 'assetUrl' | 'changelogUrl' | 'releaseKeys'
  >;
  /** The running version (downgrade guard). */
  running: string;
  /** Notes for the server log (English). */
  log?: (message: string) => void;
}

/** UPDATE_CHECK_FAILED for a failed request (`reason` network, timeout, http + status, too_large, url). */
export function checkFailedPayload(error: unknown): ErrorPayload {
  if (!(error instanceof FetchError)) return makeError('UPDATE_CHECK_FAILED', { reason: 'network' });
  switch (error.reason) {
    case 'http':
      return makeError('UPDATE_CHECK_FAILED', { reason: 'http', status: error.status });
    case 'timeout':
    case 'too_large':
    case 'url':
      return makeError('UPDATE_CHECK_FAILED', { reason: error.reason });
    case 'network':
    case 'disk':
    case 'aborted':
      return makeError('UPDATE_CHECK_FAILED', { reason: 'network' });
  }
}

const invalidSignature = (): CommandError =>
  new CommandError(makeError('UPDATE_INVALID_SIGNATURE', { file: 'latest.json' }));

function isNotFound(error: unknown): boolean {
  return error instanceof FetchError && error.reason === 'http' && error.status === 404;
}

/** The signed CHANGELOG.md of `latest` (SHA-256 against `changelogSha256`), or null. */
async function fetchChangelog(latest: LatestInfo, options: CheckLatestOptions): Promise<string | null> {
  const url = options.endpoints.changelogUrl(latest.version);
  try {
    const bytes = await fetchBytes(url, {
      ...options,
      maxBytes: CHANGELOG_ASSET_MAX_BYTES,
      accept: 'text/markdown, text/plain, */*',
    });
    if (createHash('sha256').update(bytes).digest('hex') !== latest.changelogSha256) {
      options.log?.(
        `${safeUrl(url)} does not match changelogSha256 of latest.json - only its notes are shown`,
      );
      return null;
    }
    return bytes.toString('utf8');
  } catch (error) {
    options.log?.(
      `${safeUrl(url)} could not be loaded (${error instanceof Error ? error.message : 'error'})`,
    );
    return null;
  }
}

/**
 * Looks for a newer full release. Throws `CommandError`: UPDATE_CHECK_FAILED (network, timeout,
 * http, too_large, schema, url) or UPDATE_INVALID_SIGNATURE (`latest.json`: signature missing or
 * not by one of the release keys).
 */
export async function checkLatest(options: CheckLatestOptions): Promise<LatestCheck> {
  const { endpoints } = options;
  let bytes: Buffer;
  try {
    bytes = await fetchBytes(endpoints.latestUrl, {
      ...options,
      maxBytes: LATEST_MAX_BYTES,
      accept: 'application/json',
    });
  } catch (error) {
    if (isNotFound(error)) return { kind: 'none', reason: 'not_found' };
    throw new CommandError(checkFailedPayload(error));
  }
  let signature: string;
  try {
    signature = (
      await fetchBytes(endpoints.latestSignatureUrl, { ...options, maxBytes: LATEST_SIGNATURE_MAX_BYTES })
    ).toString('utf8');
  } catch (error) {
    if (isNotFound(error) || (error instanceof FetchError && error.reason === 'too_large')) {
      throw invalidSignature();
    }
    throw new CommandError(checkFailedPayload(error));
  }
  if (!verifyReleaseSignature(bytes, signature, endpoints.releaseKeys)) throw invalidSignature();

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new CommandError(makeError('UPDATE_CHECK_FAILED', { reason: 'schema' }));
  }
  const parsed = latestInfoSchema.safeParse(raw);
  if (!parsed.success) throw new CommandError(makeError('UPDATE_CHECK_FAILED', { reason: 'schema' }));
  const latest = parsed.data;
  if (latest.url !== endpoints.assetUrl(latest.version)) {
    throw new CommandError(makeError('UPDATE_CHECK_FAILED', { reason: 'url' }));
  }
  // Defensive: GitHub `latest` never names a pre-release, a signed old one must not either.
  if (latest.prerelease || latest.version.includes('-')) return { kind: 'none', reason: 'prerelease' };
  const order = compareVersions(latest.version, options.running);
  if (order === null || order <= 0) return { kind: 'none', reason: 'not_newer' };
  return { kind: 'available', latest, changelog: await fetchChangelog(latest, options) };
}
