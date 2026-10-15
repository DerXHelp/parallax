import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleDecisions } from '@shared/samples';
import { resetClientStore } from '@web/state/store';
import { buildQuestionAnswer } from './components/QuestionCard';
import { DecisionBar } from './DecisionBar';
import { renderWithHost, type Harness } from './lib/testing';
import { resetDecisionBarState } from './state/bar-store';

// UI tests with many key strokes: generous timeout under a fully parallel `pnpm test`.
vi.setConfig({ testTimeout: 20_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  resetDecisionBarState();
  localStorage.clear();
});

function start(): Harness {
  harness = renderWithHost((key) => <DecisionBar sessionKey={key('question')} />, { entries: ['question'] });
  return harness;
}

describe('QuestionCard (AskUserQuestion, F.5)', () => {
  it('needs an answer for every question before "Answer" works', async () => {
    const h = start();
    const user = userEvent.setup();
    const answer = await screen.findByRole('button', { name: 'Answer' });
    expect(answer.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Answer every question to send.')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: /JSON files/ }));
    expect(screen.getByRole('button', { name: 'Answer' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /Typecheck/ }));
    expect(screen.getByRole('button', { name: 'Answer' }).hasAttribute('disabled')).toBe(false);
    expect(h.commands('decision.respond')).toEqual([]);
  });

  it('sends the contract format: question text, selected labels, other text and notes', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /JSON files/ }));
    const [notesFirst, notesSecond] = screen.getAllByRole('textbox', { name: 'Note for Claude (optional)' });
    if (notesFirst === undefined || notesSecond === undefined) throw new Error('notes missing');
    await user.type(notesFirst, 'Keep it readable');
    await user.click(screen.getByRole('checkbox', { name: /Typecheck/ }));
    await user.click(screen.getByRole('checkbox', { name: /Tests/ }));
    const [, otherSecond] = screen.getAllByRole('textbox', { name: 'Other' });
    if (otherSecond === undefined) throw new Error('other missing');
    await user.type(otherSecond, 'prettier');
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(h.commands('decision.respond').map((cmd) => cmd.response)).toEqual([
      {
        kind: 'question',
        response: {
          behavior: 'answer',
          answers: [
            {
              question: 'Which storage format should the registry use?',
              selected: ['JSON files'],
              otherText: null,
              notes: 'Keep it readable',
            },
            {
              question: 'Which checks should run before every commit?',
              selected: ['Typecheck', 'Tests'],
              otherText: 'prettier',
              notes: null,
            },
          ],
        },
      },
    ]);
    await waitFor(() => {
      expect(document.querySelector('[data-decision-id]')).toBeNull();
    });
  });

  it('shows the Markdown preview of the selected option through the Markdown slot', async () => {
    start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /SQLite/ }));
    expect(screen.getByText('Preview: SQLite')).toBeTruthy();
    expect(screen.getByTestId('markdown').textContent).toContain('CREATE TABLE');
  });

  it('"Other" in a single-select question answers with free text only', async () => {
    const h = start();
    const user = userEvent.setup();
    const [otherFirst] = await screen.findAllByRole('textbox', { name: 'Other' });
    if (otherFirst === undefined) throw new Error('other missing');
    await user.type(otherFirst, 'YAML');
    expect(screen.getAllByRole('radio', { name: 'Other' })[0]?.getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('checkbox', { name: /Lint/ }));
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    const response = h.commands('decision.respond')[0]?.response;
    expect(response).toMatchObject({
      kind: 'question',
      response: { answers: [{ selected: [], otherText: 'YAML' }, { selected: ['Lint'] }] },
    });
  });

  it('Mod+Enter in a field of the card answers once every question is answered', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /JSON files/ }));
    const [, otherSecond] = screen.getAllByRole('textbox', { name: 'Other' });
    if (otherSecond === undefined) throw new Error('other missing');
    await user.type(otherSecond, 'none');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(h.commands('decision.respond')[0]?.response).toMatchObject({
      kind: 'question',
      response: {
        behavior: 'answer',
        answers: [{ selected: ['JSON files'] }, { selected: [], otherText: 'none' }],
      },
    });
  });

  it('"Skip" declines', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    expect(h.commands('decision.respond').map((cmd) => cmd.response)).toEqual([
      { kind: 'question', response: { behavior: 'decline', message: '' } },
    ]);
  });
});

describe('buildQuestionAnswer', () => {
  const { questions } = sampleDecisions.question();
  it('returns null while a question is unanswered', () => {
    expect(buildQuestionAnswer(questions, [])).toBeNull();
    expect(
      buildQuestionAnswer(questions, [{ selected: [], other: true, otherText: '  ', notes: '' }]),
    ).toBeNull();
  });

  it('trims texts and ignores other text that is not chosen', () => {
    expect(
      buildQuestionAnswer(questions, [{ selected: ['Blue'], other: false, otherText: 'x', notes: ' n ' }]),
    ).toEqual({
      behavior: 'answer',
      answers: [
        { question: 'Which color should the button be?', selected: ['Blue'], otherText: null, notes: 'n' },
      ],
    });
  });
});
