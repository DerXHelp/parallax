import { XIcon } from 'lucide-react';
import { memo, useEffect, useId, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useT } from '@web/i18n';
import { focusedElement } from '@web/lib/return-focus';
import { IconButton } from '@web/ui/icon-button';
import { useShellRequestHandler, type SidePanelTab } from '../requests';
import { useEscapeHandler } from '../shortcuts';
import { useFeatureSlots } from '../slots';
import {
  closeSidePanel,
  openSidePanel,
  registerSidePanelHost,
  setSidePanelFile,
  useSidePanelFile,
  useSidePanelTab,
} from './state';

/** The content of one tab: the feature slots (placeholders render nothing). */
const TabContent = memo(function TabContent({ sessionKey, tab }: { sessionKey: string; tab: SidePanelTab }) {
  const { PlanPanel, FilePanel, FilesPanel, TasksPanel } = useFeatureSlots();
  const file = useSidePanelFile(sessionKey);
  switch (tab) {
    case 'plan':
      return <PlanPanel sessionKey={sessionKey} />;
    case 'file':
      return file === null ? null : (
        <FilePanel sessionKey={sessionKey} path={file.path} line={file.line} col={file.col} />
      );
    case 'files':
      return <FilesPanel sessionKey={sessionKey} />;
    case 'tasks':
      return <TasksPanel sessionKey={sessionKey} />;
  }
});

/**
 * Side panel of a session pane (Phase 3, ADR-150; WP-50 lifted the frame out of the plan panel):
 * a plain complementary region next to the transcript – non-modal, no focus trap. It holds the open
 * tab per session (state.ts) and serves the shell requests `sidePanel` (open a tab, `null`
 * closes) and `openFile` (viewer tab). Opening by request moves the focus into the panel; Esc
 * inside it or the close button closes it and the focus returns to the element that opened it.
 * The tabs render the feature slots `PlanPanel`, `FilePanel`, `FilesPanel`, `TasksPanel`.
 */
export const SidePanelHost = memo(function SidePanelHost({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const tab = useSidePanelTab(sessionKey);
  const ref = useRef<HTMLElement>(null);
  const id = useId();

  useEffect(() => registerSidePanelHost(sessionKey), [sessionKey]);

  /** Opens `next` from a user action and moves the focus into the panel. */
  const openFromRequest = (next: SidePanelTab) => {
    const opener = focusedElement();
    flushSync(() => {
      openSidePanel(sessionKey, next, opener);
    });
    ref.current?.focus();
  };

  useShellRequestHandler('sidePanel', (request) => {
    if (request.sessionKey !== sessionKey) return false;
    if (request.tab === null) closeSidePanel(sessionKey);
    else openFromRequest(request.tab);
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

  const close = () => {
    closeSidePanel(sessionKey)?.focus();
  };
  useEscapeHandler(
    () => {
      close();
      return true;
    },
    tab !== null,
    { scopeRef: ref },
  );

  if (tab === null) return null;
  const tabId = `${id}-tab`;
  const panelId = `${id}-panel`;

  return (
    <aside
      ref={ref}
      data-side-panel={sessionKey}
      data-slot="side-panel"
      data-tab={tab}
      aria-labelledby={tabId}
      tabIndex={-1}
      className="bg-background focus-visible:ring-ring flex w-[min(42rem,45%)] min-w-72 shrink-0 flex-col border-l outline-none focus-visible:ring-2 focus-visible:ring-inset"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1 pl-2">
        <div role="tablist" aria-label={t('sidePanel.tabs')} className="flex min-w-0 flex-1 items-center">
          <button
            type="button"
            role="tab"
            id={tabId}
            aria-selected
            aria-controls={panelId}
            className="text-ui border-primary h-9 border-b-2 px-2 font-semibold outline-none focus-visible:underline"
          >
            {t(`sidePanel.tab.${tab}`)}
          </button>
        </div>
        <IconButton label={t('sidePanel.close')} onClick={close}>
          <XIcon aria-hidden />
        </IconButton>
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={tabId} className="flex min-h-0 flex-1 flex-col">
        <TabContent sessionKey={sessionKey} tab={tab} />
      </div>
    </aside>
  );
});
