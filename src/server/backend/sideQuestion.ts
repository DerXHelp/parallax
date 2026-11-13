/**
 * WP-66: the SDK boundary of `query.askSideQuestion` and `query.cancelAsyncMessage` (both internal in
 * SDK 0.3.322, not in the typings). Pure helpers: tolerant parsing of the side-question answer (zod),
 * the failure classification and `system/control_request_progress`. Used by SdkBackend, the
 * FakeBackend and the cli-check probe.
 */
import { z } from 'zod';
import type { SideQuestionAnswer } from './types';

/** Longest answer taken over (the CLI answers a few sentences; a runaway answer is cut). */
export const SIDE_ANSWER_CHARS = 200_000;
const MODEL_CHARS = 200;

/**
 * `askSideQuestion` answers `{response, synthetic, refusalFallback?}` (the SDK maps the CLI's
 * snake_case) or null (no answer possible, e.g. no conversation yet).
 */
export const sideAnswerSchema = z
  .looseObject({
    response: z.string(),
    synthetic: z.boolean().optional(),
    refusalFallback: z
      .looseObject({ fallbackModel: z.string().optional(), originalModel: z.string().optional() })
      .nullish()
      .catch(null),
  })
  .nullable();

/**
 * The answer as Parallax keeps it; `null` = the CLI had no answer; `'invalid'` = an unknown shape
 * (treated like a missing method: the CLI cannot do side questions the way Parallax expects).
 */
export function sideAnswerOf(raw: unknown): SideQuestionAnswer | null | 'invalid' {
  const parsed = sideAnswerSchema.safeParse(raw);
  if (!parsed.success) return 'invalid';
  if (parsed.data === null) return null;
  const fallback = parsed.data.refusalFallback?.fallbackModel?.trim() ?? '';
  return {
    response: parsed.data.response.slice(0, SIDE_ANSWER_CHARS),
    synthetic: parsed.data.synthetic ?? false,
    fallbackModel: fallback === '' ? null : fallback.slice(0, MODEL_CHARS),
  };
}

/** Error code of the CLI when it already runs as many side questions/title requests as it may. */
export const SIDE_QUESTION_BUSY = 'side_question_busy';

const errorShapeSchema = z.looseObject({
  errorCode: z.unknown().optional(),
  code: z.unknown().optional(),
  message: z.unknown().optional(),
});

/**
 * A rejected side question: the SDK copies the CLI's `error_code` onto the Error (`errorCode`); an
 * older SDK may only carry it in the message. `aborted` = our own signal fired (Parallax cancelled).
 */
export function sideQuestionFailure(error: unknown, aborted: boolean): 'busy' | 'cancelled' | 'failed' {
  if (aborted) return 'cancelled';
  const parsed = errorShapeSchema.safeParse(error);
  if (!parsed.success) return 'failed';
  const { errorCode, code, message } = parsed.data;
  if (errorCode === SIDE_QUESTION_BUSY || code === SIDE_QUESTION_BUSY) return 'busy';
  if (typeof message === 'string' && message.includes(SIDE_QUESTION_BUSY)) return 'busy';
  return 'failed';
}

/** `system/control_request_progress` (untyped): progress of a control request (side question, title). */
export const controlProgressSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('control_request_progress'),
  status: z.string(),
  attempt: z.number().int().nonnegative().optional(),
  max_retries: z.number().int().nonnegative().optional(),
});

/** An `api_retry` progress message → its attempt counter; anything else → null. */
export function controlRetryOf(raw: unknown): { attempt: number; maxRetries: number } | null {
  const parsed = controlProgressSchema.safeParse(raw);
  if (!parsed.success || parsed.data.status !== 'api_retry') return null;
  return { attempt: parsed.data.attempt ?? 0, maxRetries: parsed.data.max_retries ?? 0 };
}

const withdrawnSchema = z.union([z.boolean(), z.looseObject({ cancelled: z.boolean() })]);

/**
 * `cancelAsyncMessage` answers the CLI's `cancelled` flag (SDK 0.3.322 unwraps `response.cancelled`;
 * the wrapped object is taken too). Anything else = not withdrawn.
 */
export function withdrawnOf(raw: unknown): boolean {
  const parsed = withdrawnSchema.safeParse(raw);
  if (!parsed.success) return false;
  return typeof parsed.data === 'boolean' ? parsed.data : parsed.data.cancelled;
}
