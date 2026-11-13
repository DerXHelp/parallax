/**
 * Step 2d of `pnpm cli-check` (WP-66 §1.4): side questions and withdrawing a queued prompt in the
 * probe session – after the overview step:
 * - `askSideQuestion(SIDE_QUESTION_PROBE)`: one small model request (a fork of the probe
 *   conversation, no tools, nothing written to it; Haiku, a fraction of a cent – no `result` message,
 *   so its cost is not in the probe's `total_cost_usd`). The answer must have the shape Parallax
 *   reads (`response` string, `synthetic` boolean; `backend/sideQuestion.ts`), and no `canUseTool`
 *   call may happen while it runs (a side question never uses tools);
 * - `cancelAsyncMessage`: only whether the method exists – never called (the probe queues nothing).
 * The results go into the profile (`sideQuestion`, `withdrawQueued`, observation.ts); a change
 * against the profile is a finding (compare.ts). A failure here never stops the check.
 */
import { z } from 'zod';
import { sideAnswerOf, sideQuestionFailure } from '../../src/server/backend/sideQuestion';
import { withTimeout } from '../../src/server/backend/sdkBackend';

/** The probe's side question (German like the WP; the expected answer is one word). */
export const SIDE_QUESTION_PROBE = 'Antworte nur mit: OK';

/** The probe's Query: the two internal methods (checked at runtime). */
export interface SideQuestionProbeHandle {
  askSideQuestion?(
    question: string,
    opts?: { history?: { question: string; response: string }[]; signal?: AbortSignal },
  ): Promise<unknown>;
  cancelAsyncMessage?(messageUuid: string): Promise<unknown>;
}

/** The shape the probe expects (stricter than the server's tolerant parser: `synthetic` must be there). */
const probeAnswerSchema = z.looseObject({ response: z.string(), synthetic: z.boolean() });

export const sideQuestionProbeResultSchema = z.object({
  sideQuestion: z.object({
    available: z.boolean(),
    /** Why not (English, for the report); null when available. */
    detail: z.string().nullable(),
    /** The answer (first 200 characters, for the report; the probe question holds no user data). */
    response: z.string().nullable(),
    synthetic: z.boolean().nullable(),
    /** canUseTool calls while the side question ran (must be 0). */
    toolRequests: z.number().int().nonnegative(),
  }),
  withdrawQueued: z.boolean(),
});
export type SideQuestionProbeResult = z.infer<typeof sideQuestionProbeResultSchema>;

export interface SideQuestionProbeOptions {
  /** Time limit of the side question (live 1–2 s). */
  timeoutMs: number;
  /** canUseTool calls of the probe session so far (the probe counts them). */
  toolRequests: () => number;
  log?: (line: string) => void;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

type SideCheck = SideQuestionProbeResult['sideQuestion'];

function notAvailable(detail: string, toolRequests = 0): SideCheck {
  return { available: false, detail, response: null, synthetic: null, toolRequests };
}

async function probeAsk(handle: SideQuestionProbeHandle, o: SideQuestionProbeOptions): Promise<SideCheck> {
  if (typeof handle.askSideQuestion !== 'function') return notAvailable('Query.askSideQuestion is missing (SDK)');
  const before = o.toolRequests();
  const abort = new AbortController();
  let raw: unknown;
  try {
    raw = await withTimeout(
      handle.askSideQuestion(SIDE_QUESTION_PROBE, { signal: abort.signal }),
      o.timeoutMs,
      'askSideQuestion',
    );
  } catch (error) {
    // A timeout leaves the CLI request open: cancel it (control_cancel_request).
    abort.abort();
    const busy = sideQuestionFailure(error, false) === 'busy' ? ' (side_question_busy)' : '';
    return notAvailable(`askSideQuestion failed${busy}: ${message(error)}`, o.toolRequests() - before);
  }
  const toolRequests = o.toolRequests() - before;
  if (raw === null) return notAvailable('askSideQuestion answered null (no conversation state)', toolRequests);
  const strict = probeAnswerSchema.safeParse(raw);
  const answer = sideAnswerOf(raw);
  if (!strict.success || answer === null || answer === 'invalid') {
    return notAvailable('the answer of askSideQuestion is not {response: string, synthetic: boolean}', toolRequests);
  }
  const check: SideCheck = {
    available: true,
    detail: null,
    response: answer.response.slice(0, 200),
    synthetic: answer.synthetic,
    toolRequests,
  };
  if (toolRequests > 0) {
    return { ...check, available: false, detail: `canUseTool was called ${String(toolRequests)}× during the side question` };
  }
  if (answer.synthetic) return { ...check, available: false, detail: 'the CLI answered synthetically (no model answer)' };
  return check;
}

/** Runs step 2d against the probe's Query (pure apart from the handle; tested with a fake handle). */
export async function probeSideQuestion(
  handle: SideQuestionProbeHandle,
  o: SideQuestionProbeOptions,
): Promise<SideQuestionProbeResult> {
  const log = o.log ?? (() => undefined);
  const sideQuestion = await probeAsk(handle, o);
  const withdrawQueued = typeof handle.cancelAsyncMessage === 'function';
  log(
    `cli-check: side question ${sideQuestion.available ? `ok ("${sideQuestion.response ?? ''}")` : `NOT ok (${sideQuestion.detail ?? '?'})`}, ` +
      `cancelAsyncMessage ${withdrawQueued ? 'present' : 'MISSING'}`,
  );
  return { sideQuestion, withdrawQueued };
}
