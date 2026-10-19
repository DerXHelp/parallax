import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleDecisions } from '@shared/samples';
import { resetClientStore } from '@web/state/store';
import { buildQuestionAnswer, QuestionCard } from './components/QuestionCard';
import { DecisionBar } from './DecisionBar';
import { renderWithHost, type Harness } from './lib/testing';
import { resetDecisionBarState } from './state/bar-store';

// UI tests with many key strokes: 2.5–6 s in a full `pnpm test`, up to 21 s when several runs load
// the machine (docs/wp/FLAKES.md). A timed-out test keeps typing into the next one, so keep a margin.
vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  resetDecisionBarState();
  localStorage.clear();
});

/** The demo question decision has two questions: "Format" (single select) and "Checks" (multi). */
function start(): Harness {
  harness = renderWithHost((key) => <DecisionBar sessionKey={key('question')} />, { entries: ['question'] });
  return harness;
}

type User = ReturnType<typeof userEvent.setup>;

/** Several questions are tabs: only the active question is in the DOM. */
async function openTab(user: User, name: RegExp): Promise<void> {
  await user.click(screen.getByRole('tab', { name }));
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
    await openTab(user, /^Checks/);
    await user.click(screen.getByRole('checkbox', { name: /Typecheck/ }));
    expect(screen.getByRole('button', { name: 'Answer' }).hasAttribute('disabled')).toBe(false);
    expect(h.commands('decision.respond')).toEqual([]);
  });

  it('sends the contract format: question text, selected labels, other text and notes', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /JSON files/ }));
    await user.type(screen.getByRole('textbox', { name: 'Note for Claude (optional)' }), 'Keep it readable');
    await openTab(user, /^Checks/);
    await user.click(screen.getByRole('checkbox', { name: /Typecheck/ }));
    await user.click(screen.getByRole('checkbox', { name: /Tests/ }));
    await user.type(screen.getByRole('textbox', { name: 'Other' }), 'prettier');
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

  it('several questions are tabs: the header names the tab, one question at a time, a tick once answered', async () => {
    start();
    const user = userEvent.setup();
    expect(await screen.findByRole('tablist', { name: 'Questions' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Format (not answered yet)',
      'Checks (not answered yet)',
    ]);
    expect(screen.getByText('Which storage format should the registry use?')).toBeTruthy();
    expect(screen.queryByText('Which checks should run before every commit?')).toBeNull();
    await user.click(screen.getByRole('radio', { name: /JSON files/ }));
    expect(screen.getByRole('tab', { name: 'Format (answered)' }).dataset.answered).toBe('true');
    expect(screen.getByRole('tab', { name: 'Checks (not answered yet)' }).dataset.answered).toBe('false');
    await openTab(user, /^Checks/);
    expect(screen.getByText('Which checks should run before every commit?')).toBeTruthy();
    expect(screen.queryByText('Which storage format should the registry use?')).toBeNull();
  });

  it('switching tabs keeps every draft', async () => {
    start();
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Other' }), 'YAML');
    await user.type(screen.getByRole('textbox', { name: 'Note for Claude (optional)' }), 'short');
    await openTab(user, /^Checks/);
    await user.click(screen.getByRole('checkbox', { name: /Lint/ }));
    await openTab(user, /^Format/);
    expect(screen.getByRole('textbox', { name: 'Other' })).toHaveProperty('value', 'YAML');
    expect(screen.getByRole('textbox', { name: 'Note for Claude (optional)' })).toHaveProperty(
      'value',
      'short',
    );
    expect(screen.getByRole('radio', { name: 'Other' }).getAttribute('aria-checked')).toBe('true');
    await openTab(user, /^Checks/);
    expect(screen.getByRole('checkbox', { name: /Lint/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('"Next question" opens and focuses the next tab; neither it nor a tab answers', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /JSON files/ }));
    await user.click(screen.getByRole('button', { name: 'Next question' }));
    const checks = screen.getByRole('tab', { name: /^Checks/ });
    expect(checks.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(checks);
    // The last question has no "Next question".
    expect(screen.queryByRole('button', { name: 'Next question' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /Lint/ }));
    expect(screen.getByRole('button', { name: 'Answer' }).hasAttribute('disabled')).toBe(false);
    // Complete, but the focus is on a tab: Mod+Enter there must not answer (card-shell).
    await openTab(user, /^Format/);
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Format/ }));
    await user.keyboard('{Control>}{Enter}{/Control}');
    await user.keyboard('{Enter}');
    expect(h.commands('decision.respond')).toEqual([]);
  });

  it('a single question shows no tabs', async () => {
    const decision = sampleDecisions.question();
    harness = renderWithHost((key) => <QuestionCard sessionKey={key('question')} decision={decision} />, {
      entries: ['question'],
    });
    expect(await screen.findByText('Which color should the button be?')).toBeTruthy();
    expect(screen.getByText('Color')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next question' })).toBeNull();
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
    await user.type(await screen.findByRole('textbox', { name: 'Other' }), 'YAML');
    expect(screen.getByRole('radio', { name: 'Other' }).getAttribute('aria-checked')).toBe('true');
    await openTab(user, /^Checks/);
    await user.click(screen.getByRole('checkbox', { name: /Lint/ }));
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    const response = h.commands('decision.respond')[0]?.response;
    expect(response).toMatchObject({
      kind: 'question',
      response: { answers: [{ selected: [], otherText: 'YAML' }, { selected: ['Lint'] }] },
    });
  });

  it('single select: typing into "Other" after picking an option drops that option (R2W-02)', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /JSON files/ }));
    expect(screen.getByText('Preview: JSON files')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Other' }), 'TOML');
    expect(screen.getByRole('radio', { name: 'Other' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /JSON files/ }).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByText('Preview: JSON files')).toBeNull();
    // Multi select keeps its ticks next to "Other".
    await openTab(user, /^Checks/);
    await user.click(screen.getByRole('checkbox', { name: /Lint/ }));
    await user.type(screen.getByRole('textbox', { name: 'Other' }), 'knip');
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(h.commands('decision.respond')[0]?.response).toMatchObject({
      kind: 'question',
      response: {
        answers: [
          { selected: [], otherText: 'TOML' },
          { selected: ['Lint'], otherText: 'knip' },
        ],
      },
    });
  });

  it('Mod+Enter in a field of the card answers once every question is answered', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /JSON files/ }));
    await openTab(user, /^Checks/);
    await user.type(screen.getByRole('textbox', { name: 'Other' }), 'none');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(h.commands('decision.respond')[0]?.response).toMatchObject({
      kind: 'question',
      response: {
        behavior: 'answer',
        answers: [{ selected: ['JSON files'] }, { selected: [], otherText: 'none' }],
      },
    });
  });

  it('Mod+Enter on a focused option answers (V2-02); Enter and Space on it never do', async () => {
    const h = start();
    const user = userEvent.setup();
    await screen.findByRole('radio', { name: /JSON files/ });
    await openTab(user, /^Checks/);
    await user.click(screen.getByRole('checkbox', { name: /Lint/ }));
    await openTab(user, /^Format/);
    // The focus is on the chosen option (Radix prevents Enter there, also Ctrl+Enter).
    await user.click(screen.getByRole('radio', { name: /SQLite/ }));
    const radio = screen.getByRole('radio', { name: /SQLite/ });
    expect(document.activeElement).toBe(radio);
    expect(radio.getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(h.commands('decision.respond')).toEqual([]);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(h.commands('decision.respond').map((cmd) => cmd.response)).toEqual([
      {
        kind: 'question',
        response: {
          behavior: 'answer',
          answers: [
            {
              question: 'Which storage format should the registry use?',
              selected: ['SQLite'],
              otherText: null,
              notes: null,
            },
            {
              question: 'Which checks should run before every commit?',
              selected: ['Lint'],
              otherText: null,
              notes: null,
            },
          ],
        },
      },
    ]);
  });

  it('Mod+Enter on a focused checkbox answers once complete, and never twice', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /JSON files/ }));
    await openTab(user, /^Checks/);
    await user.click(screen.getByRole('checkbox', { name: /Tests/ }));
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: /Tests/ }));
    await user.keyboard(' ');
    // Space toggles the option off again (no answer) – the second question is now unanswered.
    expect(h.commands('decision.respond')).toEqual([]);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(h.commands('decision.respond')).toEqual([]);
    await user.keyboard(' ');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(h.commands('decision.respond')).toHaveLength(1);
    expect(h.commands('decision.respond')[0]?.response).toMatchObject({
      response: { answers: [{ selected: ['JSON files'] }, { selected: ['Tests'] }] },
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
