import { lazy, Suspense, useState, type ReactElement } from 'react';
import { Dialog, DialogTrigger } from '@web/ui/dialog';
import { SlotBoundary } from '../SlotBoundary';

/*
 * The dialog content (list, breadcrumbs, keyboard) is a lazy chunk: it is needed only after a click
 * on the trigger, so it stays out of the start chunk (bundle budget `scripts/bundle-budget.ts`,
 * WP-64). Like the lazy dialogs of the NavigationLayer it appears whole once its chunk is there; a
 * failed chunk shows the card of the SlotBoundary instead of unmounting the form.
 */
const FolderBrowserContent = lazy(() => import('./FolderBrowserContent'));

/**
 * Folder browser (ADR-119, WP-36 requirement 2) over the host command `fs.listDirectory`: starts in
 * the given folder when it is a safe absolute path, else at the roots (drives + user folder).
 * Breadcrumbs, "Up" (`parent`), "This PC" (roots), "Show hidden folders"; Enter/double click opens
 * a folder, Backspace (or Alt+↑) goes up, arrows/Home/End/PageUp/PageDown move, typing jumps to a
 * name, Esc closes. "Choose this folder" hands over `listing.path` exactly as the server sent it.
 * The server decides what may be listed (unsafe paths, links, permissions) – its error codes are
 * shown inline. Used by "New session" and by the profile editor (`configDir`).
 */

export interface FolderBrowserProps {
  /** Start folder: used when it is a safe absolute path (`windowsPathIssue`), else the roots. */
  initialPath: string | null;
  onSelect: (path: string) => void;
  /** The trigger, e.g. a "Browse…" button (rendered as is; a click opens the dialog). */
  children: ReactElement;
  /** Start opened (playground). */
  defaultOpen?: boolean;
}

export function FolderBrowser({ initialPath, onSelect, children, defaultOpen = false }: FolderBrowserProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      {open ? (
        <SlotBoundary className="fixed inset-x-0 top-16 z-50">
          <Suspense fallback={null}>
            <FolderBrowserContent
              initialPath={initialPath}
              onChoose={(path) => {
                setOpen(false);
                onSelect(path);
              }}
              onCancel={() => {
                setOpen(false);
              }}
            />
          </Suspense>
        </SlotBoundary>
      ) : null}
    </Dialog>
  );
}
