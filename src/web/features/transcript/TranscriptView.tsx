import { ArrowDownIcon, HistoryIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { VList, type VListHandle } from 'virtua';
import type { QueuedPrompt, SessionSummary, TranscriptItem } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useTranscriptFollowHandler } from '@web/shell/transcript-follow';
import { loadEarlier } from '@web/state/actions';
import { errorPayloadOf } from '@web/state/connection';
import {
  selectTopLevelItemIds,
  useSessionMeta,
  useSessionSelector,
  useSummarySelector,
  useTopLevelItemIds,
} from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { useTranscriptView } from '@web/state/transcript-view';
import { Button } from '@web/ui/button';
import { Skeleton } from '@web/ui/skeleton';
import { Spinner } from '@web/ui/spinner';
import { ToolImagesGallery } from './components/ImageGallery';
import { ImageViewer } from './components/ImageViewer';
import { SinceLastVisit } from './components/SinceLastVisit';
import { QueuedIdsContext, TranscriptSettingsContext, type TranscriptSettings } from './context';
import { QueuedPromptRow } from './items/MessageRows';
import { StepGroupRow } from './items/StepGroupRow';
import { TranscriptRow } from './items/TranscriptRow';
import { buildRows, itemCodesById, type ItemCode, type TranscriptRowModel } from './lib/grouping';
import { preloadMarkdown } from './markdown/Markdown';
import { useOpenGroups } from './state/groups';

/**
 * The transcript of one session (slot `Transcript`, architecture §2.3d/g):
 * - virtualized list (virtua) of the top-level items (`useTopLevelItemIds`, stable ids; subagent
 *   items live in their Agent card), one `useItem` per row – deltas re-render only their row;
 * - sticks to the bottom while new content arrives, unless the user scrolled up ("Jump to latest");
 * - scrolling to the top loads earlier items (`loadEarlier`, `hasEarlier`), virtua's `shift` keeps
 *   the position while items are prepended;
 * - queued prompts (`detail.queue`) appear grey at the end until the CLI takes them over;
 * - one image lightbox next to the list (`ImageViewer`, WP-37): it survives its row unmounting;
 * - WP-63 §1.5: the rows come from `buildRows` (lib/grouping.ts) – in the compact view (setting,
 *   default) runs of work steps are one group line with their pictures as a gallery; the roles of
 *   the items are compared shallowly, so deltas that change no role keep the rows;
 * - WP-65 §1.2: the card "Since you were last here" at the top (`SinceLastVisit`, from the session's
 *   `lastSeenAt` held at opening), closable, with a jump to the first new item.
 */

type Row = { kind: 'earlier' } | TranscriptRowModel | { kind: 'queued'; prompt: QueuedPrompt };

const EARLIER_ROW: Row = { kind: 'earlier' };
const EMPTY_QUEUE: readonly QueuedPrompt[] = Object.freeze([]);

/** Distance from the end (px) that still counts as "at the bottom". */
const STICK_PX = 48;
/** Distance from the top (px) that triggers `loadEarlier`. */
const EARLIER_PX = 240;

const selectQueue = (view: SessionViewState): readonly QueuedPrompt[] => view.detail.queue;
const selectInitModel = (view: SessionViewState): string | null => view.detail.init?.model ?? null;
const selectSummaryModel = (summary: SessionSummary): string | null => summary.model;
const selectApiKeySource = (summary: SessionSummary): string | null => summary.apiKeySource;
const selectLastSeenAt = (summary: SessionSummary): string | null => summary.lastSeenAt;

const EMPTY_CODES: readonly ItemCode[] = Object.freeze([]);
const codesCache = new WeakMap<readonly TranscriptItem[], readonly ItemCode[]>();

/** The role code of every top-level row id (same order); cached per items array. */
function selectItemCodes(view: SessionViewState): readonly ItemCode[] {
  const cached = codesCache.get(view.items);
  if (cached !== undefined) return cached;
  const byId = itemCodesById(view.items);
  const codes = selectTopLevelItemIds(view).map((id) => byId.get(id) ?? 'v');
  codesCache.set(view.items, codes);
  return codes;
}

function rowKey(row: Row): string {
  switch (row.kind) {
    case 'earlier':
      return 'earlier';
    case 'item':
      return row.id;
    case 'group':
    case 'gallery':
      return row.key;
    case 'queued':
      return `queued:${row.prompt.messageUuid}`;
  }
}

/** Was the list changed at its start (items prepended by `loadEarlier`)? virtua then needs `shift`. */
interface ListShape {
  first: string | undefined;
  length: number;
  /** All rows (items + queue + "earlier"): any other change ends the shift (R2W-07). */
  rows: number;
  /** The "earlier" row at the start. */
  earlier: boolean;
  shift: boolean;
}

function EarlierRow({ loading, onLoad }: { loading: boolean; onLoad: () => void }) {
  const t = useT();
  return (
    <div className="flex justify-center py-2">
      <Button size="sm" variant="ghost" disabled={loading} onClick={onLoad}>
        {loading ? (
          <Spinner className="size-3" label={t('transcript.list.loadingEarlier')} />
        ) : (
          <HistoryIcon aria-hidden />
        )}
        {loading ? t('transcript.list.loadingEarlier') : t('transcript.list.loadEarlier')}
      </Button>
    </div>
  );
}

function TranscriptList({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const ids = useTopLevelItemIds(sessionKey);
  const meta = useSessionMeta(sessionKey);
  const queue = useSessionSelector(sessionKey, selectQueue, EMPTY_QUEUE);
  const initModel = useSessionSelector(sessionKey, selectInitModel, null);
  const summaryModel = useSummarySelector(sessionKey, selectSummaryModel, null);
  const apiKeySource = useSummarySelector(sessionKey, selectApiKeySource, null);
  // WP-65 §1.2: `lastSeenAt` as it was when the transcript opened (the list is keyed per session).
  const lastSeenAt = useSummarySelector(sessionKey, selectLastSeenAt, null);
  const [since] = useState(lastSeenAt);
  const [sinceClosed, setSinceClosed] = useState(false);
  const codes = useSessionSelector(sessionKey, selectItemCodes, EMPTY_CODES);
  const mode = useTranscriptView();
  const openGroups = useOpenGroups(sessionKey);
  const itemRows = useMemo(
    () => buildRows(ids, codes, mode, (key) => openGroups.has(key)),
    [ids, codes, mode, openGroups],
  );

  const settings = useMemo<TranscriptSettings>(
    () => ({
      sessionModel: initModel ?? summaryModel,
      showCost: apiKeySource !== null && apiKeySource !== 'none',
      Row: TranscriptRow,
    }),
    [initModel, summaryModel, apiKeySource],
  );
  const queuedIds = useMemo(() => new Set(queue.map((prompt) => prompt.messageUuid)), [queue]);

  const rows = useMemo(() => {
    const result: Row[] = [];
    if (meta.hasEarlier) result.push(EARLIER_ROW);
    result.push(...itemRows);
    if (queue.length > 0) {
      const present = new Set(ids);
      for (const prompt of queue)
        if (!present.has(prompt.messageUuid)) result.push({ kind: 'queued', prompt });
    }
    return result;
  }, [ids, itemRows, meta.hasEarlier, queue]);

  // virtua `shift`: true exactly for the update that changed the start of the list – items
  // prepended, or the "earlier" row added/removed (derived from the previous shape); the next
  // change of the rows – e.g. a queued prompt appended at the end – ends it (R2W-07).
  const [shape, setShape] = useState<ListShape>({
    first: ids[0],
    length: ids.length,
    rows: rows.length,
    earlier: meta.hasEarlier,
    shift: false,
  });
  let shift = shape.shift;
  if (
    shape.first !== ids[0] ||
    shape.length !== ids.length ||
    shape.rows !== rows.length ||
    shape.earlier !== meta.hasEarlier
  ) {
    const prepended = shape.first !== undefined && ids[0] !== shape.first && ids.includes(shape.first);
    shift = prepended || shape.earlier !== meta.hasEarlier;
    setShape({ first: ids[0], length: ids.length, rows: rows.length, earlier: meta.hasEarlier, shift });
  }

  const listRef = useRef<VListHandle>(null);
  const stickRef = useRef(true);
  const lastOffsetRef = useRef(0);
  const rowCountRef = useRef(rows.length);
  const hasEarlierRef = useRef(meta.hasEarlier);
  const loadingRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  useEffect(() => {
    hasEarlierRef.current = meta.hasEarlier;
  }, [meta.hasEarlier]);

  useEffect(() => {
    preloadMarkdown();
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollElement = useCallback(
    () => rootRef.current?.querySelector<HTMLElement>('[role="region"]') ?? null,
    [],
  );

  // Not virtua's `scrollToIndex`: that one re-applies its target on every size change until 150 ms
  // pass without one, so a user scroll that starts meanwhile – during streaming nearly always – is
  // pulled back to the end (FIX-E2E-EDGE157, WP-55). The list re-applies the end itself (`onResize`)
  // and only while it sticks to the bottom; a scroll towards the top ends that at once.
  const scrollToEnd = useCallback(() => {
    const handle = listRef.current;
    const element = scrollElement();
    if (handle === null || element === null || rowCountRef.current === 0) return;
    element.scrollTop = Math.max(0, handle.scrollSize - handle.viewportSize);
  }, [scrollElement]);

  // WP-63: opening or closing a step group is a click on a row in view. Following the end would push
  // that group line out of view (its steps are rows after it), so the list keeps its offset – also
  // while virtua measures the new rows (`onResize`); after that (two frames: it measures after the
  // first one's layout) it sticks again only while the end is in view, otherwise "Jump to latest".
  const openGroupsRef = useRef(openGroups);
  const settleRef = useRef(0);
  const settlingRef = useRef(false);
  const settleAfterToggle = useCallback(() => {
    cancelAnimationFrame(settleRef.current);
    settlingRef.current = true;
    settleRef.current = requestAnimationFrame(() => {
      settleRef.current = requestAnimationFrame(() => {
        settlingRef.current = false;
        const handle = listRef.current;
        if (handle === null) return;
        stickRef.current = handle.scrollSize - handle.viewportSize - handle.scrollOffset <= STICK_PX;
        setShowJump(!stickRef.current);
      });
    });
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(settleRef.current);
    },
    [],
  );

  // New rows (and the first render): follow them while the user is at the bottom.
  useLayoutEffect(() => {
    rowCountRef.current = rows.length;
    const toggled = openGroupsRef.current !== openGroups;
    openGroupsRef.current = openGroups;
    if (toggled) settleAfterToggle();
    else if (stickRef.current) scrollToEnd();
  }, [rows.length, openGroups, scrollToEnd, settleAfterToggle]);

  const requestEarlier = useCallback(() => {
    if (loadingRef.current || !hasEarlierRef.current) return;
    loadingRef.current = true;
    setLoadingEarlier(true);
    loadEarlier(sessionKey)
      .catch((error: unknown) => {
        showErrorNotice(errorPayloadOf(error), { sessionKey, id: `transcript-earlier-${sessionKey}` });
      })
      .finally(() => {
        loadingRef.current = false;
        setLoadingEarlier(false);
      });
  }, [sessionKey]);

  const onScroll = useCallback(
    (offset: number) => {
      const handle = listRef.current;
      if (handle === null) return;
      const distance = handle.scrollSize - handle.viewportSize - offset;
      // Only a scroll towards the top unsticks (re-measuring items may move the offset too).
      if (distance <= STICK_PX) stickRef.current = true;
      else if (offset < lastOffsetRef.current - 1) stickRef.current = false;
      lastOffsetRef.current = offset;
      setShowJump(!stickRef.current);
      if (offset < EARLIER_PX) requestEarlier();
    },
    [requestEarlier],
  );

  // Growing content (streaming text, expanded rows at the end) keeps the bottom in view. A larger
  // window can make the browser clamp `scrollTop` before virtua has measured the new viewport: that
  // scroll event looks like a scroll towards the top and unsticks – with the sizes now current, the
  // list sticks again once the end is in view (WP-55).
  const onResize = useCallback(() => {
    if (settlingRef.current) return;
    const handle = listRef.current;
    if (
      !stickRef.current &&
      handle !== null &&
      handle.scrollSize - handle.viewportSize - handle.scrollOffset <= STICK_PX
    ) {
      stickRef.current = true;
      setShowJump(false);
    }
    if (stickRef.current) scrollToEnd();
  }, [scrollToEnd]);

  // WP-65 §1.2: "To the first new message" – the row of that item (or the group/gallery holding it).
  const jumpToItem = (itemId: string) => {
    const index = rows.findIndex((row) =>
      row.kind === 'item' ? row.id === itemId : row.kind === 'group' || row.kind === 'gallery' ? row.ids.includes(itemId) : false,
    );
    const handle = listRef.current;
    if (index < 0 || handle === null) return;
    stickRef.current = false;
    setShowJump(true);
    handle.scrollToIndex(index, { align: 'start' });
  };

  const jumpToLatest = () => {
    stickRef.current = true;
    setShowJump(false);
    scrollToEnd();
  };

  // V2-06: a message sent from this window's composer brings the end back into view (the rows
  // that follow – own message, queue entry, answer – then stick as usual).
  useTranscriptFollowHandler(sessionKey, jumpToLatest);

  const empty = rows.length === 0;
  return (
    <TranscriptSettingsContext value={settings}>
      <QueuedIdsContext value={queuedIds}>
        <ImageViewer fallbackFocus={scrollElement}>
          <div
            ref={rootRef}
            data-slot="transcript"
            data-session-key={sessionKey}
            className="relative h-full min-h-0"
          >
            {!meta.hasView ? (
              <div
                aria-busy="true"
                aria-label={t('transcript.list.label')}
                className="flex flex-col gap-3 p-4"
              >
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-16 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : empty ? (
              <p className="text-muted-foreground flex h-full items-center justify-center p-6 text-xs">
                {t('transcript.list.empty')}
              </p>
            ) : (
              <VList
                ref={listRef}
                data={rows}
                shift={shift}
                onScroll={onScroll}
                onResize={onResize}
                role="region"
                aria-label={t('transcript.list.label')}
                tabIndex={0}
                className="focus-visible:ring-ring/60 h-full outline-none focus-visible:ring-2 focus-visible:ring-inset"
              >
                {(row: Row) => (
                  <div
                    key={rowKey(row)}
                    data-row={row.kind}
                    data-nested={row.kind === 'item' && row.nested ? 'true' : undefined}
                    className={cn(
                      'mx-auto w-full max-w-4xl px-4',
                      row.kind === 'item' && row.nested ? 'py-0.5' : 'py-1.5',
                    )}
                  >
                    {row.kind === 'earlier' ? (
                      <EarlierRow loading={loadingEarlier} onLoad={requestEarlier} />
                    ) : row.kind === 'item' ? (
                      row.nested ? (
                        // A step of an open group: indented under its group line.
                        <div className="border-border ml-2.5 border-l pl-3">
                          <TranscriptRow
                            sessionKey={sessionKey}
                            itemId={row.id}
                            hideImages={row.hideImages}
                          />
                        </div>
                      ) : (
                        <TranscriptRow sessionKey={sessionKey} itemId={row.id} hideImages={row.hideImages} />
                      )
                    ) : row.kind === 'group' ? (
                      <StepGroupRow
                        sessionKey={sessionKey}
                        groupKey={row.key}
                        ids={row.ids}
                        imageIds={row.imageIds}
                        open={row.open}
                      />
                    ) : row.kind === 'gallery' ? (
                      <ToolImagesGallery sessionKey={sessionKey} ids={row.ids} className="ml-5" />
                    ) : (
                      <QueuedPromptRow prompt={row.prompt} sessionKey={sessionKey} />
                    )}
                  </div>
                )}
              </VList>
            )}
            {since === null || sinceClosed || !meta.hasView ? null : (
              <SinceLastVisit
                sessionKey={sessionKey}
                since={since}
                onJump={jumpToItem}
                onClose={() => {
                  setSinceClosed(true);
                }}
              />
            )}
            {showJump && !empty ? (
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
        </ImageViewer>
      </QueuedIdsContext>
    </TranscriptSettingsContext>
  );
}

/** Slot component `Transcript` (`{ sessionKey }`); state is per session (keyed). */
export const TranscriptView = memo(function TranscriptView({ sessionKey }: { sessionKey: string }) {
  return <TranscriptList key={sessionKey} sessionKey={sessionKey} />;
});
