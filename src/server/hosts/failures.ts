/**
 * What a failed connection to another computer means (docs/wp/WP-78a.md "API für WP-79", WP-76 §B.6,
 * §B.9). Errors carry no secrets – only reasons and errno/TLS codes.
 *
 * | `PinnedConnectionError.reason`                      | Meaning                                              |
 * | --- | --- |
 * | `network` / `timeout` / `tls` / `destroyed`        | unreachable (HOST_UNREACHABLE `refused`/`network`/`timeout`/`tls`/`closed`) |
 * | `pin` / `unauthorized` / profile violations         | another computer answers at that address → unreachable `tls`, logged as suspect |
 * | `proof_closed`                                      | the other side drops us after the handshake: unknown or revoked key – `revoked` only after a second attempt (the same close also follows a full connection table or a stopping listener) |
 * | `proof_mismatch` / `proof_excess` / `proof_transcript` | the other side has the pinned key but not the coupling secret → unreachable `tls`, logged as suspect |
 */
import { makeError, type ErrorPayload } from '@shared/errors';
import { PinnedConnectionError } from '../secure/pinnedAgent';

/** `unreachable` retries with backoff; `refused` = the other side refused our key (revoked after confirmation). */
export type FailureKind = 'unreachable' | 'refused';

export interface ConnectionFailure {
  kind: FailureKind;
  error: ErrorPayload;
  /** The peer proved to be something else than the coupled computer (log at `warn`). */
  suspect: boolean;
}

/** HOST_UNREACHABLE reasons by errno (anything else is `network`). */
function networkReason(code: string | null): string {
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEDOUT') return 'timeout';
  return 'network';
}

function unreachable(reason: string, suspect = false): ConnectionFailure {
  return { kind: 'unreachable', error: makeError('HOST_UNREACHABLE', { reason }), suspect };
}

/** Errors of `ws` that are not socket errors (handshake timeout, protocol errors of the upgrade). */
function wsReason(error: Error): string {
  return /timed out/iu.test(error.message) ? 'timeout' : 'closed';
}

/** Classifies an error of a connection attempt (PinnedAgent, `https.request`, `ws`). Never throws. */
export function connectionFailure(error: unknown): ConnectionFailure {
  if (error instanceof PinnedConnectionError) {
    switch (error.reason) {
      case 'network':
        return unreachable(networkReason(error.code));
      case 'timeout':
      case 'proof_timeout':
        return unreachable('timeout');
      case 'tls':
        return unreachable('tls');
      case 'destroyed':
        return unreachable('closed');
      case 'proof_closed':
        return { kind: 'refused', error: makeError('HOST_REVOKED'), suspect: false };
      default:
        // pin, unauthorized, profile violations, proof_mismatch/excess/transcript
        return unreachable('tls', true);
    }
  }
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
    if (code !== null && /^E[A-Z]+$/u.test(code)) return unreachable(networkReason(code));
    return unreachable(wsReason(error));
  }
  return unreachable('network');
}
