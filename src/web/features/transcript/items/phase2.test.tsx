import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { blobPath } from '@shared/http';
import type { ToolResult } from '@shared/model';
import { sampleBlobId, sampleBlobRef, sampleItems, sampleSystemItems, sampleTime } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { formatTime } from '@web/i18n/format';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { previewImages } from '../lib/text';
import { ResultImages } from '../renderers/parts';
import { setBlobSourceResolver } from '../state/blob-source';
import { resetExpansion } from '../state/expansion';
import { UserMessageRow } from './MessageRows';
import { SystemRow } from './SystemRow';
import { ToolCallRow } from './ToolCallRow';

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

describe('rate-limit row: the window translated (V3-13)', () => {
  it.each([
    ['en', 'five_hour', '5-hour limit'],
    ['de', 'five_hour', '5-Stunden-Limit'],
    ['en', 'seven_day', 'weekly limit'],
    ['de', 'overage', 'Zusatznutzung'],
    // An unknown window stays as the SDK sent it.
    ['en', 'brand_new_window', 'brand_new_window'],
  ] as const)('%s %s → %s', (language, window, label) => {
    setLanguage(language);
    const item = sampleSystemItems.rate_limit();
    const { container } = render(
      <SystemRow item={{ ...item, info: { ...item.info, rateLimitType: window } }} sessionKey={KEY} />,
    );
    const text = container.textContent;
    expect(text).toContain(` · ${label}`);
    if (window !== label) expect(text).not.toContain(window);
  });
});

/** A tool result with text parts and pictures (blobs without name and size, as the normalizer stores them). */
function toolResult(texts: readonly string[], blobs: readonly number[]): ToolResult {
  return {
    isError: false,
    content: [
      ...texts.map((text) => ({ type: 'text' as const, text: { text, truncated: null } })),
      ...blobs.map((n) => ({
        type: 'image' as const,
        image: sampleBlobRef({ blobId: sampleBlobId(n), name: null, width: null, height: null }),
      })),
    ],
    structured: null,
    structuredTruncated: null,
    at: sampleTime(5),
  };
}

function thumbs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="image-thumb"]')];
}

/** The tool line's toggle (the first button of the row). */
function toggle(): HTMLElement {
  const button = screen.getAllByRole('button')[0];
  if (button === undefined) throw new Error('no toggle');
  return button;
}

describe('pictures of tool results below the collapsed line, exactly once (R4W-03, V3-09)', () => {
  afterEach(() => {
    resetExpansion();
  });

  it('Read of a screenshot: thumbnail without expanding, named after input.file_path', async () => {
    const item = sampleItems.toolCall({
      id: 'msg_r:Read',
      toolName: 'Read',
      input: { file_path: 'C:\\work\\shots\\fake-shot.png' },
      result: toolResult([], [9]),
    });
    render(
      <TooltipProvider>
        <ToolCallRow item={item} sessionKey={KEY} />
      </TooltipProvider>,
    );
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(thumbs()).toHaveLength(1);
    const thumb = screen.getByRole('button', { name: 'Enlarge image fake-shot.png' });
    expect(within(thumb).getByRole('img').getAttribute('src')).toBe(blobPath(sampleBlobId(9)));
    const user = userEvent.setup();
    await user.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    // Expanded: still one picture, and no "The file is empty." next to it.
    expect(thumbs()).toHaveLength(1);
    expect(screen.queryByText('The file is empty.')).toBeNull();
    await user.click(thumb);
    const dialog = await screen.findByRole('dialog', { name: 'Image: fake-shot.png' });
    expect(within(dialog).getByRole('link', { name: 'Save as…' }).getAttribute('download')).toBe('fake-shot.png');
  });

  it.each([
    [
      'Bash with an image (isImage)',
      sampleItems.toolCall({ id: 'msg_r:Bash', result: toolResult(['saved plot'], [10]) }),
      'saved plot',
    ],
    [
      'an MCP screenshot',
      sampleItems.toolCall({
        id: 'msg_r:mcp',
        toolName: 'mcp__chrome-devtools__take_screenshot',
        input: { fullPage: false },
        result: toolResult(['Took a screenshot of the current page.'], [11, 12]),
      }),
      'Took a screenshot of the current page.',
    ],
  ])('%s: pictures below the line, the expanded body has only the text', async (_label, item, text) => {
    render(
      <TooltipProvider>
        <ToolCallRow item={item} sessionKey={KEY} />
      </TooltipProvider>,
    );
    const count = (item.result?.content ?? []).filter((part) => part.type === 'image').length;
    expect(thumbs()).toHaveLength(count);
    // Without a file path the blobs stay unnamed.
    expect(screen.getAllByRole('button', { name: 'Enlarge image unnamed' })).toHaveLength(count);
    await userEvent.setup().click(toggle());
    expect(await screen.findByText(text)).toBeTruthy();
    expect(thumbs()).toHaveLength(count);
    expect(screen.queryByText('No output')).toBeNull();
  });

  it('only pictures: the expanded body shows no "No output"', async () => {
    const item = sampleItems.toolCall({ id: 'msg_r:only', result: toolResult([], [13]) });
    render(
      <TooltipProvider>
        <ToolCallRow item={item} sessionKey={KEY} />
      </TooltipProvider>,
    );
    await userEvent.setup().click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Command')).toBeTruthy();
    expect(screen.queryByText('No output')).toBeNull();
    expect(thumbs()).toHaveLength(1);
  });

  it('the agent card shows the pictures of its result too (once)', () => {
    const item = sampleItems.toolCall({
      id: 'msg_r:Agent',
      toolName: 'Agent',
      input: { description: 'Take a screenshot', prompt: 'Open the page and take a screenshot.' },
      result: toolResult(['Here is the screenshot.'], [14]),
    });
    render(
      <TooltipProvider>
        <ToolCallRow item={item} sessionKey={KEY} />
      </TooltipProvider>,
    );
    expect(thumbs()).toHaveLength(1);
  });

  it('previewImages: only image types, named after file_path unless the blob has a name; stable per item', () => {
    const item = sampleItems.toolCall({
      toolName: 'Read',
      input: { file_path: '/home/me/a.png' },
      result: {
        ...toolResult([], [15]),
        content: [
          { type: 'image', image: sampleBlobRef({ blobId: sampleBlobId(15), name: null }) },
          { type: 'image', image: sampleBlobRef({ blobId: sampleBlobId(16), name: 'own.png' }) },
          { type: 'image', image: sampleBlobRef({ blobId: sampleBlobId(17), mediaType: 'application/pdf' }) },
        ],
      },
    });
    expect(previewImages(item).map((image) => image.name)).toEqual(['a.png', 'own.png']);
    expect(previewImages(item)).toBe(previewImages(item));
    expect(previewImages(sampleItems.toolCall())).toEqual([]);
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

  it('V3-12: lazy loading only for thumbnails with a known size', () => {
    render(
      <ResultImages
        images={[
          sampleBlobRef({ blobId: sampleBlobId(5), name: 'sized.png', width: 640, height: 480 }),
          sampleBlobRef({ blobId: sampleBlobId(6), name: 'unsized.png', width: null, height: null }),
        ]}
      />,
    );
    const sized = screen.getByRole('img', { name: 'Image: sized.png' });
    expect([sized.getAttribute('loading'), sized.getAttribute('width'), sized.getAttribute('height')]).toEqual([
      'lazy',
      '640',
      '480',
    ]);
    const unsized = screen.getByRole('img', { name: 'Image: unsized.png' });
    expect(unsized.hasAttribute('loading')).toBe(false);
    expect(unsized.hasAttribute('width')).toBe(false);
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
