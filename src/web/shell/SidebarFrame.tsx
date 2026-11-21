import { BellDotIcon, PanelLeftOpenIcon, SquarePenIcon } from 'lucide-react';
import { memo, useId, useLayoutEffect, useRef, useState } from 'react';
import { LOCAL_HOST_ID } from '@shared/common';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { HOST_BG } from '@web/lib/host-colors';
import { focusElement, focusedElement } from '@web/lib/return-focus';
import { sessionTitle } from '@web/lib/session-title';
import { toScreenPx, zoomFactor } from '@web/lib/zoom';
import { useNow } from '@web/state/clock';
import { useSelectedSession, useSummaries } from '@web/state/hooks';
import { useHostLabels } from '@web/state/hosts';
import { useZoom } from '@web/state/zoom';
import { IconButton } from '@web/ui/icon-button';
import { Kbd } from '@web/ui/kbd';
import { Splitter } from '@web/ui/splitter';
import { StatusIcon } from '@web/ui/status-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { ConnectionIndicator } from './ConnectionIndicator';
import { MultiHostIndicator } from './hosts/MultiHostIndicator';
import { RailFilterIndicator } from './navigation/SidebarFilter';
import { NEXT_WAITING_KEYS, useNextWaiting } from './navigation/use-next-waiting';
import { useSidebarLayout } from './navigation/use-sidebar-layout';
import { openNewSession } from './NewSessionDialog';
import { focusSessionInput } from './NewSessionForm';
import { SettingsMenu } from './SettingsMenu';
import { useEscapeHandler, useShortcut } from './shortcuts';
import { Sidebar, SidebarUpdateNotice } from './Sidebar';
import {
  setSidebarCollapsed,
  setSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_SHARE,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_SNAP_WIDTH,
  SIDEBAR_TOGGLE_KEYS,
  useNarrowWindow,
  useSidebarCollapsed,
  useSidebarMaxWidth,
  useSidebarWidth,
} from './sidebar-layout';

/**
 * The sidebar for every window width (V3-14, WP-58): expanded in a wide window (WP-90: width by
 * dragging its right edge, 224–480 px and at most 40 % of the window, default 288 px, double click
 * = default, remembered per window; dragged below the minimum it collapses); collapsed into a rail
 * – "Show sessions", "New session", "Waiting for you", a status icon per session, settings and the
 * connection – below 900 px window width (always) or
 * when the user collapsed it (remembered per window, sidebar-layout.ts). In a narrow window "Show
 * sessions" opens the sidebar as an overlay (Esc, the backdrop or the collapse button close it, the
 * focus returns to the opener; a chosen session closes it and focuses its message field); in a
 * wide window it expands the sidebar again. The Sidebar stays mounted while collapsed (hidden and
 * inert), so Alt+1…9 and Alt+N keep working; Ctrl+K lives in the NavigationLayer anyway. Alt+B
 * collapses or expands it (narrow window: opens or closes the overlay).
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

/**
 * The rail of a collapsed sidebar: "Show sessions", "New session", "Waiting for you" (WP-90, with
 * a counter), one status button per session (WP-71: a working session pulses like its row; WP-90:
 * the color of its computer when other computers are linked), then settings, "Several computers"
 * and the connection.
 */
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
  const [selected, select] = useSelectedSession();
  const hosts = useHostLabels();
  // Same order as the sidebar: flat with pinned first, by project, or (WP-80) by computer – every
  // session, also those of collapsed groups.
  const { layout } = useSidebarLayout(entries, now);
  const waiting = useNextWaiting(layout);

  return (
    <nav
      aria-label={t('navigation.rail.label')}
      data-slot="sidebar-rail"
      className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-11 shrink-0 flex-col items-center gap-1 border-r py-1.5"
    >
      <IconButton
        ref={showRef}
        label={t('navigation.rail.show')}
        shortcut={<Kbd>{SIDEBAR_TOGGLE_KEYS}</Kbd>}
        tooltipSide="right"
        size="icon"
        data-action="show-sessions"
        aria-expanded={expanded}
        aria-controls={expanded === undefined ? undefined : controls}
        onClick={onShow}
      >
        <PanelLeftOpenIcon aria-hidden />
      </IconButton>
      <IconButton
        label={t('shell.sidebar.newSession')}
        tooltipSide="right"
        size="icon"
        data-action="rail-new-session"
        onClick={openNewSession}
      >
        <SquarePenIcon aria-hidden />
      </IconButton>
      {waiting.count > 0 ? (
        <IconButton
          label={t('navigation.rail.waiting', { count: waiting.count })}
          shortcut={<Kbd>{NEXT_WAITING_KEYS}</Kbd>}
          tooltipSide="right"
          size="icon"
          data-action="rail-next-waiting"
          className="text-status-waiting relative"
          onClick={() => {
            waiting.goToNext();
          }}
        >
          <BellDotIcon aria-hidden />
          <span
            aria-hidden
            className="bg-status-waiting text-background absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full px-0.5 text-center text-[0.625rem] leading-[0.875rem] tabular-nums"
          >
            {waiting.count > 9 ? t('navigation.panels.countOverflow', { max: 9 }) : waiting.count}
          </span>
        </IconButton>
      ) : null}
      {/* WP-115: an active list filter is visible in the collapsed sidebar, too. */}
      <RailFilterIndicator />
      {/* WP-87: the update hint as an icon (features/updates; the placeholder renders nothing). */}
      <SidebarUpdateNotice compact />
      <ul
        role="list"
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto pt-1"
      >
        {layout.order.map(({ entry, status }) => {
          const title = sessionTitle(entry.summary);
          const statusText = t(`status.${status.kind}`);
          const host = entry.hostId === LOCAL_HOST_ID ? undefined : hosts.get(entry.hostId);
          const base = status.unread
            ? t('navigation.rail.sessionUnread', { title, status: statusText })
            : t('navigation.rail.session', { title, status: statusText });
          const label =
            host === undefined ? base : t('navigation.rail.sessionOnHost', { label: base, host: host.name });
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
                    <StatusIcon kind={status.kind} pulse iconClassName="size-3.5" />
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
              {host === undefined ? null : (
                <span
                  aria-hidden
                  data-host-color={host.color}
                  className={cn(
                    'ring-sidebar pointer-events-none absolute bottom-0.5 left-0.5 size-1.5 rounded-full ring-1',
                    HOST_BG[host.color],
                  )}
                />
              )}
            </li>
          );
        })}
      </ul>
      <MultiHostIndicator placement="rail" />
      <SettingsMenu placement="rail" />
      <ConnectionIndicator compact />
    </nav>
  );
});

export function SidebarFrame({
  narrow: forcedNarrow,
}: {
  /** Playground: force a narrow (true) or wide (false) window instead of measuring it. */
  narrow?: boolean;
} = {}) {
  const t = useT();
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
  const storedWidth = useSidebarWidth();
  const maxAllowed = useSidebarMaxWidth();
  // WP-92: widths are layout px (CSS px at a 16 px root); the sidebar is drawn at the zoom.
  const zoom = useZoom();
  /** WP-90: the width while the edge is dragged (may go below the minimum: then it collapses). */
  const [dragWidth, setDragWidth] = useState<number | null>(null);

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

  useEscapeHandler(() => {
    closeOverlay();
    return true;
  }, overlay);

  useShortcut({
    id: 'navigation.toggleSidebar',
    keys: SIDEBAR_TOGGLE_KEYS,
    description: 'navigation.shortcuts.toggleSidebar',
    allowInInputs: true,
    run: () => {
      if (narrow) {
        onShow();
        return true;
      }
      // The focus stays where it is (e.g. the message field) unless its element goes away: in the
      // rail it moves into the sidebar, in the sidebar to the rail.
      if (collapsed) {
        const rail = showRef.current?.closest('[data-slot="sidebar-rail"]');
        if (rail?.contains(focusedElement()) === true) pendingFocus.current = 'sidebar';
        setSidebarCollapsed(false);
      } else {
        if (frameRef.current?.contains(focusedElement()) === true) pendingFocus.current = 'rail';
        setSidebarCollapsed(true);
      }
      return true;
    },
  });

  const commitWidth = (value: number) => {
    setDragWidth(null);
    if (value < SIDEBAR_MIN_WIDTH) {
      onCollapse();
      return;
    }
    setSidebarWidth(value);
  };

  const hidden = collapsed && !overlay;
  let state: 'expanded' | 'collapsed' | 'overlay' = 'expanded';
  if (overlay) state = 'overlay';
  else if (collapsed) state = 'collapsed';
  // Expanded: within this window's limit (the handle then names what is shown); the overlay
  // keeps the stored width up to 85 % of the window.
  const liveWidth = collapsed ? storedWidth : Math.min(dragWidth ?? storedWidth, maxAllowed);
  const width = Math.max(SIDEBAR_MIN_WIDTH, liveWidth);
  const willCollapse = dragWidth !== null && dragWidth < SIDEBAR_MIN_WIDTH;
  // The share of the window keeps the session area usable; the overlay may cover most of it.
  const maxWidth = collapsed
    ? '85vw'
    : `max(${String(toScreenPx(SIDEBAR_MIN_WIDTH, zoom))}px, ${String(SIDEBAR_MAX_SHARE * 100)}vw)`;

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
        className={cn('relative flex shrink-0', collapsed && 'fixed inset-y-0 left-0 z-50 shadow-xl')}
      >
        <Sidebar
          onCollapse={onCollapse}
          onChoose={overlay ? onChoose : undefined}
          width={toScreenPx(width, zoom)}
          maxWidth={maxWidth}
          willCollapse={willCollapse}
        />
        {state === 'expanded' ? (
          <Splitter
            value={liveWidth}
            min={SIDEBAR_SNAP_WIDTH}
            max={maxAllowed}
            onChange={setDragWidth}
            onCommit={commitWidth}
            scale={zoomFactor(zoom)}
            label={t('navigation.sidebar.resize')}
            valueText={t('navigation.sidebar.width', { width: Math.round(width) })}
            title={t('navigation.sidebar.resizeHint')}
            data-slot="sidebar-splitter"
            className="absolute inset-y-0 -right-[3px] z-10"
            onDoubleClick={() => {
              setDragWidth(null);
              setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
            }}
          />
        ) : null}
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
