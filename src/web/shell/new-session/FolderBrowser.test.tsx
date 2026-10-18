import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@web/i18n';
import { resetClientStore } from '@web/state/store';
import { Button } from '@web/ui/button';
import { TooltipProvider } from '@web/ui/tooltip';
import { startNewSessionDemo, type NewSessionDemo } from './demo-host';
import { FolderBrowser } from './FolderBrowser';

// Dialog + many key strokes: a few seconds in a full `pnpm test`, more when several runs load the
// machine (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 60_000 });

let demo: NewSessionDemo | null = null;

afterEach(() => {
  demo?.stop();
  demo = null;
  resetClientStore();
  act(() => {
    setLanguage('en');
  });
});

async function open(initialPath: string | null) {
  demo = startNewSessionDemo({ immediate: true });
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <FolderBrowser initialPath={initialPath} onSelect={onSelect}>
        <Button>Browse</Button>
      </FolderBrowser>
    </TooltipProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'Browse' }));
  const dialog = await screen.findByRole('dialog', { name: 'Choose a folder' });
  return { dialog, onSelect, user, running: demo };
}

function list(): HTMLElement {
  return screen.getByRole('listbox');
}

function listings(running: NewSessionDemo): (string | null)[] {
  return running.commands('fs.listDirectory').map((cmd) => cmd.path);
}

async function waitForPath(path: string) {
  await waitFor(() => {
    expect(list().getAttribute('data-path')).toBe(path);
  });
}

function activeName(): string | null {
  const id = list().getAttribute('aria-activedescendant');
  return id === null ? null : (document.getElementById(id)?.textContent ?? null);
}

describe('FolderBrowser (ADR-119)', () => {
  it('starts at the roots without a valid start folder and never lists an unsafe path', async () => {
    const { running } = await open('\\\\server\\share');
    await waitFor(() => {
      expect(within(list()).getAllByRole('option')).toHaveLength(3);
    });
    expect(screen.getByRole('listbox', { name: 'Drives and user folder' })).toBeTruthy();
    expect(within(list()).getByRole('option', { name: /user.*User folder/ })).toBeTruthy();
    expect(listings(running)).toEqual([null]);
    // "Choose this folder" needs an opened folder.
    expect(screen.getByRole('button', { name: 'Choose this folder' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Up one level' })).toHaveProperty('disabled', true);
  });

  it('keeps the end of a long breadcrumb bar (the open folder) in view (V3-01)', async () => {
    // happy-dom has no layout: the bar pretends to be wider than its box.
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(900);
    try {
      const { user } = await open('D:\\work');
      await waitForPath('D:\\work');
      const bar = screen.getByRole('navigation', { name: 'Location' });
      await waitFor(() => {
        expect(bar.scrollLeft).toBe(900);
      });
      // Opening a subfolder keeps following the open folder.
      bar.scrollLeft = 0;
      await user.dblClick(within(list()).getByRole('option', { name: /parallax/ }));
      await waitForPath('D:\\work\\parallax');
      expect(bar.scrollLeft).toBe(900);
    } finally {
      scrollWidth.mockRestore();
    }
  });

  it('starts in the typed folder, hides hidden folders until switched on', async () => {
    const { running, user } = await open('D:\\work');
    await waitForPath('D:\\work');
    const names = () => within(list()).getAllByRole('option').map((option) => option.getAttribute('data-path'));
    expect(names()).toEqual(['D:\\work\\api', 'D:\\work\\locked', 'D:\\work\\parallax', 'D:\\work\\sample', 'D:\\work\\web']);
    expect(within(list()).getByRole('option', { name: /sample.*Link/ })).toBeTruthy();
    expect(document.activeElement).toBe(list());
    await user.click(screen.getByRole('switch', { name: 'Show hidden folders' }));
    await waitFor(() => {
      expect(names()).toContain('D:\\work\\.git-hooks');
    });
    expect(running.commands('fs.listDirectory').at(-1)).toEqual({
      name: 'fs.listDirectory',
      path: 'D:\\work',
      showHidden: true,
    });
  });

  it('is fully keyboard operable: arrows, Enter opens, Backspace goes up to the folder it came from', async () => {
    const { user } = await open('D:\\work');
    await waitForPath('D:\\work');
    expect(activeName()).toContain('api');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(activeName()).toContain('parallax');
    await user.keyboard('{Enter}');
    await waitForPath('D:\\work\\parallax');
    expect(activeName()).toContain('docs');
    await user.keyboard('{End}');
    expect(activeName()).toContain('src');
    await user.keyboard('{Home}');
    expect(activeName()).toContain('docs');
    await user.keyboard('{Backspace}');
    await waitForPath('D:\\work');
    expect(activeName()).toContain('parallax');
    // Typing jumps to a name.
    await user.keyboard('w');
    expect(activeName()).toContain('web');
    await user.keyboard('{Backspace}');
    await waitForPath('D:\\');
    await user.keyboard('{Backspace}');
    await waitFor(() => {
      expect(list().getAttribute('data-path')).toBe('');
    });
    // At the roots the drive we came from is highlighted.
    expect(activeName()).toContain('D:');
  });

  it('opens with a double click, goes up and jumps through the breadcrumbs', async () => {
    const { user } = await open('D:\\work');
    await waitForPath('D:\\work');
    await user.dblClick(within(list()).getByRole('option', { name: /parallax/ }));
    await waitForPath('D:\\work\\parallax');
    await user.dblClick(within(list()).getByRole('option', { name: /src/ }));
    await waitForPath('D:\\work\\parallax\\src');
    const location = screen.getByRole('navigation', { name: 'Location' });
    expect(within(location).getByRole('button', { name: 'src' }).getAttribute('aria-current')).toBe('location');
    await user.click(within(location).getByRole('button', { name: 'work' }));
    await waitForPath('D:\\work');
    await user.click(screen.getByRole('button', { name: 'Up one level' }));
    await waitForPath('D:\\');
    await user.click(within(location).getByRole('button', { name: 'This PC' }));
    await waitFor(() => {
      expect(list().getAttribute('data-path')).toBe('');
    });
  });

  it('shows server errors inline and stays in the folder', async () => {
    const { user } = await open('D:\\work');
    await waitForPath('D:\\work');
    await user.dblClick(within(list()).getByRole('option', { name: /locked/ }));
    expect(await screen.findByText('This folder cannot be read (no permission).')).toBeTruthy();
    expect(list().getAttribute('data-path')).toBe('D:\\work');
    // The next successful listing clears the error.
    await user.dblClick(within(list()).getByRole('option', { name: /api/ }));
    await waitForPath('D:\\work\\api');
    expect(screen.queryByText('This folder cannot be read (no permission).')).toBeNull();
  });

  it('falls back to the roots when the start folder is gone (error stays visible)', async () => {
    const { running } = await open('D:\\gone');
    expect(await screen.findByText('The folder does not exist.')).toBeTruthy();
    await waitFor(() => {
      expect(within(list()).getAllByRole('option')).toHaveLength(3);
    });
    expect(listings(running)).toEqual(['D:\\gone', null]);
  });

  it('says when the listing is truncated', async () => {
    await open('D:\\archive');
    await waitForPath('D:\\archive');
    expect(screen.getByText('Only the first 2,000 folders are shown.')).toBeTruthy();
  });

  it('hands over the open folder exactly as the server spelled it', async () => {
    const { onSelect, user } = await open('d:/WORK');
    await waitForPath('d:/WORK');
    await user.dblClick(within(list()).getByRole('option', { name: /parallax/ }));
    await waitForPath('d:/WORK/parallax');
    await user.click(screen.getByRole('button', { name: 'Choose this folder' }));
    expect(onSelect).toHaveBeenCalledWith('d:/WORK/parallax');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('Esc closes without choosing', async () => {
    const { onSelect, user } = await open('D:\\work');
    await waitForPath('D:\\work');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('speaks German', async () => {
    act(() => {
      setLanguage('de');
    });
    await (async () => {
      demo = startNewSessionDemo({ immediate: true });
      const user = userEvent.setup();
      render(
        <FolderBrowser initialPath="D:\work\locked" onSelect={() => undefined}>
          <Button>Browse</Button>
        </FolderBrowser>,
      );
      await user.click(screen.getByRole('button', { name: 'Browse' }));
    })();
    expect(await screen.findByRole('dialog', { name: 'Ordner wählen' })).toBeTruthy();
    expect(await screen.findByText('Dieser Ordner kann nicht gelesen werden (keine Berechtigung).')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Diesen Ordner wählen' })).toBeTruthy();
  });
});
