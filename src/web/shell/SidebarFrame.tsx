import { PanelLeftOpenIcon } from 'lucide-react';
import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { focusElement, focusedElement } from '@web/lib/return-focus';
import { flatSidebarOrder, groupedOrder, groupSessions } from '@web/lib/session-order';
import { sessionTitle } from '@web/lib/session-title';
import { useNow } from '@web/state/clock';
import { useSelectedSession, useSummaries } from '@web/state/hooks';
import { IconButton } from '@web/ui/icon-button';
import { StatusIcon } from '@web/ui/status-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { useSidebarMode } from './navigation/sidebar-view';
import { focusSessionInput } from './NewSessionForm';
import { useEscapeHandler } from './shortcuts';
import { Sidebar } from './Sidebar';
import { setSidebarCollapsed, useNarrowWindow, useSidebarCollapsed } from './sidebar-layout';

/**
 * The sidebar for every window width (V3-14, WP-58): expanded (w-72) in a wide window; collapsed
 * into a rail – status icon per session, "Show sessions" – below 900 px window width (always) or
 * when the user collapsed it (remembered per window, sidebar-layout.ts). In a narrow window "Show
 * sessions" opens the sidebar as an overlay (Esc, the backdrop or the collapse button close it, the
 * focus returns to the opener; a chosen session closes it and focuses its message field); in a
 * wide window it expands the sidebar again. The Sidebar stays mounted while collapsed (hidden and
 * inert), so Alt+1…9 and Alt+N keep working; Ctrl+K lives in the NavigationLayer anyway.
 */

/** Focus targets after a layout change (the element that had the focus is gone). */
type PendingFocus = 'rail' | 'sidebar' | null;

function sidebarFocusTarget(frame: HTMLElement | null): HTMLElement | null {
  if (frame === null) return null;
  return (
    frame.querySelector<HTMLElement>('[data-session-row][tabindex="0"]') ??
    frame.querySelector<HTMLElement>('[data-action="collapse-sidebar"]')
  );
}

/** The rail of a collapsed sidebar: "Show sessions" and one status button per session. */
const SidebarRail = memo(function SidebarRail({
  expanded,
  controls,
  onShow,
  showRef,
}: {
  /** The overlay is open (aria-expanded of "Show sessions"). */
  expanded: boolean | undefined;
  controls: string;
  onShow: () => void;
  showRef: (element: HTMLButtonElement | null) => void;
}) {
  const t = useT();
  const entries = useSummaries();
  const now = useNow(30_000);
  const mode = useSidebarMode();
  const [selected, select] = useSelectedSession();
  // Same order as the sidebar (its Alt+1…9 order): flat with pinned first, or by project.
  const order = useMemo(() => {
    const date = new Date(now);
    if (mode === 'grouped') return groupedOrder(groupSessions(entries, date));
    return flatSidebarOrder(entries, date);
  }, [entries, now, mode]);

  return (
    <nav
      aria-label={t('navigation.rail.label')}
      data-slot="sidebar-rail"
      className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-11 shrink-0 flex-col items-center gap-1 border-r py-1.5"
    >
      <IconButton
        ref={showRef}
        label={t('navigation.rail.show')}
        tooltipSide="right"
        size="icon"
        data-action="show-sessions"
        aria-expanded={expanded}
        aria-controls={expanded === undefined ? undefined : controls}
        onClick={onShow}
      >
        <PanelLeftOpenIcon aria-hidden />
      </IconButton>
      <ul
        role="list"
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto pt-1"
      >
        {order.map(({ entry, status }) => {
          const title = sessionTitle(entry.summary);
          const statusText = t(`status.${status.kind}`);
          const label = status.unread
            ? t('navigation.rail.sessionUnread', { title, status: statusText })
            : t('navigation.rail.session', { title, status: statusText });
          const current = entry.sessionKey === selected;
          return (
            <li key={entry.sessionKey} className="relative">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={label}
                    aria-current={current ? 'page' : undefined}
                    data-rail-session={entry.sessionKey}
                    className={cn(
                      'hover:bg-sidebar-accent focus-visible:ring-ring flex size-7 items-center justify-center rounded-md outline-none focus-visible:ring-2',
                      current && 'bg-sidebar-accent',
                    )}
                    onClick={() => {
                      select(entry.sessionKey);
                    }}
                  >
                    <StatusIcon kind={status.kind} iconClassName="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
              {status.unread ? (
                <span
                  aria-hidden
                  className="bg-brand pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full"
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
});

export function SidebarFrame({
  narrow: forcedNarrow,
}: {
  /** Playground: force a narrow (true) or wide (false) window instead of measuring it. */
  narrow?: boolean;
} = {}) {
  const measuredNarrow = useNarrowWindow();
  const narrow = forcedNarrow ?? measuredNarrow;
  const userCollapsed = useSidebarCollapsed();
  const collapsed = narrow || userCollapsed;
  const [overlayOpen, setOverlayOpen] = useState(false);
  const overlay = narrow && overlayOpen;
  const overlayId = useId();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const showRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<PendingFocus>(null);

  // A window that got wide closes the overlay (the sidebar is expanded or collapsed by choice then).
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (wasNarrow !== narrow) {
    setWasNarrow(narrow);
    if (!narrow) setOverlayOpen(false);
  }

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (pending === 'sidebar') focusElement(sidebarFocusTarget(frameRef.current));
    else if (pending === 'rail') focusElement(showRef.current);
  });

  const openOverlay = () => {
    openerRef.current = focusedElement();
    pendingFocus.current = 'sidebar';
    setOverlayOpen(true);
  };

  const closeOverlay = () => {
    const opener = openerRef.current;
    openerRef.current = null;
    setOverlayOpen(false);
    // The opener (the rail's "Show sessions") gets the focus back; else the rail after the render.
    const inside = opener !== null && frameRef.current?.contains(opener) === true;
    if (inside || !focusElement(opener)) pendingFocus.current = 'rail';
  };

  const onShow = () => {
    if (narrow) {
      if (overlayOpen) closeOverlay();
      else openOverlay();
      return;
    }
    pendingFocus.current = 'sidebar';
    setSidebarCollapsed(false);
  };

  const onCollapse = () => {
    if (narrow) {
      closeOverlay();
      return;
    }
    pendingFocus.current = 'rail';
    setSidebarCollapsed(true);
  };

  const onChoose = (sessionKey: string) => {
    openerRef.current = null;
    setOverlayOpen(false);
    focusSessionInput(sessionKey);
  };

  useEscapeHandler(
    () => {
      closeOverlay();
      return true;
    },
    overlay,
  );

  const hidden = collapsed && !overlay;
  let state: 'expanded' | 'collapsed' | 'overlay' = 'expanded';
  if (overlay) state = 'overlay';
  else if (collapsed) state = 'collapsed';

  return (
    <>
      {collapsed ? (
        <SidebarRail
          expanded={narrow ? overlay : undefined}
          controls={overlayId}
          onShow={onShow}
          showRef={(element) => {
            showRef.current = element;
          }}
        />
      ) : null}
      <div
        ref={frameRef}
        id={overlayId}
        data-slot="sidebar-frame"
        data-state={state}
        hidden={hidden}
        inert={hidden}
        className={cn('flex shrink-0', collapsed && 'fixed inset-y-0 left-0 z-50 shadow-xl')}
      >
        <Sidebar onCollapse={onCollapse} onChoose={overlay ? onChoose : undefined} />
      </div>
      {overlay ? (
        <div
          aria-hidden
          data-slot="sidebar-backdrop"
          className="bg-overlay fixed inset-0 z-40"
          onClick={closeOverlay}
        />
      ) : null}
    </>
  );
}
