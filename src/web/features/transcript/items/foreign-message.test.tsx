/**
 * WP-72: a message not typed by the user (origin 'other') is one quiet collapsed line with its origin
 * and a preview instead of a user bubble; opening it shows the whole text (en/de).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { UserMessageItem } from '@shared/model';
import { sampleItems } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { resetClientStore } from '@web/state/store';
import { resetExpansion } from '../state/expansion';
import { UserMessageRow } from './MessageRows';

afterEach(() => {
  setLanguage('en');
  resetClientStore();
  resetExpansion();
});

const KEY = 'local:en_00000000000000000000000000000001';

const PEER_TEXT = [
  'Another Claude session sent a message while you were working:',
  '<agent-message from="aae15852b57fcc94e">',
  'Second contract update: re-read the bridge API.',
  'Details follow in the next message.',
  '</agent-message>',
].join('\n');

function foreign(patch: Partial<UserMessageItem> = {}): UserMessageItem {
  return sampleItems.userMessage({
    id: 'px:user:foreign',
    origin: 'other',
    originKind: 'peer',
    priority: null,
    text: { text: PEER_TEXT, truncated: null },
    ...patch,
  });
}

function toggle(container: HTMLElement): HTMLElement {
  const button = container.querySelector<HTMLElement>('button[aria-expanded]');
  if (button === null) throw new Error('no toggle');
  return button;
}

describe('message not typed by the user (WP-72)', () => {
  it('peer → collapsed line with origin and the body as preview, no bubble, no full text', () => {
    const { container } = render(<UserMessageRow item={foreign()} sessionKey={KEY} />);
    const row = container.querySelector('[data-item-kind="user_message"]');
    expect(row?.getAttribute('data-origin')).toBe('other');
    expect(row?.getAttribute('data-origin-kind')).toBe('peer');
    expect(toggle(container).getAttribute('aria-expanded')).toBe('false');
    expect(toggle(container).textContent).toBe(
      'Message from another session · Second contract update: re-read the bridge API.',
    );
    expect(screen.queryByText(/Details follow/)).toBeNull();
    expect(container.querySelector('.bg-secondary\\/70')).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
  });

  it('opening shows the whole text; the choice survives a remount (virtualized list)', () => {
    const first = render(<UserMessageRow item={foreign()} sessionKey={KEY} />);
    fireEvent.click(toggle(first.container));
    expect(screen.getByText(/Details follow in the next message\./)).toBeTruthy();
    first.unmount();
    const second = render(<UserMessageRow item={foreign()} sessionKey={KEY} />);
    expect(toggle(second.container).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/Details follow in the next message\./)).toBeTruthy();
  });

  it('known origins have their own text, unknown and missing kinds the general one', () => {
    const label = (originKind: string | null, text = 'plain text') => {
      const { container, unmount } = render(
        <UserMessageRow item={foreign({ originKind, text: { text, truncated: null } })} sessionKey={KEY} />,
      );
      const value = toggle(container).textContent;
      unmount();
      return value;
    };
    expect(label('coordinator')).toBe('Message from the coordinator · plain text');
    expect(label('task-notification')).toBe('Automatic notification · plain text');
    expect(label('channel')).toBe('Message from a channel · plain text');
    expect(label('observer')).toBe('Not typed by you · plain text');
    expect(label(null)).toBe('Not typed by you · plain text');
    expect(label('constructor')).toBe('Not typed by you · plain text');
  });

  it('German text', () => {
    setLanguage('de');
    const { container } = render(<UserMessageRow item={foreign()} sessionKey={KEY} />);
    expect(toggle(container).textContent).toBe(
      'Nachricht einer anderen Session · Second contract update: re-read the bridge API.',
    );
  });

  it('the user’s own message stays a bubble without an origin hint', () => {
    const { container } = render(
      <UserMessageRow item={sampleItems.userMessage({ id: 'px:user:own', priority: null })} sessionKey={KEY} />,
    );
    const row = container.querySelector('[data-item-kind="user_message"]');
    expect(row?.getAttribute('data-origin')).toBeNull();
    expect(screen.getByText('Say OK.')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
    expect(screen.queryByText(/Not typed by you/)).toBeNull();
  });
});
