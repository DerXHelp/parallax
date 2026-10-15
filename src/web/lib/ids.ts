import type { ClientId, CmdId } from '@shared/common';

/** 32 lower-case hex chars from 16 random bytes (crypto.getRandomValues). */
function randomHex32(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** New window id `cl_<32 hex>` (`clientIdSchema`); kept per window in sessionStorage (state/client-id.ts). */
export function newClientId(): ClientId {
  return `cl_${randomHex32()}`;
}

/** New idempotency key of a command (`cmdIdSchema`, UUID v4). */
export function newCmdId(): CmdId {
  return crypto.randomUUID();
}
