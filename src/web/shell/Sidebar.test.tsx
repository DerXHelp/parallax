import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resetClientStore } from '@web/state/store';
import { Sidebar, SidebarUpdateNotice } from './Sidebar';
import { FeatureSlotsProvider, type FeatureSlots, type UpdateNoticeSlotProps } from './slots';

afterEach(() => {
  resetClientStore();
});

function FakeUpdateNotice({ compact }: UpdateNoticeSlotProps) {
  return <button type="button">{compact ? 'compact notice' : 'wide notice'}</button>;
}

const UPDATE_SLOTS: Partial<FeatureSlots> = { UpdateNotice: FakeUpdateNotice };

describe('Sidebar: slot UpdateNotice (WP-88b)', () => {
  it('renders the slot in the head of the sidebar, not compact', () => {
    render(
      <FeatureSlotsProvider slots={UPDATE_SLOTS}>
        <Sidebar />
      </FeatureSlotsProvider>,
    );
    const notice = screen.getByRole('button', { name: 'wide notice' });
    expect(notice.closest('[data-slot="update-notice"]')?.hasAttribute('data-compact')).toBe(false);
    // In the head, above the session list.
    const list = document.querySelector('nav');
    expect(list).not.toBeNull();
    if (list !== null) {
      expect(notice.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('passes compact for the rail', () => {
    render(
      <FeatureSlotsProvider slots={UPDATE_SLOTS}>
        <SidebarUpdateNotice compact />
      </FeatureSlotsProvider>,
    );
    const notice = screen.getByRole('button', { name: 'compact notice' });
    expect(notice.closest('[data-slot="update-notice"]')?.getAttribute('data-compact')).toBe('true');
  });

  it('the placeholder leaves an empty frame that hides itself (no gap)', () => {
    render(<Sidebar />);
    const frame = document.querySelector('[data-slot="update-notice"]');
    expect(frame?.childNodes).toHaveLength(0);
    expect(frame?.className).toContain('empty:hidden');
  });
});
