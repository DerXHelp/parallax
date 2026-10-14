/**
 * ask-user-question – AskUserQuestion via canUseTool (point 5): input shape with markdown
 * previews (toolConfig.askUserQuestion.previewFormat) and the answer via updatedInput.answers
 * (question text -> label) plus annotations (notes/preview per question).
 */
import { allowOnce, deny, type PermissionPolicy } from '../session';
import { withSession, type Scenario } from './common';

const DESCRIPTION =
  'AskUserQuestion with two options and markdown previews; answered via updatedInput.answers ' +
  '{question: "Blue"} + annotations {notes, preview}; model echoes the answer.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const NOTE = 'Spike note: prefer a darker shade';

/** Answers every question with option "Blue" (or the first option) and a note. */
export const answerBlue: PermissionPolicy = (tool, input) => {
  if (tool !== 'AskUserQuestion') return deny('Not needed for this task.');
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes: string; preview?: string }> = {};
  for (const question of questions) {
    if (!isRecord(question) || typeof question.question !== 'string') continue;
    const options = Array.isArray(question.options) ? question.options.filter(isRecord) : [];
    const chosen = options.find((option) => option.label === 'Blue') ?? options[0];
    const label = typeof chosen?.label === 'string' ? chosen.label : 'Blue';
    answers[question.question] = label;
    annotations[question.question] = {
      notes: NOTE,
      ...(typeof chosen?.preview === 'string' ? { preview: chosen.preview } : {}),
    };
  }
  return { ...allowOnce({ ...input, answers, annotations }) };
};

export const askUserQuestion: Scenario = {
  name: 'ask-user-question',
  description: DESCRIPTION,
  live: true,
  async run(ctx) {
    await withSession(
      ctx,
      'ask-user-question',
      DESCRIPTION,
      { permissionMode: 'default', maxTurns: 4, policy: answerBlue },
      async (session) => {
        await session.turn(
          'Use the AskUserQuestion tool exactly once to ask me this single question: ' +
            '"Which color should the button be?" with header "Color" and exactly two options, "Red" and "Blue", ' +
            'each with a one-line description and a short markdown preview. ' +
            'After my answer, reply with exactly: CHOSEN <color> NOTE <my note>',
        );
      },
    );
  },
};
