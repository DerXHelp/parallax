import { FileUpIcon } from 'lucide-react';
import { useEffect, useState, type DragEvent } from 'react';
import { useT } from '@web/i18n';
import { transferFiles } from '@web/lib/transfer-files';
import { showTextNotice } from '@web/state/notices';
import { requestShell } from './requests';

/**
 * Drop zone over the whole session pane (R4W-02, WP-58): files dropped on the transcript, the
 * header or the side panel go to the composer (`attachFiles` request, taken by WP-57) instead of
 * being refused by the window-wide drop guard. A zone of its own inside the pane (the composer)
 * handles its drops first (`preventDefault`); the pane then leaves them alone. Folders are counted
 * and left out like on the composer (`transferFiles`, CR3-01); the composer shows the hint. Without a zone –
 * no session (overview), archived or external entry – the drop guard (drop-guard.ts) refuses the
 * drop as everywhere else.
 */

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

export interface SessionDropZone {
  /** Files are dragged over the pane (outside an inner zone): show the overlay. */
  dragging: boolean;
  /** Handlers for the pane's root element; empty when the zone is disabled. */
  handlers: {
    onDragOver?: (event: DragEvent<HTMLElement>) => void;
    onDragLeave?: (event: DragEvent<HTMLElement>) => void;
    onDrop?: (event: DragEvent<HTMLElement>) => void;
  };
}

export function useSessionDropZone(sessionKey: string, enabled: boolean): SessionDropZone {
  const [dragging, setDragging] = useState(false);
  // `dragover` fires many times a second: React skips a set to the same value.
  const show = setDragging;

  // A zone that went away (archived meanwhile) forgets its drag.
  if (!enabled && dragging) setDragging(false);

  useEffect(() => {
    if (!dragging) return undefined;
    // A drag cancelled (Esc) or finished elsewhere ends without a `dragleave` on the pane.
    const hide = () => {
      setDragging(false);
    };
    window.addEventListener('dragend', hide);
    window.addEventListener('drop', hide);
    return () => {
      window.removeEventListener('dragend', hide);
      window.removeEventListener('drop', hide);
    };
  }, [dragging]);

  if (!enabled) return { dragging: false, handlers: {} };

  return {
    dragging,
    handlers: {
      onDragOver: (event) => {
        if (!hasFiles(event)) return;
        if (event.defaultPrevented) {
          // An inner zone (the composer) takes it and shows its own hint.
          show(false);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        show(true);
      },
      onDragLeave: (event) => {
        const related = event.relatedTarget;
        if (related instanceof Node && event.currentTarget.contains(related)) return;
        show(false);
      },
      onDrop: (event) => {
        show(false);
        if (event.defaultPrevented || !hasFiles(event)) return;
        event.preventDefault();
        // Folders by their entry, like a drop on the composer (CR3-01): Chrome lists a dropped
        // folder in `files` too, as an untyped `File` that would become a failing upload chip.
        const { files, folders } = transferFiles(event.dataTransfer);
        if (files.length === 0 && folders === 0) return;
        if (!requestShell({ kind: 'attachFiles', sessionKey, files, folders })) {
          // No composer took them (e.g. it cannot attach right now).
          showTextNotice('navigation.drop.unavailable', undefined, {
            sessionKey,
            tone: 'warning',
            id: `navigation-drop.${sessionKey}`,
          });
        }
      },
    },
  };
}

/** The subtle overlay while files are dragged over the pane (never takes pointer events). */
export function SessionDropOverlay() {
  const t = useT();
  return (
    <div
      data-slot="session-drop-overlay"
      className="bg-background/70 border-brand pointer-events-none absolute inset-1 z-40 flex items-center justify-center rounded-md border-2 border-dashed"
    >
      <p className="bg-popover text-popover-foreground flex items-center gap-2 rounded-md border px-3 py-1.5 text-ui font-medium shadow-sm">
        <FileUpIcon aria-hidden className="text-brand size-4" />
        {t('navigation.drop.hint')}
      </p>
    </div>
  );
}
