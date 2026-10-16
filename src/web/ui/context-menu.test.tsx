import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from './context-menu';

function Menu({ onRename, onArchive }: { onRename: () => void; onArchive: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button">Row</button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>Session</ContextMenuLabel>
        <ContextMenuItem onSelect={onRename}>
          Rename
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" disabled onSelect={onArchive}>
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

describe('ContextMenu (ui)', () => {
  it('opens on right click (contextmenu event) and runs the chosen item', async () => {
    const onRename = vi.fn();
    const onArchive = vi.fn();
    const user = userEvent.setup();
    render(<Menu onRename={onRename} onArchive={onArchive} />);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Row' }));
    const menu = await screen.findByRole('menu');
    expect(menu.dataset.slot).toBe('context-menu-content');
    const archive = screen.getByRole('menuitem', { name: 'Archive' });
    expect(archive.dataset.variant).toBe('destructive');
    expect(archive.hasAttribute('data-disabled')).toBe(true);
    await user.click(screen.getByRole('menuitem', { name: /Rename/ }));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes with Esc', async () => {
    const user = userEvent.setup();
    render(<Menu onRename={vi.fn()} onArchive={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Row' }));
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
