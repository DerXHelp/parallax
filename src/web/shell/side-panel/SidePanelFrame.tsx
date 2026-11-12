import { ArrowLeftIcon, HistoryIcon, XIcon } from 'lucide-react';
import { memo, useLayoutEffect, useRef, useState, type Ref, type RefObject } from 'react';
import { windowsBaseName } from '@shared/paths';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { pathTail } from '@web/lib/path-display';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { Splitter } from '@web/ui/splitter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/ui/tabs';
import { SIDE_PANEL_TABS, type SidePanelTab } from '../requests';
import { useFeatureSlots } from '../slots';
import { goBackSidePanelFile, openSidePanel, useSidePanelFile, useSidePanelHistory } from './state';
import {
  SIDE_PANEL_MIN_WIDTH,
  clampSidePanelWidth,
  defaultSidePanelWidth,
  isSidePanelOverlay,
  readSidePanelWidth,
  sidePanelMaxWidth,
  writeSidePanelWidth,
} from './width';

function isSidePanelTab(value: string): value is SidePanelTab {
  return (SIDE_PANEL_TABS as readonly string[]).includes(value);
}

/** The content of one tab: the feature slots (placeholders render nothing). */
const TabContent = memo(function TabContent({ sessionKey, tab }: { sessionKey: string; tab: SidePanelTab }) {
  const { PlanPanel, FilePanel, FilesPanel, TasksPanel } = useFeatureSlots();
  const file = useSidePanelFile(sessionKey);
  switch (tab) {
    case 'plan':
      return <PlanPanel sessionKey={sessionKey} />;
    case 'file':
      // `revision` remounts the viewer when the same target is requested again (jump once more).
      return file === null ? null : (
        <FilePanel
          key={file.revision}
          sessionKey={sessionKey}
          path={file.path}
          line={file.line}
          col={file.col}
        />
      );
    case 'files':
      return <FilesPanel sessionKey={sessionKey} />;
    case 'tasks':
      return <TasksPanel sessionKey={sessionKey} />;
  }
});

/** "Back" and the list of the last files of the viewer tab (state.ts keeps up to 10). */
function FileHistory({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const history = useSidePanelHistory(sessionKey);
  const previous = history[0];
  if (previous === undefined) return null;
  return (
    <>
      <IconButton
        label={t('sidePanel.back', { name: windowsBaseName(previous.path) })}
        data-slot="side-panel-back"
        onClick={() => {
          goBackSidePanelFile(sessionKey);
        }}
      >
        <ArrowLeftIcon aria-hidden />
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={t('sidePanel.history')} showTooltip={false} data-slot="side-panel-history">
            <HistoryIcon aria-hidden />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-96 min-w-56">
          <DropdownMenuLabel>{t('sidePanel.history')}</DropdownMenuLabel>
          {history.map((entry, index) => (
            <DropdownMenuItem
              key={entry.path}
              onSelect={() => {
                goBackSidePanelFile(sessionKey, index);
              }}
            >
              <span className="shrink-0 font-medium">{windowsBaseName(entry.path)}</span>
              <span className="text-muted-foreground min-w-0 truncate font-mono text-2xs">
                {pathTail(entry.path, 3)}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/**
 * Width of the session area (the parent of the host: transcript + panel), measured with a
 * ResizeObserver; null until the first measurement (or without ResizeObserver).
 */
function useAreaWidth(anchorRef: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const parent = anchorRef.current?.parentElement;
    if (parent === null || parent === undefined || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) setWidth(Math.round(measured));
    });
    observer.observe(parent);
    return () => {
      observer.disconnect();
    };
  }, [anchorRef]);
  return width;
}

export interface SidePanelFrameProps {
  sessionKey: string;
  tab: SidePanelTab;
  /** The `aside` (focus target, Esc scope of the host). */
  asideRef: Ref<HTMLElement>;
  onClose: () => void;
}

/**
 * The open panel (lazy chunk of SidePanelHost.tsx): a frame of the remembered width with the
 * splitter on its left edge, the tab row (Plan · File – only with an open file · Files · Tasks),
 * "Back" for the viewer and "Close". Below 1100 px of session area it lies over the transcript
 * (anchored at the right edge, no focus trap).
 */
export function SidePanelFrame({ sessionKey, tab, asideRef, onClose }: SidePanelFrameProps) {
  const t = useT();
  const anchorRef = useRef<HTMLDivElement>(null);
  const area = useAreaWidth(anchorRef);
  const overlay = isSidePanelOverlay(area);
  const [stored, setStored] = useState<number | null>(readSidePanelWidth);
  const [dragging, setDragging] = useState(false);
  const width = clampSidePanelWidth(stored ?? defaultSidePanelWidth(area), area);
  const file = useSidePanelFile(sessionKey);
  const tabs = SIDE_PANEL_TABS.filter((candidate) => candidate !== 'file' || file !== null || tab === 'file');

  return (
    <div
      ref={anchorRef}
      data-slot="side-panel-anchor"
      className={overlay ? 'relative w-0 shrink-0' : 'flex min-h-0 shrink-0'}
      style={overlay ? undefined : { width }}
    >
      <aside
        ref={asideRef}
        data-side-panel={sessionKey}
        data-slot="side-panel"
        data-tab={tab}
        data-mode={overlay ? 'overlay' : 'inline'}
        aria-label={t(`sidePanel.tab.${tab}`)}
        tabIndex={-1}
        style={overlay ? { width } : undefined}
        className={cn(
          'bg-background focus-visible:ring-ring relative flex min-h-0 flex-col border-l outline-none focus-visible:ring-2 focus-visible:ring-inset',
          overlay ? 'absolute inset-y-0 right-0 z-30 shadow-xl' : 'w-full',
        )}
      >
        <Splitter
          className="absolute inset-y-0 left-0 z-10"
          value={width}
          min={SIDE_PANEL_MIN_WIDTH}
          max={sidePanelMaxWidth(area)}
          invert
          label={t('sidePanel.resize')}
          valueText={t('sidePanel.width', { width })}
          onChange={setStored}
          onCommit={writeSidePanelWidth}
          onDraggingChange={setDragging}
        />
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (isSidePanelTab(value)) openSidePanel(sessionKey, value);
          }}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="flex h-9 shrink-0 items-center gap-1 border-b pr-1 pl-3">
            <TabsList
              aria-label={t('sidePanel.tabs')}
              className="-mb-px h-9 w-auto min-w-0 flex-1 gap-3 overflow-x-auto border-b-0"
            >
              {tabs.map((value) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  data-tab={value}
                  aria-label={
                    value === 'file' && file !== null
                      ? t('sidePanel.fileTab', { name: windowsBaseName(file.path) })
                      : undefined
                  }
                  className="h-9 min-w-0"
                >
                  {t(`sidePanel.tab.${value}`)}
                  {value === 'file' && file !== null ? (
                    <span className="text-muted-foreground max-w-40 truncate font-mono text-2xs font-normal">
                      {windowsBaseName(file.path)}
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
            {tab === 'file' ? <FileHistory sessionKey={sessionKey} /> : null}
            <IconButton label={t('sidePanel.close')} onClick={onClose}>
              <XIcon aria-hidden />
            </IconButton>
          </div>
          {tabs.map((value) => (
            <TabsContent
              key={value}
              value={value}
              tabIndex={-1}
              className={cn(
                'flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden',
                dragging && 'pointer-events-none select-none',
              )}
            >
              <TabContent sessionKey={sessionKey} tab={value} />
            </TabsContent>
          ))}
        </Tabs>
      </aside>
    </div>
  );
}

export default SidePanelFrame;
