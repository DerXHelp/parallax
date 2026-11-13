import { ArrowDownIcon, BotIcon, HistoryIcon, RefreshCwIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { VList, type VListHandle } from 'virtua';
import { parseSessionKey } from '@shared/common';
import type { TranscriptItem } from '@shared/model';
import { useI18n } from '@web/i18n';
import type { SubagentPanelSlotProps } from '@web/shell/slots';
import { useHookDisplay } from '@web/state/hook-display';
import { useTranscriptView } from '@web/state/transcript-view';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';
import { Skeleton } from '@web/ui/skeleton';
import { Spinner } from '@web/ui/spinner';
import { ImageGallery, galleryImages } from '../components/ImageGallery';
import { ImageViewer } from '../components/ImageViewer';
import { TranscriptSettingsContext, type TranscriptSettings } from '../context';
import { useLazyTranscriptT } from '../i18n-lazy';
import { StepGroupLine } from '../items/StepGroupRow';
import { TranscriptItemView, TranscriptRow } from '../items/TranscriptRow';
import { buildRows, classifyItem, type TranscriptRowModel } from '../lib/grouping';
import { preloadMarkdown } from '../markdown/Markdown';
import { setGroupOpen, useOpenGroups } from '../state/groups';
import { useSubagentTranscript } from '../state/subagent-transcript';

/**
 * Slot `SubagentPanel` (WP-69, lazy chunk): the side panel tab "Agent" – the whole transcript of
 * one subagent, read-only (no composer, no decisions, no Stop/"Background": `readOnly`). Its items
 * are a list of their own from the agent's transcript file (`session.subagentTranscript`, polled by
 * `useSubagentTranscript` while the agent runs) – not in the store, so the rows draw the items
 * directly (`TranscriptItemView`, `StepGroupLine`) with the same components as the session
 * transcript; compact or all steps per `transcriptView`, hook runs per `hookDisplay`. Like the
 * session transcript it follows new entries while the end is in view ("Jump to latest" otherwise);
 * "Load earlier entries" prepends the page before the window.
 */

type Row = { kind: 'earlier' } | TranscriptRowModel;

const EARLIER_ROW: Row = { kind: 'earlier' };
/** Distance from the end (px) that still counts as "at the bottom". */
const STICK_PX = 48;

function rowKey(row: Row): string {
  switch (row.kind) {
    case 'earlier':
      return 'earlier';
    case 'item':
      return row.id;
    case 'group':
    case 'gallery':
      return row.key;
  }
}

/** The model of the agent's first answer: other models get a badge (ModelBadge). */
function firstModel(items: readonly TranscriptItem[]): string | null {
  for (const item of items) {
    if ((item.kind === 'assistant_text' || item.kind === 'thinking' || item.kind === 'tool_call') && item.model !== null) {
      return item.model;
    }
  }
  return null;
}

/** Open step groups of this panel: a key of its own, apart from the session transcript's groups. */
function groupStateKey(sessionKey: string, agentId: string): string {
  return `${sessionKey}\u0000agent:${agentId}`;
}

function GroupRow({
  stateKey,
  row,
  byId,
}: {
  stateKey: string;
  row: Extract<TranscriptRowModel, { kind: 'group' }>;
  byId: ReadonlyMap<string, TranscriptItem>;
}) {
  const items = useMemo(() => row.ids.map((id) => byId.get(id) ?? null), [row.ids, byId]);
  const imageItems = useMemo(() => row.imageIds.map((id) => byId.get(id) ?? null), [row.imageIds, byId]);
  const onOpenChange = useCallback(
    (open: boolean) => {
      setGroupOpen(stateKey, row.key, open);
    },
    [stateKey, row.key],
  );
  return (
    <StepGroupLine
      groupKey={row.key}
      items={items}
      imageItems={imageItems}
      open={row.open}
      onOpenChange={onOpenChange}
    />
  );
}

export const SubagentPanel = memo(function SubagentPanel({
  sessionKey,
  agentId,
  title,
  subagentType,
}: SubagentPanelSlotProps) {
  const { t, tError } = useI18n();
  const lt = useLazyTranscriptT();
  const { pages, error, loadingEarlier, loadEarlier, refresh } = useSubagentTranscript(sessionKey, agentId);
  const hostId = parseSessionKey(sessionKey)?.hostId;
  const mode = useTranscriptView(hostId);
  const hooks = useHookDisplay(hostId);
  const stateKey = groupStateKey(sessionKey, agentId);
  const openGroups = useOpenGroups(stateKey);

  const items = pages?.items;
  const byId = useMemo(() => new Map((items ?? []).map((item) => [item.id, item])), [items]);
  const rows = useMemo<Row[]>(() => {
    const list = items ?? [];
    const built = buildRows(
      list.map((item) => item.id),
      list.map(classifyItem),
      mode,
      (key) => openGroups.has(key),
      hooks,
    );
    return pages !== null && pages.offset > 0 ? [EARLIER_ROW, ...built] : built;
  }, [items, mode, openGroups, hooks, pages]);
  const settings = useMemo<TranscriptSettings>(
    () => ({ sessionModel: firstModel(items ?? []), showCost: false, Row: TranscriptRow, readOnly: true }),
    [items],
  );

  // virtua `shift` for the update that prepended earlier entries (keeps the position).
  const firstId = items?.[0]?.id;
  const [shape, setShape] = useState({ first: firstId, rows: rows.length, shift: false });
  let shift = shape.shift;
  if (shape.first !== firstId || shape.rows !== rows.length) {
    const prepended =
      shape.first !== undefined && firstId !== shape.first && (items ?? []).some((item) => item.id === shape.first);
    shift = prepended;
    setShape({ first: firstId, rows: rows.length, shift });
  }

  const listRef = useRef<VListHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastOffsetRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    preloadMarkdown();
  }, []);

  const scrollElement = useCallback(
    () => rootRef.current?.querySelector<HTMLElement>('[role="region"]') ?? null,
    [],
  );
  // Not before virtua measured the viewport (since 0.53.6 after the first render): `onResize` follows.
  const scrollToEnd = useCallback(() => {
    const handle = listRef.current;
    const element = scrollElement();
    if (handle === null || element === null || handle.viewportSize === 0) return;
    element.scrollTop = Math.max(0, handle.scrollSize - handle.viewportSize);
  }, [scrollElement]);

  // New entries: follow them while the end is in view (like the session transcript).
  useLayoutEffect(() => {
    if (stickRef.current && !shift) scrollToEnd();
  }, [rows.length, shift, scrollToEnd]);

  const onScroll = useCallback((offset: number) => {
    const handle = listRef.current;
    if (handle === null) return;
    const distance = handle.scrollSize - handle.viewportSize - offset;
    if (distance <= STICK_PX) stickRef.current = true;
    else if (offset < lastOffsetRef.current - 1) stickRef.current = false;
    lastOffsetRef.current = offset;
    setShowJump(!stickRef.current);
  }, []);

  const onResize = useCallback(() => {
    if (stickRef.current) scrollToEnd();
  }, [scrollToEnd]);

  const jumpToLatest = () => {
    stickRef.current = true;
    setShowJump(false);
    scrollToEnd();
  };

  const running = pages?.running === true;
  const total = pages?.total ?? 0;

  return (
    <TranscriptSettingsContext value={settings}>
      <ImageViewer fallbackFocus={scrollElement}>
        <div
          ref={rootRef}
          data-slot="subagent-panel"
          data-agent-id={agentId}
          data-running={running ? 'true' : 'false'}
          className="flex h-full min-h-0 flex-col"
        >
          <div className="flex min-h-9 shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-xs">
            <BotIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-medium">{title}</span>
            {subagentType === null || subagentType === title ? null : <Badge variant="outline">{subagentType}</Badge>}
            <span className="flex-1" />
            {pages === null ? null : (
              <span data-slot="subagent-status" className="text-muted-foreground inline-flex shrink-0 items-center gap-1.5">
                {running ? <Spinner className="size-3" label={lt('subagent.running')} /> : null}
                <span className={running ? 'sr-only' : undefined}>
                  {running ? lt('subagent.running') : lt('subagent.finished')}
                </span>
                <span aria-hidden>·</span>
                <span data-slot="subagent-count" className="tabular-nums">
                  {lt('subagent.count', { count: total })}
                </span>
              </span>
            )}
            {running || pages === null ? null : (
              <IconButton label={lt('subagent.refresh')} onClick={refresh}>
                <RefreshCwIcon aria-hidden />
              </IconButton>
            )}
          </div>
          {error === null ? null : (
            <div className="shrink-0 border-b p-3">
              <Alert
                tone="error"
                data-slot="subagent-error"
                title={lt('subagent.failed')}
                actions={
                  <Button size="sm" variant="outline" onClick={refresh}>
                    {lt('subagent.retry')}
                  </Button>
                }
              >
                {tError(error)}
              </Alert>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {pages === null ? (
              error === null ? (
                <div aria-busy="true" aria-label={lt('subagent.label', { title })} className="flex flex-col gap-3 p-4">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-16 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : null
            ) : rows.length === 0 ? (
              <p className="text-muted-foreground flex h-full items-center justify-center p-6 text-xs">
                {lt('subagent.empty')}
              </p>
            ) : (
              <VList
                ref={listRef}
                data={rows}
                shift={shift}
                onScroll={onScroll}
                onResize={onResize}
                data-slot="subagent-list"
                role="region"
                tabIndex={0}
                aria-label={lt('subagent.label', { title })}
                className="focus-visible:ring-ring/60 h-full outline-none focus-visible:ring-2 focus-visible:ring-inset"
              >
                {(row: Row) => {
                  const item = row.kind === 'item' ? byId.get(row.id) : undefined;
                  return (
                    <div
                      key={rowKey(row)}
                      data-row={row.kind}
                      className={row.kind === 'item' && row.nested ? 'px-3 py-0.5' : 'px-3 py-1.5'}
                    >
                      {row.kind === 'earlier' ? (
                        <div className="flex justify-center py-1">
                          <Button size="sm" variant="ghost" disabled={loadingEarlier} onClick={loadEarlier}>
                            {loadingEarlier ? (
                              <Spinner className="size-3" label={lt('subagent.loadEarlier')} />
                            ) : (
                              <HistoryIcon aria-hidden />
                            )}
                            {lt('subagent.loadEarlier')}
                          </Button>
                        </div>
                      ) : row.kind === 'group' ? (
                        <GroupRow stateKey={stateKey} row={row} byId={byId} />
                      ) : row.kind === 'gallery' ? (
                        <ImageGallery
                          images={galleryImages(row.ids.map((id) => byId.get(id) ?? null))}
                          className="ml-5"
                        />
                      ) : item === undefined ? null : row.nested ? (
                        <div className="border-border ml-2.5 border-l pl-3">
                          <TranscriptItemView item={item} sessionKey={sessionKey} hideImages={row.hideImages} />
                        </div>
                      ) : (
                        <TranscriptItemView item={item} sessionKey={sessionKey} hideImages={row.hideImages} />
                      )}
                    </div>
                  );
                }}
              </VList>
            )}
            {showJump && rows.length > 0 ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={jumpToLatest}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 border shadow-md"
              >
                <ArrowDownIcon aria-hidden />
                {t('transcript.list.jumpToLatest')}
              </Button>
            ) : null}
          </div>
        </div>
      </ImageViewer>
    </TranscriptSettingsContext>
  );
});

export default SubagentPanel;
