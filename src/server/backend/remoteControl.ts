/**
 * WP-64 (Remote Control): the SDK boundary of `query.enableRemoteControl` and
 * `getSettings().effective.remoteControlAtStartup` (both internal in SDK 0.3.322, docs/wp/WP-64.md
 * §1.1). Pure helpers: tolerant parsing of the answers (zod) and mapping of control errors to the
 * four REMOTE_CONTROL_* codes. Used by SdkBackend and the cli-check probe.
 */
import { z } from 'zod';
import { makeError, type ErrorPayload } from '@shared/errors';
import { isClaudeSessionUrl } from '@shared/model';
import { toError } from '../lib/async';
import type { RemoteControlInfo, RemoteControlResult } from './types';

const DETAIL_CHARS = 300;

/** Answer of the `remote_control` control request (enabled = true); extra keys are ignored. */
export const remoteControlAnswerSchema = z.looseObject({
  bridge_session_id: z.string().min(1).max(200),
  session_url: z.string().max(2000).optional(),
  connect_url: z.string().max(2000).optional(),
  environment_id: z.string().max(200).optional(),
  bridge_epoch: z.number().optional(),
});

const settingsAnswerSchema = z.looseObject({
  effective: z.looseObject({ remoteControlAtStartup: z.unknown().optional() }).optional(),
});

/** Turns the raw answer of `enableRemoteControl(true)` into the port result. */
export function toRemoteControlInfo(raw: unknown): RemoteControlResult {
  const parsed = remoteControlAnswerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: makeError('REMOTE_CONTROL_UNAVAILABLE', { reason: 'answer' }) };
  const url = parsed.data.session_url;
  const info: RemoteControlInfo = {
    bridgeSessionId: parsed.data.bridge_session_id,
    sessionUrl: url !== undefined && isClaudeSessionUrl(url) ? url : null,
  };
  return { ok: true, info };
}

/** `getSettings()` answer → Claude's own `remoteControlAtStartup`; null when absent or not a boolean. */
export function remoteControlDefaultOf(raw: unknown): boolean | null {
  const parsed = settingsAnswerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data.effective?.remoteControlAtStartup;
  return typeof value === 'boolean' ? value : null;
}

const errorShape = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  errorCode: z.string().optional(),
});

/** A CLI without the `remote_control` subtype answers with an "unsupported/unknown subtype" error. */
const UNSUPPORTED_SUBTYPE = /\b(?:unsupported|unknown)\b.*\b(?:subtype|control request)\b/i;

function clip(text: string): string {
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text;
}

/**
 * Control error → code. The SDK puts the CLI's `error_code` on the rejected Error (`errorCode`,
 * e.g. `remote_control_auth`, `remote_control_policy_disabled`, `remote_control_terminal`).
 */
export function remoteControlErrorOf(error: unknown): ErrorPayload {
  const parsed = errorShape.safeParse(error);
  const shape = parsed.success ? parsed.data : {};
  const message = clip(shape.message ?? toError(error).message);
  switch (shape.errorCode) {
    case 'remote_control_auth':
      return makeError('REMOTE_CONTROL_AUTH', {}, message);
    case 'remote_control_policy_disabled':
      return makeError('REMOTE_CONTROL_POLICY_DISABLED', {}, message);
    case undefined:
      break;
    default:
      return makeError('REMOTE_CONTROL_FAILED', { reason: shape.errorCode, detail: message }, message);
  }
  if (shape.name === 'TimeoutError') return makeError('REMOTE_CONTROL_FAILED', { reason: 'timeout' }, message);
  if (UNSUPPORTED_SUBTYPE.test(message)) {
    return makeError('REMOTE_CONTROL_UNAVAILABLE', { reason: 'cli' }, message);
  }
  return makeError('REMOTE_CONTROL_FAILED', { reason: 'control', detail: message }, message);
}
