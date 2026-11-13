/**
 * WP-66: the fake side question (`askSideQuestion`) and `withdrawQueued` of the FakeBackend. The
 * answer names the question, the follow-up number and whether a turn is running – deterministic for
 * tests. Levers: `FakeBackendOptions.sideQuestions` (tests) and keywords in the question (dev, E2E):
 * `fake:busy`, `fake:unavailable`, `fake:fail`, `fake:none`, `fake:synthetic`, `fake:fallback`,
 * `fake:retry`, `fake:slow`. A queued prompt containing `fake:taken` is "already taken over"
 * (`withdrawQueued` answers false).
 */
import type { FakeSideQuestionMode } from './types';
import type { SideQuestionAnswer, SideQuestionTurn } from '../types';

/** Time to the answer (× speed; ≤ maxDelayMs). Live: 1–2 s. */
export const FAKE_SIDE_ANSWER_MS = 600;
/** `fake:slow` / mode 'slow' (× speed, never at speed 0) – long enough to cancel. */
export const FAKE_SIDE_SLOW_MS = 30_000;
/** `fake:retry`: pause before the api_retry progress (× speed). */
export const FAKE_SIDE_RETRY_MS = 400;
/** The model of the refusal fallback (`fake:fallback`). */
export const FAKE_FALLBACK_MODEL = 'claude-sonnet-5-5';
/** Keyword of a queued prompt that `withdrawQueued` reports as already taken over. */
export const FAKE_TAKEN_KEYWORD = 'fake:taken';

const KEYWORDS: readonly [string, FakeSideQuestionMode][] = [
  ['fake:busy', 'busy'],
  ['fake:unavailable', 'unavailable'],
  ['fake:fail', 'failed'],
  ['fake:none', 'none'],
  ['fake:synthetic', 'synthetic'],
  ['fake:fallback', 'fallback'],
  ['fake:retry', 'retry'],
  ['fake:slow', 'slow'],
];

/** The lever of one question: a keyword in it wins over the backend option. */
export function fakeSideMode(question: string, option: FakeSideQuestionMode | undefined): FakeSideQuestionMode {
  for (const [keyword, mode] of KEYWORDS) if (question.includes(keyword)) return mode;
  return option ?? 'ok';
}

/** The fake answer: question, follow-up number and turn state (English, like the CLI's own language). */
export function fakeSideAnswer(
  question: string,
  history: readonly SideQuestionTurn[],
  turnRunning: boolean,
  mode: FakeSideQuestionMode,
): SideQuestionAnswer {
  if (mode === 'synthetic') {
    return { response: 'No response available for this side question.', synthetic: true, fallbackModel: null };
  }
  const state = turnRunning ? 'Claude is working on a turn' : 'Claude is idle';
  const follow = history.length === 0 ? '' : ` (follow-up ${String(history.length)})`;
  const quoted = question.length > 120 ? `${question.slice(0, 120)}…` : question;
  return {
    response: `Fake side answer${follow}: “${quoted}” – ${state}.`,
    synthetic: false,
    fallbackModel: mode === 'fallback' ? FAKE_FALLBACK_MODEL : null,
  };
}

/** `system/control_request_progress` as the CLI sends it (one `started` per side question). */
export function controlProgressMessage(
  o: { requestId: string; status: 'started' | 'api_retry'; attempt?: number; maxRetries?: number },
  ids: { uuid: string; sessionId: string },
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'control_request_progress',
    request_id: o.requestId,
    status: o.status,
    ...(o.attempt === undefined ? {} : { attempt: o.attempt }),
    ...(o.maxRetries === undefined ? {} : { max_retries: o.maxRetries, retry_delay_ms: 500, error_status: 529 }),
    uuid: ids.uuid,
    session_id: ids.sessionId,
  };
}
