import { getHashParam, setHashParam } from '@web/lib/hash';

/**
 * Playground route: `#playground` (overview) or `#playground=<demoId>` (deep link for screenshots),
 * dev server only (`import.meta.env.DEV`). Kept tiny: main.tsx imports it in every build.
 */
export const PLAYGROUND_HASH_PARAM = 'playground';

export function isPlaygroundHash(hash: string): boolean {
  return getHashParam(hash, PLAYGROUND_HASH_PARAM) !== undefined;
}

/** Selected demo id, or null for the overview. */
export function demoIdFromHash(hash: string): string | null {
  const value = getHashParam(hash, PLAYGROUND_HASH_PARAM);
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Hash for a demo; the session selection of shell demos is dropped. */
export function hashForDemo(hash: string, demoId: string | null): string {
  return setHashParam(setHashParam(hash, 'session', undefined), PLAYGROUND_HASH_PARAM, demoId);
}
