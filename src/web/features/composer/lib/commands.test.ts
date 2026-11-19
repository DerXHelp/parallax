import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { samplePlanAnnotation, sampleDecisions } from '@shared/samples';
import { translate, type TranslationKey, type TranslationParams } from '@web/i18n';
import { answerFromText, textLimit } from './commands';

const t = (key: TranslationKey, params?: TranslationParams) => translate('en', key, params);

describe('answerFromText', () => {
  it('a plan without annotations gets the text as feedback', () => {
    expect(answerFromText(sampleDecisions.plan(), 'More detail', t)).toEqual({
      kind: 'plan',
      response: { behavior: 'revise', feedback: 'More detail' },
    });
  });

  it('WP-93: a plan with annotations gets them, the text as the general part', () => {
    const decision = sampleDecisions.plan({ annotations: [samplePlanAnnotation()] });
    const answer = answerFromText(decision, 'More detail', t);
    expect(answer).toEqual({
      kind: 'plan',
      response: {
        behavior: 'revise',
        feedback: [
          'Please revise the plan. My annotation:',
          '1. Section "Plan", line 3\n   > hello.txt\n   Name it greeting.txt instead.',
          'General:\nMore detail',
        ].join('\n\n'),
      },
    });
  });

  it('WP-93: the annotations of this window win over those of the decision (not yet echoed)', () => {
    const decision = sampleDecisions.plan();
    const answer = answerFromText(decision, '', t, [samplePlanAnnotation()]);
    expect(answer.kind === 'plan' && answer.response.behavior === 'revise' ? answer.response.feedback : '').toMatch(
      /^Please revise the plan\. My annotation:/,
    );
  });

  it('a permission gets deny with the text', () => {
    expect(answerFromText(sampleDecisions.permission(), 'No', t)).toEqual({
      kind: 'permission',
      response: { behavior: 'deny', message: 'No', interrupt: false },
    });
  });
});

describe('textLimit', () => {
  it('WP-93: the annotations take their part of the plan feedback limit, never below 0', () => {
    expect(textLimit(sampleDecisions.plan())).toBe(LIMITS.planFeedbackChars);
    expect(textLimit(sampleDecisions.plan(), 1_000)).toBe(LIMITS.planFeedbackChars - 1_000);
    expect(textLimit(sampleDecisions.plan(), LIMITS.planFeedbackChars + 5)).toBe(0);
    expect(textLimit(null, 1_000)).toBe(LIMITS.promptChars);
  });
});
