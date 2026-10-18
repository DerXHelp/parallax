import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { blobPath } from '@shared/http';
import { sampleBlobId, sampleBlobRef, sampleItems, sampleSystemItems, sampleTime } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { formatTime } from '@web/i18n/format';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { ResultImages } from '../renderers/parts';
import { setBlobSourceResolver } from '../state/blob-source';
import { UserMessageRow } from './MessageRows';
import { SystemRow } from './SystemRow';

afterEach(() => {
  setBlobSourceResolver(null);
  setLanguage('en');
  resetClientStore();
});

const KEY = 'local:en_00000000000000000000000000000001';

describe('handoff row (ADR-104, WP-37 §8)', () => {
  it.each([
    [{ phase: 'external' as const, importedItems: 0 }, 'Opened in an external console'],
    [{ phase: 'returned' as const, importedItems: 1 }, 'Back from the console – 1 entry taken over'],
    [{ phase: 'returned' as const, importedItems: 7 }, 'Back from the console – 7 entries taken over'],
    [{ phase: 'returned' as const, importedItems: 0 }, 'Back from the console – no new entries taken over'],
  ])('%j', (patch, text) => {
    const item = sampleSystemItems.handoff({ ...patch, at: sampleTime(90) });
    const { container } = render(<SystemRow item={item} sessionKey={KEY} />);
    const row = container.querySelector(`[data-slot="handoff-${patch.phase}"]`);
    expect(row?.textContent).toBe(`${text} · ${formatTime(sampleTime(90), 'en')}`);
    // Readable (no separator role that would hide the label).
    expect(screen.getByText(new RegExp(text))).toBeTruthy();
  });

  it('German texts', () => {
    setLanguage('de');
    render(
      <SystemRow
        item={sampleSystemItems.handoff({ phase: 'returned', importedItems: 3 })}
        sessionKey={KEY}
      />,
    );
    expect(screen.getByText(/Aus der Konsole zurück – 3 Einträge übernommen/)).toBeTruthy();
  });
});

describe('image thumbnails open the lightbox (WP-37 §8)', () => {
  it('tool result images: enlarge, "Save as" downloads the blob with its name', async () => {
    const image = sampleBlobRef({ blobId: sampleBlobId(5), name: 'page.png', width: 1280, height: 800 });
    render(
      <TooltipProvider>
        <ResultImages images={[image]} />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    const thumb = screen.getByRole('button', { name: 'Enlarge image page.png' });
    expect(within(thumb).getByRole('img', { name: 'Image: page.png' }).getAttribute('src')).toBe(
      blobPath(sampleBlobId(5)),
    );
    await user.click(thumb);
    const dialog = await screen.findByRole('dialog', { name: 'Image: page.png' });
    const save = within(dialog).getByRole('link', { name: 'Save as…' });
    expect(save.getAttribute('href')).toBe(blobPath(sampleBlobId(5)));
    expect(save.getAttribute('download')).toBe('page.png');
    expect(within(dialog).getByRole('button', { name: 'Zoom in (+)' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(thumb);
  });

  it('attachments of a user message; unnamed blobs get a generated file name; a resolver may supply the source', async () => {
    setBlobSourceResolver((blobId) =>
      blobId === sampleBlobId(6) ? 'data:image/png;base64,iVBORw0KGgo=' : null,
    );
    const item = sampleItems.userMessage({
      attachments: [sampleBlobRef({ blobId: sampleBlobId(6), name: null })],
    });
    render(
      <TooltipProvider>
        <UserMessageRow item={item} sessionKey={KEY} />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Enlarge image unnamed' }));
    const save = await screen.findByRole('link', { name: 'Save as…' });
    expect(save.getAttribute('href')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(save.getAttribute('download')).toBe(`image-${sampleBlobId(6).slice(0, 12)}.png`);
  });
});
