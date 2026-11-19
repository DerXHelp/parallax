import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanAnnotation } from '@shared/model';
import type { Command } from '@shared/protocol';
import { samplePlanAnnotation } from '@shared/samples';
import { rangeOfSpan } from '@web/lib/text-anchor';
import { SidePanelHost } from '@web/shell/side-panel/SidePanelHost';
import { openSidePanel, resetSidePanelState } from '@web/shell/side-panel/state';
import type { FakeAck, FakeHost } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { resetDraftStore, setDraft } from '../composer/state/drafts';
import { DecisionBar } from './DecisionBar';
import { DEMO_PLAN_V1 } from './lib/demo-data';
import { renderWithHost, type Harness } from './lib/testing';
import { resetPlanAnnotations } from './state/annotations';
import { resetDecisionBarState } from './state/bar-store';
import { resetPlanData } from './state/plan-data';

vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  window.getSelection()?.removeAllRanges();
  resetClientStore();
  resetDecisionBarState();
  resetSidePanelState();
  resetPlanData();
  resetPlanAnnotations();
  resetDraftStore();
  localStorage.clear();
});

function start(onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined): Harness {
  const h = renderWithHost(
    (key) => (
      <>
        <SidePanelHost sessionKey={key('plan')} />
        <DecisionBar sessionKey={key('plan')} />
      </>
    ),
    { entries: ['plan'], onCommand },
  );
  harness = h;
  act(() => {
    openSidePanel(h.key('plan'), 'plan');
  });
  return h;
}

async function findTab(): Promise<HTMLElement> {
  const tab = await screen.findByRole('complementary', { name: 'Plan' });
  await waitFor(() => {
    expect(tab.querySelectorAll('[data-plan-block]').length).toBeGreaterThan(0);
  });
  return tab;
}

function block(tab: HTMLElement, index: number): HTMLElement {
  const found = tab.querySelector<HTMLElement>(`[data-plan-block="${String(index)}"]`);
  if (found === null) throw new Error(`block ${String(index)} missing`);
  return found;
}

/** Selects `text` in the rendered block like the user would and lets the annotator see it. */
async function select(tab: HTMLElement, index: number, text: string): Promise<void> {
  const root = block(tab, index).querySelector<HTMLElement>('[data-plan-text]');
  if (root === null) throw new Error('block text missing');
  const start = root.textContent.indexOf(text);
  expect(start).toBeGreaterThanOrEqual(0);
  const range = rangeOfSpan(root, { start, end: start + text.length });
  if (range === null) throw new Error('range missing');
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.pointerUp(root);
  await waitFor(() => {
    expect(tab.querySelector('[data-slot="plan-selection-toolbar"]')).not.toBeNull();
  });
}

function lastAnnotations(h: Harness): PlanAnnotation[] {
  return h.commands('decision.annotatePlan').at(-1)?.annotations ?? [];
}

describe('plan annotations (WP-93)', () => {
  it('renders the open version block by block; + at a passage comments on all of it', async () => {
    const h = start();
    const user = userEvent.setup();
    const tab = await findTab();
    // Heading, intro, three list items, heading, two items, heading, code block.
    expect(tab.querySelectorAll('[data-plan-block]')).toHaveLength(10);
    expect(within(tab).getByText(/Select text to comment/)).toBeTruthy();
    await user.click(within(block(tab, 1)).getByRole('button', { name: 'Comment on this passage' }));
    await user.type(within(tab).getByRole('textbox', { name: 'Comment' }), 'Explain why.{Enter}');
    await waitFor(() => {
      expect(lastAnnotations(h)).toEqual([
        expect.objectContaining({ kind: 'comment', block: 1, quote: '', comment: 'Explain why.' }),
      ]);
    });
    const note = await within(block(tab, 1)).findByText('Explain why.');
    expect(note.closest('[data-slot="plan-annotation"]')?.textContent).toContain('Whole passage');
    expect(tab.querySelector('[data-slot="plan-annotation-count"]')?.textContent).toBe('1 annotation');
    // The card in the bar and the tab's button both count it.
    expect(document.querySelectorAll('[data-slot="plan-annotation-badge"]')).toHaveLength(2);
  });

  it('a selection offers Comment (key C) and Strike; the quote keeps the text around it', async () => {
    const h = start();
    const user = userEvent.setup();
    const tab = await findTab();
    await select(tab, 1, 'atomic JSON files');
    fireEvent.keyDown(document.body, { key: 'c' });
    await user.type(await within(tab).findByRole('textbox', { name: 'Comment' }), 'Which library?{Enter}');
    await waitFor(() => {
      expect(lastAnnotations(h)).toHaveLength(1);
    });
    const [comment] = lastAnnotations(h);
    expect(comment).toMatchObject({
      kind: 'comment',
      block: 1,
      quote: 'atomic JSON files',
      comment: 'Which library?',
    });
    expect(comment?.prefix.endsWith('registry with ')).toBe(true);
    expect(comment?.suffix.startsWith(' and schema')).toBe(true);

    await select(tab, 4, 'SQLite dependency');
    await user.click(within(tab).getByRole('button', { name: 'Strike' }));
    await waitFor(() => {
      expect(lastAnnotations(h)).toHaveLength(2);
    });
    expect(lastAnnotations(h)[1]).toMatchObject({
      kind: 'strike',
      block: 4,
      quote: 'SQLite dependency',
      comment: '',
    });
    expect(within(block(tab, 4)).getByText('Strike')).toBeTruthy();
    expect(tab.querySelector('[data-slot="plan-annotation-count"]')?.textContent).toBe('2 annotations');

    // A selection that moves out of the plan hides the toolbar.
    await select(tab, 1, 'atomic JSON files');
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    act(() => {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await waitFor(() => {
      expect(tab.querySelector('[data-slot="plan-selection-toolbar"]')).toBeNull();
    });
    outside.remove();
  });

  it('edits and deletes an annotation; Escape cancels the editor', async () => {
    const h = start();
    const user = userEvent.setup();
    const tab = await findTab();
    await user.click(within(block(tab, 2)).getByRole('button', { name: 'Comment on this passage' }));
    await user.type(within(tab).getByRole('textbox', { name: 'Comment' }), 'First{Enter}');
    await within(block(tab, 2)).findByText('First');
    await user.click(within(block(tab, 2)).getByRole('button', { name: 'Edit' }));
    const field = within(tab).getByRole('textbox', { name: 'Comment' });
    await user.clear(field);
    await user.type(field, 'Second{Enter}');
    await waitFor(() => {
      expect(lastAnnotations(h)).toEqual([expect.objectContaining({ comment: 'Second' })]);
    });
    await user.click(within(block(tab, 3)).getByRole('button', { name: 'Comment on this passage' }));
    await user.type(within(tab).getByRole('textbox', { name: 'Comment' }), 'gone{Escape}');
    expect(within(tab).queryByRole('textbox', { name: 'Comment' })).toBeNull();
    await user.click(within(block(tab, 2)).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(lastAnnotations(h)).toEqual([]);
    });
    expect(tab.querySelector('[data-slot="plan-annotation"]')).toBeNull();
  });

  it('an open editor with text is never replaced: + elsewhere focuses it; an empty one moves', async () => {
    start();
    const user = userEvent.setup();
    const tab = await findTab();
    await user.click(within(block(tab, 1)).getByRole('button', { name: 'Comment on this passage' }));
    await user.type(within(tab).getByRole('textbox', { name: 'Comment' }), 'Half a thought');
    await user.click(within(block(tab, 3)).getByRole('button', { name: 'Comment on this passage' }));
    const field = within(block(tab, 1)).getByRole('textbox', { name: 'Comment' });
    expect((field as HTMLTextAreaElement).value).toBe('Half a thought');
    expect(document.activeElement).toBe(field);
    expect(within(block(tab, 3)).queryByRole('textbox')).toBeNull();
    await user.clear(field);
    await user.click(within(block(tab, 3)).getByRole('button', { name: 'Comment on this passage' }));
    expect(within(block(tab, 3)).getByRole('textbox', { name: 'Comment' })).toBeTruthy();
    expect(within(block(tab, 1)).queryByRole('textbox')).toBeNull();
  });

  it('"Keep planning" in the tab sends the annotations with the composer text as feedback', async () => {
    const h = start();
    const user = userEvent.setup();
    const tab = await findTab();
    await user.click(within(block(tab, 1)).getByRole('button', { name: 'Comment on this passage' }));
    await user.type(within(tab).getByRole('textbox', { name: 'Comment' }), 'Too vague.{Enter}');
    await within(block(tab, 1)).findByText('Too vague.');
    act(() => {
      setDraft(h.key('plan'), 'Also add tests.');
    });
    const button = tab.querySelector<HTMLElement>('[data-action="revise-annotations"]');
    if (button === null) throw new Error('button missing');
    await user.click(button);
    await waitFor(() => {
      expect(h.commands('decision.respond')).toHaveLength(1);
    });
    const response = h.commands('decision.respond')[0]?.response;
    expect(
      response?.kind === 'plan' && response.response.behavior === 'revise'
        ? response.response.feedback
        : null,
    ).toBe(
      [
        'Please revise the plan. My annotation:',
        '1. Section "Move the session registry to JSON files", line 3\n   > Replace the SQLite registry with atomic JSON files and schema versions, so a crash never leaves a half-written file.\n   Too vague.',
        'General:\nAlso add tests.',
      ].join('\n\n'),
    );
  });

  it('the diff to v1 lists the annotations sent with it', async () => {
    const sent = samplePlanAnnotation({
      block: 1,
      quote: 'JSON files',
      prefix: 'registry with ',
      comment: 'Atomic?',
    });
    start((cmd) =>
      cmd.name === 'plan.read' && cmd.version === 1
        ? { ok: true, result: { version: 1, text: DEMO_PLAN_V1, annotations: [sent] } }
        : undefined,
    );
    const user = userEvent.setup();
    const tab = await findTab();
    await user.click(await within(tab).findByRole('radio', { name: 'Changes to v1' }));
    const previous = await waitFor(() => {
      const found = tab.querySelector('[data-slot="plan-previous-annotations"]');
      expect(found).not.toBeNull();
      return found;
    });
    expect(previous?.textContent).toContain('Your annotation on v1');
    expect(previous?.textContent).toContain('Atomic?');
    expect(previous?.textContent).toContain('line 3 in v1');
  });

  it('an answered version shows its annotations read-only', async () => {
    const sent = samplePlanAnnotation({ block: 1, quote: 'JSON files', comment: 'Atomic?' });
    start((cmd) =>
      cmd.name === 'plan.read' && cmd.version === 1
        ? { ok: true, result: { version: 1, text: DEMO_PLAN_V1, annotations: [sent] } }
        : undefined,
    );
    const user = userEvent.setup();
    const tab = await findTab();
    await user.click(within(tab).getByRole('button', { name: 'Plan version: v2' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /^v1/ }));
    expect(await within(tab).findByText('Atomic?')).toBeTruthy();
    expect(within(tab).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(tab).queryByRole('button', { name: 'Comment on this passage' })).toBeNull();
  });
});
