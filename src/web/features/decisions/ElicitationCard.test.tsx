import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import type { ElicitationDecision, ElicitationField } from '@shared/model';
import { sampleDecisions, sampleId, sampleResponses } from '@shared/samples';
import { configureExternalLinks } from '@web/lib/external-link';
import { clientStore, resetClientStore } from '@web/state/store';
import { DecisionView } from './components/DecisionView';
import { DecisionBar } from './DecisionBar';
import { DEMO_ENTRIES, DEMO_UNSUPPORTED_REASON } from './lib/demo-data';
import { localDateTimeToIso } from './lib/elicitation';
import { renderWithHost, type Harness } from './lib/testing';
import { resetDecisionBarState } from './state/bar-store';

// UI tests with many key strokes (docs/wp/FLAKES.md): keep a margin under load.
vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;
let removeOpener: (() => void) | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  removeOpener?.();
  removeOpener = null;
  resetClientStore();
  resetDecisionBarState();
  localStorage.clear();
});

type Entry = 'elicitForm' | 'elicitUrl' | 'elicitUnsupported';

function start(entry: Entry): Harness {
  harness = renderWithHost((key) => <DecisionBar sessionKey={key(entry)} />, { entries: [entry] });
  return harness;
}

function card(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-decision-kind="elicitation"]');
  if (element === null) throw new Error('no elicitation card');
  return element;
}

function responses(h: Harness) {
  return h.commands('decision.respond').map((cmd) => cmd.response);
}

function notices() {
  return clientStore.getState().notices.map((notice) => notice.content);
}

function field(p: Partial<ElicitationField> & Pick<ElicitationField, 'key' | 'type'>): ElicitationField {
  return {
    title: null,
    description: null,
    required: false,
    enumValues: null,
    enumNames: null,
    format: null,
    minimum: null,
    maximum: null,
    minLength: null,
    maxLength: null,
    default: null,
    ...p,
  };
}

/** A form decision with custom fields, rendered directly; `decision.respond` is acked by the test. */
function startCustom(fields: ElicitationField[], p: Partial<ElicitationDecision> = {}): Harness {
  const decision = sampleDecisions.elicitationForm({
    entryId: DEMO_ENTRIES.elicitForm,
    id: sampleId('dc', 0xaf9),
    fields,
    ...p,
  });
  harness = renderWithHost((key) => <DecisionView sessionKey={key('elicitForm')} decision={decision} />, {
    entries: ['elicitForm'],
    onCommand: (cmd) =>
      cmd.name === 'decision.respond' ? { ok: true, result: { outcome: { type: 'answered' } } } : undefined,
  });
  return harness;
}

describe('ElicitationCard – form (WP-116)', () => {
  it('shows title, server, message and the fields with their defaults; nothing takes the focus', async () => {
    start('elicitForm');
    expect(await screen.findByText('New ticket')).toBeTruthy();
    expect(within(card()).getByText('MCP server sample-tracker')).toBeTruthy();
    expect(within(card()).getByText('Where should the ticket go?')).toBeTruthy();
    // The bar's polite announcement (the existing `announce` text).
    expect(document.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
      'sample-tracker asks for input',
    );
    expect(screen.getByRole('radiogroup', { name: 'Project' }).getAttribute('aria-required')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Web app' }).getAttribute('aria-checked')).toBe('true');
    // Required enum: no "Not specified".
    expect(screen.queryByRole('radio', { name: 'Not specified' })).toBeNull();
    const priority = screen.getByRole('textbox', { name: 'Priority' });
    expect(priority).toHaveProperty('value', '3');
    expect(priority.getAttribute('inputmode')).toBe('numeric');
    expect(priority.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(card()).getByText('1 = highest')).toBeTruthy();
    expect(within(card()).getByText('Whole number · From 1 to 5')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Notify the team' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    const contact = screen.getByRole('textbox', { name: 'Contact' });
    expect(contact.getAttribute('type')).toBe('email');
    expect(contact.getAttribute('maxlength')).toBe('200');
    expect(contact.getAttribute('placeholder')).toBe('name@example.com');
    expect(within(card()).getByText('* Required')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it('sends the answer in the contract format and the card goes away', async () => {
    const h = start('elicitForm');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Server' }));
    await user.clear(screen.getByRole('textbox', { name: 'Priority' }));
    await user.type(screen.getByRole('textbox', { name: 'Priority' }), '2');
    await user.click(screen.getByRole('checkbox', { name: 'Notify the team' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(responses(h)).toEqual([sampleResponses.elicitationAccept]);
    await waitFor(() => {
      expect(document.querySelector('[data-decision-kind="elicitation"]')).toBeNull();
    });
    // Answered here: no "closed elsewhere" notice.
    expect(notices()).toEqual([]);
  });

  it('checks before sending: errors at the field, the focus on the first invalid one', async () => {
    const h = start('elicitForm');
    const user = userEvent.setup();
    const priority = await screen.findByRole('textbox', { name: 'Priority' });
    await user.clear(priority);
    await user.type(priority, '9');
    // Not before the field was left.
    expect(within(card()).queryByText('At most 5.')).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Contact' }), 'nobody');
    expect(within(card()).getByText('At most 5.')).toBeTruthy();
    expect(priority.getAttribute('aria-invalid')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(responses(h)).toEqual([]);
    expect(within(card()).getByText('Enter an email address.')).toBeTruthy();
    expect(document.activeElement).toBe(priority);
    const error = within(card()).getByText('At most 5.');
    expect(priority.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
    await user.clear(priority);
    await user.type(priority, '5');
    expect(within(card()).queryByText('At most 5.')).toBeNull();
    const contact = screen.getByRole('textbox', { name: 'Contact' });
    await user.clear(contact);
    await user.type(contact, 'dev@mail.example');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(responses(h)).toEqual([
      {
        kind: 'elicitation',
        response: {
          action: 'accept',
          content: { project: 'web', priority: 5, notify: false, contact: 'dev@mail.example' },
        },
      },
    ]);
  });

  it('a required field shows "required" only after a send attempt', async () => {
    const h = startCustom([
      field({ key: 'name', type: 'string', title: 'Name', required: true, maxLength: 80 }),
    ]);
    const user = userEvent.setup();
    const name = await screen.findByRole('textbox', { name: 'Name' });
    expect(name.getAttribute('aria-required')).toBe('true');
    await user.click(name);
    await user.tab();
    expect(within(card()).queryByText('Please fill in this field.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(within(card()).getByText('Please fill in this field.')).toBeTruthy();
    expect(document.activeElement).toBe(name);
    expect(responses(h)).toEqual([]);
  });

  it('decline and cancel answer without content', async () => {
    const h = start('elicitForm');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(responses(h)).toEqual([sampleResponses.elicitationDecline]);
    h.stop();
    resetClientStore();
    resetDecisionBarState();
    const second = start('elicitForm');
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(cancel.getAttribute('title')).toBe('Closes the request without an answer.');
    expect(screen.getByRole('button', { name: 'Decline' }).getAttribute('title')).toBe(
      'Tells sample-tracker that you do not want to give this input.',
    );
    await user.click(cancel);
    expect(responses(second)).toEqual([sampleResponses.elicitationCancel]);
  });

  it('Enter never sends, Mod+Enter in a field sends, Esc does not cancel', async () => {
    const h = startCustom([
      field({ key: 'title', type: 'string', title: 'Title', maxLength: 80 }),
      field({ key: 'notes', type: 'string', title: 'Notes' }),
    ]);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), 'Flaky test{Enter}');
    const notes = screen.getByRole('textbox', { name: 'Notes' });
    expect(notes.tagName).toBe('TEXTAREA');
    await user.type(notes, 'line 1{Enter}line 2');
    await user.keyboard('{Escape}');
    expect(responses(h)).toEqual([]);
    expect(notes).toHaveProperty('value', 'line 1\nline 2');
    expect(document.querySelector('[data-decision-kind="elicitation"]')).not.toBeNull();
    card().focus();
    await user.keyboard('{Escape}');
    expect(responses(h)).toEqual([]);
    notes.focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(responses(h)).toEqual([
      {
        kind: 'elicitation',
        response: { action: 'accept', content: { title: 'Flaky test', notes: 'line 1\nline 2' } },
      },
    ]);
  });

  it('a value the server refuses is marked at its field; other failures show in the card', async () => {
    const h = start('elicitForm');
    const user = userEvent.setup();
    const contact = await screen.findByRole('textbox', { name: 'Contact' });
    await user.type(contact, 'dev@mail.example');
    h.host.failNext(
      'decision.respond',
      makeError('DECISION_OPTION_UNAVAILABLE', { path: 'content.contact' }),
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await within(card()).findByText('This value was not accepted – please check it.')).toBeTruthy();
    expect(contact.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(contact);
    await user.type(contact, 'm');
    expect(within(card()).queryByText('This value was not accepted – please check it.')).toBeNull();
    h.host.failNext(
      'decision.respond',
      makeError('ELICITATION_UNSUPPORTED', { reason: 'Field "x" is an array.' }),
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const alert = await within(card()).findByRole('alert');
    expect(alert.textContent).toContain('The input could not be sent');
    expect(notices()).toEqual([]);
    // The card stays answerable.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false);
    });
  });

  it('renders every control: select with "Not specified", date, date-time, decimals, optional radios', async () => {
    const h = startCustom([
      field({
        key: 'team',
        type: 'enum',
        title: 'Team',
        enumValues: ['a', 'b', 'c', 'd', 'e', 'f'],
        enumNames: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'],
      }),
      field({ key: 'size', type: 'enum', title: 'Size', enumValues: ['s', 'm'], default: 'm' }),
      field({ key: 'due', type: 'string', title: 'Due', format: 'date' }),
      field({ key: 'at', type: 'string', title: 'Meeting', format: 'date-time', required: true }),
      field({ key: 'link', type: 'string', title: 'Link', format: 'uri' }),
      field({ key: 'ratio', type: 'number', title: 'Ratio', minimum: 0, maximum: 1 }),
    ]);
    const user = userEvent.setup();
    const team = await screen.findByRole('combobox', { name: 'Team' });
    // Optional and without a default: "Not specified" is chosen (like the optional radios).
    expect(team.textContent).toContain('Not specified');
    team.focus();
    await user.keyboard('{Enter}');
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Not specified',
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
      'Epsilon',
      'Zeta',
    ]);
    await user.click(screen.getByRole('option', { name: 'Gamma' }));
    expect(screen.getByRole('combobox', { name: 'Team' }).textContent).toContain('Gamma');
    expect(screen.getByRole('radio', { name: 'm' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('radio', { name: 'Not specified' }));
    const due = screen.getByLabelText('Due');
    expect(due.getAttribute('type')).toBe('date');
    fireEvent.change(due, { target: { value: '2026-12-01' } });
    const meeting = screen.getByLabelText(/^Meeting/);
    expect(meeting.getAttribute('type')).toBe('datetime-local');
    fireEvent.change(meeting, { target: { value: '2026-12-01T09:15' } });
    expect(screen.getByLabelText('Link').getAttribute('type')).toBe('url');
    const ratio = screen.getByRole('textbox', { name: 'Ratio' });
    expect(ratio.getAttribute('inputmode')).toBe('decimal');
    await user.type(ratio, '0.5');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(responses(h)).toEqual([
      {
        kind: 'elicitation',
        response: {
          action: 'accept',
          content: { team: 'c', due: '2026-12-01', at: localDateTimeToIso('2026-12-01T09:15'), ratio: 0.5 },
        },
      },
    ]);
  });
});

describe('ElicitationCard – url mode (WP-116)', () => {
  it('shows the target, opens it through the link way, then "Done" answers accept', async () => {
    const opened: string[] = [];
    removeOpener = configureExternalLinks({
      open: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
      fellBack: () => undefined,
    });
    const h = start('elicitUrl');
    const user = userEvent.setup();
    expect(await screen.findByText('Input for Sample Auth')).toBeTruthy();
    expect(within(card()).getByText('MCP server Sample Auth (sample-auth)')).toBeTruthy();
    expect(within(card()).getByText('Sign in to continue.')).toBeTruthy();
    expect(within(card()).getByText('sign-in.example')).toBeTruthy();
    const link = within(card()).getByRole('link', { name: 'https://sign-in.example/device' });
    expect(link.getAttribute('href')).toBe('https://sign-in.example/device');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    // Before opening, Mod+Enter answers nothing (the main action is "Done" only after opening).
    card().focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(responses(h)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(opened).toEqual(['https://sign-in.example/device']);
    expect(responses(h)).toEqual([]);
    expect(within(card()).getByText(/Opened in your browser/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(responses(h)).toEqual([{ kind: 'elicitation', response: { action: 'accept', content: null } }]);
  });

  it('"Cancel" answers cancel; Esc does nothing', async () => {
    const h = start('elicitUrl');
    const user = userEvent.setup();
    await screen.findByText('Input for Sample Auth');
    card().focus();
    await user.keyboard('{Escape}');
    expect(responses(h)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(responses(h)).toEqual([sampleResponses.elicitationCancel]);
  });

  it('the server finishing the request (elicitation_complete) removes the card with a notice', async () => {
    const h = start('elicitUrl');
    await screen.findByText('Input for Sample Auth');
    act(() => {
      h.host.pushOps(DEMO_ENTRIES.elicitUrl, [
        {
          op: 'decision.resolved',
          decisionId: sampleId('dc', 0xb01),
          outcome: { type: 'answered' },
          byClientId: null,
          at: new Date().toISOString(),
        },
      ]);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-decision-kind="elicitation"]')).toBeNull();
    });
    expect(notices()).toEqual([
      { text: 'decisions.notices.elicitationClosed', params: { server: 'Sample Auth' } },
    ]);
  });

  it('a url mode without an http(s) target offers only "Decline"', async () => {
    const h = startCustom([], { mode: 'url', url: null, title: null });
    const user = userEvent.setup();
    expect(await within(card()).findByText('The request has no valid http(s) link.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open in browser' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(responses(h)).toEqual([sampleResponses.elicitationDecline]);
  });
});

describe('ElicitationCard – not supported (WP-116)', () => {
  it('shows the reason and offers only "Decline"', async () => {
    const h = start('elicitUnsupported');
    const user = userEvent.setup();
    expect(await screen.findByText('Label the ticket')).toBeTruthy();
    expect(within(card()).getByText('Parallax cannot show this form')).toBeTruthy();
    expect(within(card()).getByText(DEMO_UNSUPPORTED_REASON)).toBeTruthy();
    expect(
      within(card())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Decline']);
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(responses(h)).toEqual([sampleResponses.elicitationDecline]);
  });

  it('an expired elicitation names its server and offers "Continue"', async () => {
    const decision = sampleDecisions.elicitationForm({ entryId: DEMO_ENTRIES.elicitForm, state: 'expired' });
    harness = renderWithHost((key) => <DecisionView sessionKey={key('elicitForm')} decision={decision} />, {
      entries: ['elicitForm'],
    });
    expect(await within(card()).findByText('MCP server sample-tracker')).toBeTruthy();
    expect(within(card()).getByText('Where should the ticket go?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });
});
