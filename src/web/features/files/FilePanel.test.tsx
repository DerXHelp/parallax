import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { SAMPLE_IDS, sampleFileInfo } from '@shared/samples';
import type { RunningScenario } from '@web/playground/PlaygroundScenario';
import { FeatureSlotsProvider, type FeatureSlots } from '@web/shell/slots';
import { FAKE_FILE_PATHS } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { FilePanel } from './FilePanel';
import { setFileSource } from './state/file-source';
import { FILE_POLL_MS } from './state/file-document';
import { fakeHostFileSource, FILES_SESSION_KEY, installResizeObserver, startFilesScenario } from './testing';

// 0.1–0.6 s per test alone, but up to 13 s when several runs load the machine: lazy chunks (code
// view, PDF frame, highlighter), user-event clicks and the lightbox (V4: 3 of 3 runs under load red
// at the 5 s default; R5W-04, docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 30_000 });

/** Waiting for the content of a lazy chunk. */
const LAZY = { timeout: 15_000 };

const SLOTS: Partial<FeatureSlots> = {
  Markdown: ({ text, baseDir }) => (
    <div data-testid="markdown" data-base-dir={baseDir}>
      {text}
    </div>
  ),
};

let running: RunningScenario;
let restoreResizeObserver: () => void;
let visibility: DocumentVisibilityState = 'visible';
const ownVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function statCount(): number {
  return running.host.commands.filter((cmd) => cmd.name === 'file.stat').length;
}

/** Lets the command answers (MemoryTransport: microtasks) and the source promises settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve();
  });
}

function renderPanel(path: string, position: { line?: number | null; col?: number | null } = {}) {
  return render(
    <TooltipProvider>
      <FeatureSlotsProvider slots={SLOTS}>
        <FilePanel
          sessionKey={FILES_SESSION_KEY}
          path={path}
          line={position.line ?? null}
          col={position.col ?? null}
        />
      </FeatureSlotsProvider>
    </TooltipProvider>,
  );
}

beforeAll(async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  // Load the lazy chunks once up front: their import cost lands in the hook, not in the first test.
  await Promise.all([import('./components/CodeView'), import('./components/PdfView')]);
}, 120_000);

afterAll(() => {
  Reflect.deleteProperty(document, 'visibilityState');
  if (ownVisibility !== undefined) Object.defineProperty(document, 'visibilityState', ownVisibility);
});

beforeEach(() => {
  visibility = 'visible';
  restoreResizeObserver = installResizeObserver();
  running = startFilesScenario();
  setFileSource(fakeHostFileSource(running.host));
});

afterEach(() => {
  // Unmount first: a re-render after setFileSource(null) would point <iframe>/<img> at /api/file.
  cleanup();
  vi.useRealTimers();
  setFileSource(null);
  running.stop();
  resetClientStore();
  restoreResizeObserver();
});

describe('FilePanel (WP-54, ADR-142/143)', () => {
  it('Markdown: rendered through the slot with the folder as baseDir, source in the code view', async () => {
    const user = userEvent.setup();
    renderPanel(FAKE_FILE_PATHS.guide);
    const markdown = await screen.findByTestId('markdown');
    expect(markdown.getAttribute('data-base-dir')).toBe('D:\\work\\sample\\docs');
    expect(markdown.textContent).toContain('Back to the [README](../README.md).');
    const panel = screen.getByRole('region', { name: 'File viewer' });
    expect(panel.getAttribute('data-kind')).toBe('markdown');
    const meta = panel.querySelector('[data-slot="file-panel-meta"]');
    // Sizes like everywhere (@web/lib/bytes: decimal, long unit below 1000; V4-06 a).
    expect(meta?.textContent).toMatch(/^Markdown·\d{1,3} bytes·Modified .+RenderedSource$/);
    await user.click(screen.getByRole('radio', { name: 'Source' }));
    const code = await screen.findByRole('region', { name: 'Content of guide.md' }, LAZY);
    expect(within(code).getByText('# Guide')).toBeTruthy();
    expect(screen.queryByTestId('markdown')).toBeNull();
  });

  it('text: virtualized code view with line numbers; a line jump marks the row and focuses the view', async () => {
    renderPanel(FAKE_FILE_PATHS.main, { line: 11, col: 4 });
    const code = await screen.findByRole('region', { name: 'Content of main.ts' }, LAZY);
    await waitFor(() => {
      expect(code.querySelector('[data-line="11"]')).not.toBeNull();
    }, LAZY);
    const row = code.querySelector('[data-line="11"]');
    expect(row?.getAttribute('aria-current')).toBe('true');
    expect(row?.textContent).toBe(
      "11const DEFAULTS: Options = { name: 'world', verbose: false, retries: 3 };",
    );
    expect(code.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    // The column of the target is marked on that row only (R5W-10).
    const marks = code.querySelectorAll('[data-slot="code-column"]');
    expect(marks).toHaveLength(1);
    expect(row?.contains(marks[0] ?? null)).toBe(true);
    expect(marks[0]?.getAttribute('data-col')).toBe('4');
    expect(document.activeElement).toBe(code);
    // Fewer rows than lines: the list is virtualized.
    expect(code.querySelectorAll('[data-line]').length).toBeLessThan(40);
  });

  it('a cut text shows the hint; the big log stays plain text (above the highlighting limit)', async () => {
    renderPanel(FAKE_FILE_PATHS.log);
    const code = await screen.findByRole('region', { name: 'Content of build.log' }, LAZY);
    expect(code.getAttribute('data-highlighted')).toBeNull();
    const hint = document.querySelector('[data-slot="file-truncated"]');
    // LIMITS.fileTextBytes = 2 MiB = 2 097 152 bytes, in decimal units like every size display.
    expect(hint?.textContent).toContain('Shortened – only the first 2.1 MB are shown.');
    await waitFor(() => {
      expect(code.querySelector('[data-line="1"]')?.textContent).toContain('step 1 of 6000');
    });
  });

  it('image: <img> of the file URL, fit/100 %, opens the lightbox', async () => {
    const user = userEvent.setup();
    renderPanel(FAKE_FILE_PATHS.image);
    const image = await screen.findByRole('img', { name: 'diagram.png' }, LAZY);
    expect(image.getAttribute('src')).toBe(`fake:///${encodeURIComponent(FAKE_FILE_PATHS.image)}`);
    expect(image.getAttribute('data-mode')).toBe('fit');
    await user.click(screen.getByRole('radio', { name: 'Actual size (100 %)' }));
    expect(screen.getByRole('img', { name: 'diagram.png' }).getAttribute('data-mode')).toBe('actual');
    await user.click(screen.getByRole('button', { name: 'Open diagram.png in the lightbox' }));
    expect(await screen.findByRole('dialog', undefined, LAZY)).toBeTruthy();
  });

  it('PDF: iframe without sandbox, fallbacks "Download" and "Open with default program"', async () => {
    const user = userEvent.setup();
    // Note: happy-dom never loads frames and logs one NotSupportedError for the iframe (harmless).
    renderPanel(FAKE_FILE_PATHS.pdf);
    const frame = await screen.findByTitle('PDF spec.pdf', undefined, LAZY);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.hasAttribute('sandbox')).toBe(false);
    expect(frame.getAttribute('src')).toBe(`fake:///${encodeURIComponent(FAKE_FILE_PATHS.pdf)}`);
    const download = screen.getByRole('link', { name: 'Download' });
    expect(download.getAttribute('download')).toBe('spec.pdf');
    const pdfView = document.querySelector<HTMLElement>('[data-slot="pdf-view"]');
    if (pdfView === null) throw new Error('pdf view missing');
    await user.click(within(pdfView).getByRole('button', { name: 'Open with default program' }));
    expect(running.host.fileOpens).toEqual([
      {
        name: 'file.open',
        entryId: SAMPLE_IDS.entry,
        path: FAKE_FILE_PATHS.pdf,
        target: 'default',
        line: null,
        col: null,
      },
    ]);
  });

  it('binary file and folder: no preview, the actions instead', async () => {
    const view = renderPanel(FAKE_FILE_PATHS.binary);
    expect(await screen.findByText('No preview for this file.')).toBeTruthy();
    const noPreview = document.querySelector<HTMLElement>('[data-slot="file-no-preview"]');
    if (noPreview === null) throw new Error('no preview missing');
    expect(
      within(noPreview)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Open in editor', 'Show in Explorer', 'Copy path']);
    view.unmount();
    renderPanel(FAKE_FILE_PATHS.folder);
    expect(await screen.findByText('This is a folder.')).toBeTruthy();
    const folder = document.querySelector<HTMLElement>('[data-slot="file-no-preview"]');
    if (folder === null) throw new Error('no preview missing');
    expect(
      within(folder)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Show in Explorer', 'Copy path']);
  });

  it('errors: Alert role="alert" with the translated code; "Try again" asks again', async () => {
    // No 2 s poll in between (a slow run would count its file.stat too).
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const user = userEvent.setup();
    renderPanel(FAKE_FILE_PATHS.outside);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The file could not be shown');
    expect(alert.textContent).not.toContain('PATH_NOT_ALLOWED');
    const before = statCount();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await settle();
    expect(statCount()).toBe(before + 1);
  });

  it('a failed content load keeps the metadata and shows the error', async () => {
    setFileSource({ ...fakeHostFileSource(running.host), text: () => Promise.reject(new Error('boom')) });
    renderPanel(FAKE_FILE_PATHS.main);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The file could not be shown');
    expect(document.querySelector('[data-slot="file-panel-meta"]')?.textContent).toContain('Text');
  });

  it('polls file.stat every 2 s only while the page is visible; a change loads the content again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderPanel(FAKE_FILE_PATHS.image);
    const first = await screen.findByRole('img', { name: 'diagram.png' });
    const initial = statCount();
    expect(initial).toBeGreaterThanOrEqual(1);
    act(() => {
      vi.advanceTimersByTime(FILE_POLL_MS);
    });
    await settle();
    expect(statCount()).toBe(initial + 1);
    // Unchanged: the same image element stays.
    expect(screen.getByRole('img', { name: 'diagram.png' })).toBe(first);

    setVisibility('hidden');
    act(() => {
      vi.advanceTimersByTime(FILE_POLL_MS * 3);
    });
    await settle();
    expect(statCount()).toBe(initial + 1);

    running.host.touchFile(FAKE_FILE_PATHS.image);
    setVisibility('visible');
    await settle();
    // Visible again: one check right away; the change remounts the image (new key).
    expect(statCount()).toBe(initial + 2);
    expect(screen.getByRole('img', { name: 'diagram.png' })).not.toBe(first);
    act(() => {
      vi.advanceTimersByTime(FILE_POLL_MS);
    });
    await settle();
    expect(statCount()).toBe(initial + 3);
  });

  it('reloads at once when a write tool on the same file finishes; the refresh button reloads too', async () => {
    const user = userEvent.setup();
    renderPanel(FAKE_FILE_PATHS.main);
    const code = await screen.findByRole('region', { name: 'Content of main.ts' }, LAZY);
    await waitFor(() => {
      expect(code.querySelector('[data-line="1"]')).not.toBeNull();
    }, LAZY);
    running.host.touchFile(FAKE_FILE_PATHS.main, { text: 'export const changed = true;' });
    act(() => {
      running.host.emitFileToolCall(SAMPLE_IDS.entry, {
        toolName: 'Edit',
        path: FAKE_FILE_PATHS.main.toLowerCase(),
      });
    });
    await waitFor(() => {
      expect(code.querySelector('[data-line="1"]')?.textContent).toBe('1export const changed = true;');
    });
    expect(code.querySelector('[data-line="2"]')).toBeNull();
    // The same view stays (scroll position kept).
    expect(screen.getByRole('region', { name: 'Content of main.ts' })).toBe(code);

    running.host.touchFile(FAKE_FILE_PATHS.main, { text: 'export const again = 1;' });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(code.querySelector('[data-line="1"]')?.textContent).toBe('1export const again = 1;');
    });
  });

  it('header: refresh, editor, Explorer, copy path; default program only for allowed extensions', async () => {
    renderPanel(FAKE_FILE_PATHS.readme);
    await screen.findByTestId('markdown');
    const header = document.querySelector<HTMLElement>('[data-slot="file-panel-header"]');
    if (header === null) throw new Error('header missing');
    expect(
      within(header)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Refresh', 'Open in editor', 'Show in Explorer', 'Open with default program', 'Copy path']);
    expect(within(header).getByRole('heading').textContent).toBe('README.mdD:\\work\\sample');
  });

  it('a long path: the name stays whole, the folder is shortened from the start (V4-06 b)', async () => {
    const deep = 'D:\\work\\sample\\docs\\a folder with a long name\\Projekt mit Leerzeichen äöü\\notes.md';
    running.host.setFile({
      info: {
        ...(running.host.file(FAKE_FILE_PATHS.guide)?.info ?? sampleFileInfo()),
        path: deep,
        realPath: deep,
      },
      text: () => '# Notes',
    });
    renderPanel(deep);
    await screen.findByTestId('markdown');
    const title = document.querySelector<HTMLElement>('[data-slot="file-panel-title"]');
    if (title === null) throw new Error('title missing');
    const [name, folder] = [...title.children];
    expect(name?.textContent).toBe('notes.md');
    expect(name?.className).toContain('shrink-0');
    // The whole folder (no fixed tail), as one left-to-right run in a right-to-left box: the
    // ellipsis lands at the start, the nearest folder stays visible.
    expect(folder?.getAttribute('data-slot')).toBe('path-text');
    expect(folder?.className).toContain('[direction:rtl]');
    expect(folder?.className).toContain('truncate');
    const run = folder?.querySelector('bdi');
    expect(run?.getAttribute('dir')).toBe('ltr');
    expect(run?.textContent).toBe(
      'D:\\work\\sample\\docs\\a folder with a long name\\Projekt mit Leerzeichen äöü',
    );
  });

  it('a deleted file: the error, and the metadata/content below are marked as the last known state (V4-06 c)', async () => {
    // No 2 s poll in between: it would take the prepared failure before the refresh click does.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const user = userEvent.setup();
    renderPanel(FAKE_FILE_PATHS.main);
    const code = await screen.findByRole('region', { name: 'Content of main.ts' }, LAZY);
    await waitFor(() => {
      expect(code.querySelector('[data-line="1"]')).not.toBeNull();
    }, LAZY);
    const panel = screen.getByRole('region', { name: 'File viewer' });
    expect(panel.hasAttribute('data-stale')).toBe(false);
    expect(document.querySelector('[data-slot="file-panel-stale"]')).toBeNull();

    running.host.failNext('file.stat', makeError('FILE_NOT_FOUND'));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The file could not be shown');
    expect(panel.getAttribute('data-stale')).toBe('true');
    const meta = document.querySelector('[data-slot="file-panel-meta"]');
    expect(meta?.firstElementChild?.textContent).toBe('Last known state');
    // The older content stays readable below.
    expect(screen.getByRole('region', { name: 'Content of main.ts' })).toBe(code);

    // Back on disk: current again.
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(panel.hasAttribute('data-stale')).toBe(false);
    expect(document.querySelector('[data-slot="file-panel-stale"]')).toBeNull();
  });
});
