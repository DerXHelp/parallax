import { randomBytes, randomUUID } from 'node:crypto';
import { AUTH_TOKEN_BYTES } from '@shared/http';

/**
 * Server-side id generation (docs/wp/WP-02.md §2.2). Formats are defined by the zod schemas in
 * src/shared/common.ts (`<prefix>_` + 32 lower-case hex); the web has its own helper.
 */
export type ServerIdPrefix = 'en' | 'cv' | 'dc' | 'pf';

/** `en_…` entry, `cv_…` conversation, `dc_…` decision, `pf_…` profile (16 random bytes as hex). */
export function newId<P extends ServerIdPrefix>(prefix: P): `${P}_${string}` {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

/** Random UUID v4 (server instance id, prompt `messageUuid`). */
export function newUuid(): string {
  return randomUUID();
}

/** One-time auth code / launcher token / secret: 32 random bytes as base64url without padding (43 chars). */
export function newToken(): string {
  return randomBytes(AUTH_TOKEN_BYTES).toString('base64url');
}
