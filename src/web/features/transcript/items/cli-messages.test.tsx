/**
 * WP-95: newer CLI messages in the transcript – missing attachments as a warning, a held message of
 * another session as a quiet line per state, the automatic permission check at a tool call (line and
 * running group step), and the `/rename <title>` echo as a quiet line instead of a user bubble.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCallStatus } from '@shared/model';
import { sampleItems, sampleQueuedPrompt, sampleSystemItems } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { resetExpansion } from '../state/expansion';
import { QueuedPromptRow, UserMessageRow } from './MessageRows';
import { StepGroupLine } from './StepGroupRow';
import { SystemRow } from './SystemRow';
import { ToolCallRow } from './ToolCallRow';

afterEach(() => {
  setLanguage('en');
  resetClientStore();
  resetExpansion();
});

const KEY = 'local:en_00000000000000000000000000000001';

describe('missing attachments (WP-95)', () => {
  it.each([
    [
      { sentCount: 3, missingCount: 2 },
      '2 of 3 attached files did not arrive',
      'Claude continues without them.',
    ],
    [
      { sentCount: 3, missingCount: 1 },
      '1 of 3 attached files did not arrive',
      'Claude continues without it.',
    ],
    [{ sentCount: 1, missingCount: 1 }, 'The attached file did not arrive', 'Claude continues without it.'],
    [
      { sentCount: 4, missingCount: 4 },
      'None of the 4 attached files arrived',
      'Claude continues without them.',
    ],
    [{ sentCount: 0, missingCount: 0 }, 'Attached files did not arrive', 'Claude continues without them.'],
  ])('%j → a warning notice', (counts, title, detail) => {
    const { container } = render(
      <SystemRow item={sampleSystemItems.attachments_missing(counts)} sessionKey={KEY} />,
    );
    const row = container.querySelector('[data-slot="attachments-missing"]');
    expect(row?.querySelector('[data-tone="warning"]')).not.toBeNull();
    expect(row?.textContent).toBe(`${title}${detail}`);
  });

  it('German texts (singular and plural)', () => {
    setLanguage('de');
    const { container, rerender } = render(
      <SystemRow item={sampleSystemItems.attachments_missing()} sessionKey={KEY} />,
    );
    expect(container.textContent).toBe(
      '2 von 3 angehängten Dateien kamen nicht anClaude macht ohne sie weiter.',
    );
    rerender(
      <SystemRow item={sampleSystemItems.attachments_missing({ missingCount: 1 })} sessionKey={KEY} />,
    );
    expect(container.textContent).toContain('1 von 3 angehängten Dateien kam nicht an');
    rerender(
      <SystemRow
        item={sampleSystemItems.attachments_missing({ sentCount: 2, missingCount: 2 })}
        sessionKey={KEY}
      />,
    );
    expect(container.textContent).toContain('Keine der 2 angehängten Dateien kam an');
  });
});

describe('held message of another session (WP-95)', () => {
  function line(patch: Parameters<typeof sampleSystemItems.peer_message_hold>[0]): string | null | undefined {
    const { container } = render(
      <SystemRow item={sampleSystemItems.peer_message_hold(patch)} sessionKey={KEY} />,
    );
    return container.querySelector('[data-slot="peer-hold"]')?.textContent;
  }

  it('held: the sender and the translated cause; an unknown cause as sent', () => {
    expect(line({})).toBe('Message from Docs session held back · set in your settings');
    expect(line({ id: 'h2', cause: 'mode-mismatch' })).toBe(
      'Message from Docs session held back · the sender uses a different permission mode',
    );
    expect(line({ id: 'h3', cause: 'future-cause' })).toBe(
      'Message from Docs session held back · future-cause',
    );
    expect(line({ id: 'h4', cause: null })).toBe('Message from Docs session held back');
  });

  it('the sender: fromName, else from, else "another session"', () => {
    expect(line({ fromName: null, cause: null })).toBe('Message from session_sample held back');
    expect(line({ id: 'h2', fromName: ' ', from: '', cause: null })).toBe(
      'Message from another session held back',
    );
  });

  it('released, dropped with the translated outcome, an unknown state as sent', () => {
    expect(line({ state: 'released' })).toBe('Held message from Docs session let through');
    expect(line({ id: 'd1', state: 'dropped', outcome: 'expired' })).toBe(
      'Message from Docs session not delivered · expired',
    );
    expect(line({ id: 'd2', state: 'dropped', outcome: 'vanished' })).toBe(
      'Message from Docs session not delivered · vanished',
    );
    expect(line({ id: 'x1', state: 'parked' })).toBe('Message from Docs session: parked');
  });

  it('one row per state with its own icon slot (data-state)', () => {
    const { container, rerender } = render(
      <SystemRow item={sampleSystemItems.peer_message_hold()} sessionKey={KEY} />,
    );
    expect(container.querySelector('[data-slot="peer-hold"]')?.getAttribute('data-state')).toBe('held');
    rerender(
      <SystemRow item={sampleSystemItems.peer_message_hold({ state: 'released' })} sessionKey={KEY} />,
    );
    expect(container.querySelector('[data-slot="peer-hold"]')?.getAttribute('data-state')).toBe('released');
  });

  it('German texts', () => {
    setLanguage('de');
    expect(line({})).toBe(
      'Nachricht von Docs session zurückgehalten · so in deinen Einstellungen festgelegt',
    );
    expect(line({ id: 'd1', state: 'dropped', outcome: 'refused' })).toBe(
      'Nachricht von Docs session nicht zugestellt · abgelehnt',
    );
    expect(line({ id: 'r1', state: 'released', fromName: null, from: '' })).toBe(
      'Zurückgehaltene Nachricht von einer anderen Session durchgelassen',
    );
  });
});

describe('automatic permission check at a tool call (WP-95)', () => {
  /** The hint's text in the line of a Bash call; null without a hint. */
  function hint(status: ToolCallStatus, permissionCheck: boolean): string | null {
    const item = sampleItems.toolCall({ id: `t-${status}`, status, permissionCheck, result: null });
    const { container, unmount } = render(
      <TooltipProvider>
        <ToolCallRow item={item} sessionKey={KEY} />
      </TooltipProvider>,
    );
    expect(container.querySelector('[data-item-kind="tool_call"]')).not.toBeNull();
    const text = container.querySelector('[data-slot="permission-check"]')?.textContent ?? null;
    unmount();
    return text;
  }

  it.each(['pending', 'running', 'streaming_input'] as const)('%s + permissionCheck → the hint', (status) => {
    expect(hint(status, true)).toBe('Checking permission…');
  });

  it.each(['pending', 'running', 'streaming_input'] as const)(
    '%s without permissionCheck → none',
    (status) => {
      expect(hint(status, false)).toBeNull();
    },
  );

  it.each(['done', 'error', 'denied', 'interrupted', 'awaiting_decision', 'background'] as const)(
    'finished or waiting otherwise (%s) → none, even with the flag',
    (status) => {
      expect(hint(status, true)).toBeNull();
    },
  );

  it('German text', () => {
    setLanguage('de');
    expect(hint('running', true)).toBe('Berechtigung wird geprüft…');
  });

  it('the running step of a group line says so', () => {
    const checking = sampleItems.toolCall({
      id: 'g2',
      status: 'running',
      permissionCheck: true,
      result: null,
    });
    const done = sampleItems.toolCall({ id: 'g1' });
    const props = { groupKey: 'group:g1', imageItems: [], open: false, onOpenChange: () => undefined };
    const { container, rerender } = render(<StepGroupLine {...props} items={[done, checking]} />);
    const running = () => container.querySelector('[data-slot="group-running"]')?.textContent;
    expect(running()).toBe('checking permission: Bash List files');
    rerender(<StepGroupLine {...props} items={[done, { ...checking, permissionCheck: false }]} />);
    expect(running()).toBe('running: Bash List files');
  });
});

describe('/rename echo (WP-95)', () => {
  const rename = (text: string, patch: Parameters<typeof sampleItems.userMessage>[0] = {}) =>
    sampleItems.userMessage({
      id: 'u-rename',
      text: { text, truncated: null },
      slashCommand: '/rename',
      ...patch,
    });

  it('a /rename with a title → a quiet line, no bubble and no "Command" badge', () => {
    const { container } = render(
      <UserMessageRow item={rename('/rename  Fix the login flow ')} sessionKey={KEY} />,
    );
    const row = container.querySelector('[data-slot="rename"]');
    expect(row?.textContent).toBe('Title passed to Claude Code: Fix the login flow');
    expect(row?.getAttribute('data-source')).toBe('local');
    expect(screen.queryByText('Command')).toBeNull();
    expect(container.querySelector('.bg-secondary\\/70')).toBeNull();
  });

  it('still queued (no item yet) → the same quiet line, greyed, no message kind; other prompts stay bubbles', () => {
    const queued = render(
      <QueuedPromptRow
        prompt={sampleQueuedPrompt({ text: { text: '/rename Queued title', truncated: null } })}
        sessionKey={KEY}
      />,
    );
    const row = queued.container.querySelector('[data-slot="rename"]');
    expect(row?.textContent).toBe('Title passed to Claude Code: Queued title');
    expect(row?.getAttribute('data-queued')).toBe('true');
    expect(row?.hasAttribute('data-item-kind')).toBe(false);
    queued.unmount();
    const plain = render(<QueuedPromptRow prompt={sampleQueuedPrompt()} sessionKey={KEY} />);
    expect(plain.container.querySelector('[data-slot="rename"]')).toBeNull();
  });

  it('typed in the Claude app → its own text', () => {
    const { container } = render(
      <UserMessageRow item={rename('/rename Release notes', { source: 'remote' })} sessionKey={KEY} />,
    );
    expect(container.querySelector('[data-slot="rename"]')?.textContent).toBe(
      'Renamed in the Claude app: Release notes',
    );
  });

  it('without a title, from someone else or another command → the usual rendering', () => {
    const plain = render(<UserMessageRow item={rename('/rename')} sessionKey={KEY} />);
    expect(plain.container.querySelector('[data-slot="rename"]')).toBeNull();
    expect(screen.getByText('Command')).toBeTruthy();
    plain.unmount();
    const foreign = render(
      <UserMessageRow
        item={rename('/rename Other', { origin: 'other', originKind: 'peer' })}
        sessionKey={KEY}
      />,
    );
    expect(foreign.container.querySelector('[data-origin="other"]')).not.toBeNull();
    expect(foreign.container.querySelector('[data-slot="rename"]')).toBeNull();
    foreign.unmount();
    const other = render(
      <UserMessageRow item={rename('/renamex Title', { slashCommand: '/renamex' })} sessionKey={KEY} />,
    );
    expect(other.container.querySelector('[data-slot="rename"]')).toBeNull();
  });

  it('German texts', () => {
    setLanguage('de');
    const { container, rerender } = render(
      <UserMessageRow item={rename('/rename Neuer Titel')} sessionKey={KEY} />,
    );
    expect(container.textContent).toBe('Titel an Claude Code übergeben: Neuer Titel');
    rerender(<UserMessageRow item={rename('/rename Neuer Titel', { source: 'remote' })} sessionKey={KEY} />);
    expect(container.textContent).toBe('In der Claude-App umbenannt: Neuer Titel');
  });
});
