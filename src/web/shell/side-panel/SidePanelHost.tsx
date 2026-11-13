import { lazy, memo, Suspense, useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { focusedElement } from '@web/lib/return-focus';
import { useShellRequestHandler, type SidePanelTab } from '../requests';
import { useEscapeHandler } from '../shortcuts';
import {
  closeSidePanel,
  openSidePanel,
  registerSidePanelHost,
  setSidePanelFile,
  setSidePanelSubagent,
  useSidePanelTab,
} from './state';

/**
 * The frame (tabs, splitter, width, history, overlay) is a lazy chunk – the Phase 3 start-chunk
 * budget (WP-50/WP-60): the host itself only serves the requests. Every host preloads it when it
 * mounts, so a click finds it loaded (like `preloadMarkdown`); a failed chunk reaches the nearest
 * error boundary when the panel renders.
 */
const loadFrame = () => import('./SidePanelFrame');
const SidePanelFrame = lazy(loadFrame);

/**
 * Side panel of a session pane (Phase 3, ADR-150; WP-50 lifted the frame out of the plan panel,
 * WP-54 added tabs, splitter, viewer history and the overlay): a plain complementary region next
 * to the transcript – non-modal, no focus trap. It holds the open tab per session (state.ts) and
 * serves the shell requests `sidePanel` (open a tab, `null` closes), `openFile` (viewer tab) and
 * `openSubagent` (WP-69: the transcript of one subagent).
 * Opening by request moves the focus into the panel (once the frame is there); Esc inside it or the
 * close button closes it and the focus returns to the element that opened it. The tabs render the
 * feature slots `PlanPanel`, `FilePanel`, `FilesPanel`, `TasksPanel`, `SubagentPanel`; only the
 * active tab is mounted.
 */
export const SidePanelHost = memo(function SidePanelHost({ sessionKey }: { sessionKey: string }) {
  const tab = useSidePanelTab(sessionKey);
  const ref = useRef<HTMLElement | null>(null);
  /** A request opened the panel before its frame was there: focus the frame when it attaches. */
  const focusPendingRef = useRef(false);

  useEffect(() => registerSidePanelHost(sessionKey), [sessionKey]);
  useEffect(() => {
    // Preload only; a failure shows up when the frame renders (lazy loads again).
    loadFrame().catch(() => undefined);
  }, []);

  const attachAside = useCallback((element: HTMLElement | null) => {
    ref.current = element;
    if (element !== null && focusPendingRef.current) {
      focusPendingRef.current = false;
      element.focus();
    }
  }, []);

  /** Opens `next` from a user action and moves the focus into the panel. */
  const openFromRequest = (next: SidePanelTab) => {
    const opener = focusedElement();
    // Already inside the panel (a link in the files tab): keep the original opener.
    const inside = opener !== null && ref.current?.contains(opener) === true;
    focusPendingRef.current = true;
    flushSync(() => {
      openSidePanel(sessionKey, next, inside ? null : opener);
    });
    if (ref.current !== null) {
      focusPendingRef.current = false;
      ref.current.focus();
    }
  };

  const close = () => {
    focusPendingRef.current = false;
    closeSidePanel(sessionKey)?.focus();
  };

  useShellRequestHandler('sidePanel', (request) => {
    if (request.sessionKey !== sessionKey) return false;
    if (request.tab === null) {
      focusPendingRef.current = false;
      closeSidePanel(sessionKey);
    } else {
      openFromRequest(request.tab);
    }
    return true;
  });

  useShellRequestHandler('openFile', (request) => {
    if (request.sessionKey !== sessionKey) return false;
    setSidePanelFile(sessionKey, {
      path: request.path,
      line: request.line ?? null,
      col: request.col ?? null,
    });
    openFromRequest('file');
    return true;
  });

  // WP-69: the Agent card's "Open transcript" – the tab shows the latest subagent.
  useShellRequestHandler('openSubagent', (request) => {
    if (request.sessionKey !== sessionKey) return false;
    setSidePanelSubagent(sessionKey, {
      agentId: request.agentId,
      title: request.title,
      subagentType: request.subagentType ?? null,
    });
    openFromRequest('subagent');
    return true;
  });

  useEscapeHandler(
    () => {
      close();
      return true;
    },
    tab !== null,
    { scopeRef: ref },
  );

  if (tab === null) return null;
  return (
    <Suspense fallback={null}>
      <SidePanelFrame sessionKey={sessionKey} tab={tab} asideRef={attachAside} onClose={close} />
    </Suspense>
  );
});
