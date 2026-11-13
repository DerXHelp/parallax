import { describe, expect, it } from 'vitest';
import {
  SIDE_ANSWER_CHARS,
  controlRetryOf,
  sideAnswerOf,
  sideQuestionFailure,
  withdrawnOf,
} from './sideQuestion';

describe('sideAnswerOf (askSideQuestion answer)', () => {
  it('takes response, synthetic and the refusal fallback model; tolerates extra and broken fields', () => {
    expect(sideAnswerOf({ response: 'Yes.', synthetic: false })).toEqual({
      response: 'Yes.',
      synthetic: false,
      fallbackModel: null,
    });
    expect(
      sideAnswerOf({ response: 'No.', synthetic: true, refusalFallback: { fallbackModel: ' sonnet ', originalModel: 'opus' }, x: 1 }),
    ).toEqual({ response: 'No.', synthetic: true, fallbackModel: 'sonnet' });
    expect(sideAnswerOf({ response: 'a', refusalFallback: 42 })).toEqual({
      response: 'a',
      synthetic: false,
      fallbackModel: null,
    });
    expect(sideAnswerOf({ response: 'a', refusalFallback: { fallbackModel: '   ' } })?.valueOf()).toMatchObject({
      fallbackModel: null,
    });
  });

  it('null = no answer; an unknown shape = invalid; a runaway answer is cut', () => {
    expect(sideAnswerOf(null)).toBeNull();
    expect(sideAnswerOf(undefined)).toBe('invalid');
    expect(sideAnswerOf({ text: 'x' })).toBe('invalid');
    expect(sideAnswerOf({ response: 1 })).toBe('invalid');
    const long = sideAnswerOf({ response: 'x'.repeat(SIDE_ANSWER_CHARS + 5) });
    expect(long !== null && long !== 'invalid' ? long.response.length : 0).toBe(SIDE_ANSWER_CHARS);
  });
});

describe('sideQuestionFailure', () => {
  it('our abort → cancelled; side_question_busy (errorCode, code, message) → busy; else failed', () => {
    expect(sideQuestionFailure(new Error('x'), true)).toBe('cancelled');
    expect(sideQuestionFailure(Object.assign(new Error('x'), { errorCode: 'side_question_busy' }), false)).toBe('busy');
    expect(sideQuestionFailure({ code: 'side_question_busy' }, false)).toBe('busy');
    expect(sideQuestionFailure(new Error('Control error: side_question_busy'), false)).toBe('busy');
    expect(sideQuestionFailure(new Error('model error'), false)).toBe('failed');
    expect(sideQuestionFailure('text', false)).toBe('failed');
    expect(sideQuestionFailure(null, false)).toBe('failed');
  });
});

describe('controlRetryOf (system/control_request_progress)', () => {
  it('api_retry → the counter; started, other messages and broken counters → null', () => {
    const base = { type: 'system', subtype: 'control_request_progress', request_id: 'r' };
    expect(controlRetryOf({ ...base, status: 'api_retry', attempt: 3, max_retries: 10 })).toEqual({
      attempt: 3,
      maxRetries: 10,
    });
    expect(controlRetryOf({ ...base, status: 'api_retry' })).toEqual({ attempt: 0, maxRetries: 0 });
    expect(controlRetryOf({ ...base, status: 'started' })).toBeNull();
    expect(controlRetryOf({ ...base, status: 'api_retry', attempt: -1 })).toBeNull();
    expect(controlRetryOf({ type: 'system', subtype: 'status', status: 'api_retry' })).toBeNull();
    expect(controlRetryOf(null)).toBeNull();
  });
});

describe('withdrawnOf (cancelAsyncMessage answer)', () => {
  it('the flag (unwrapped or wrapped); anything else = not withdrawn', () => {
    expect(withdrawnOf(true)).toBe(true);
    expect(withdrawnOf(false)).toBe(false);
    expect(withdrawnOf({ cancelled: true })).toBe(true);
    expect(withdrawnOf({ cancelled: 'yes' })).toBe(false);
    expect(withdrawnOf(undefined)).toBe(false);
  });
});
