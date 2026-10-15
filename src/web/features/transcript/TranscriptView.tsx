import { ArrowDownIcon, HistoryIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { VList, type VListHandle } from 'virtua';
import type { QueuedPrompt, SessionSummary } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { useT } from '@web/i18n';
import { useTranscriptFollowHandler } from '@web/shell/transcript-follow';
import { loadEarlier } from '@web/state/actions';
import { errorPayloadOf } from '@web/state/connection';
import { useSessionMeta, useSessionSelector, useSummarySelector, useTopLevelItemIds } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { Button } from '@web/ui/button';
import { Skeleton } from '@web/ui/skeleton';
import { Spinner } from '@web/ui/spinner';
import { QueuedIdsContext, TranscriptSettingsContext, type TranscriptSettings } from './context';
import { QueuedPromptRow } from './items/MessageRows';
import { TranscriptRow } from './items/TranscriptRow';
import { preloadMarkdown } from './markdown/Markdown';

/**
 * The transcript of one session (slot `Transcript`, architecture §2.3d/g):
 * - virtualized list (virtua) of the top-level items (`useTopLevelItemIds`, stable ids; subagent
 *   items live in their Agent card), one `useItem` per row – deltas re-render only their row;
 * - sticks to the bottom while new content arrives, unless the user scrolled up ("Jump to latest");
 * - scrolling to the top loads earlier items (`loadEarlier`, `hasEarlier`), virtua's `shift` keeps
 *   the position while items are prepended;
 * - queued prompts (`detail.queue`) appear grey at the end until the CLI takes them over.
 */

type Row = { kind: 'earlier' } | { kind: 'item'; id: string } | { kind: 'queued'; prompt: QueuedPrompt };

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

function rowKey(row: Row): string {
  switch (row.kind) {
    case 'earlier':
      return 'earlier';
    case 'item':
      return row.id;
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
    for (const id of ids) result.push({ kind: 'item', id });
    if (queue.length > 0) {
      const present = new Set(ids);
      for (const prompt of queue)
        if (!present.has(prompt.messageUuid)) result.push({ kind: 'queued', prompt });
    }
    return result;
  }, [ids, meta.hasEarlier, queue]);

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

  const scrollToEnd = useCallback(() => {
    const handle = listRef.current;
    const count = rowCountRef.current;
    if (handle === null || count === 0) return;
    handle.scrollToIndex(count - 1, { align: 'end' });
  }, []);

  // New rows (and the first render): follow them while the user is at the bottom.
  useLayoutEffect(() => {
    rowCountRef.current = rows.length;
    if (stickRef.current) scrollToEnd();
  }, [rows.length, scrollToEnd]);

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

  // Growing content (streaming text, expanded rows at the end) keeps the bottom in view.
  const onResize = useCallback(() => {
    if (stickRef.current) scrollToEnd();
  }, [scrollToEnd]);

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
        <div data-slot="transcript" data-session-key={sessionKey} className="relative h-full min-h-0">
          {!meta.hasView ? (
            <div aria-busy="true" aria-label={t('transcript.list.label')} className="flex flex-col gap-3 p-4">
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
                <div key={rowKey(row)} data-row={row.kind} className="mx-auto w-full max-w-4xl px-4 py-1.5">
                  {row.kind === 'earlier' ? (
                    <EarlierRow loading={loadingEarlier} onLoad={requestEarlier} />
                  ) : row.kind === 'item' ? (
                    <TranscriptRow sessionKey={sessionKey} itemId={row.id} />
                  ) : (
                    <QueuedPromptRow prompt={row.prompt} />
                  )}
                </div>
              )}
            </VList>
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
      </QueuedIdsContext>
    </TranscriptSettingsContext>
  );
}

/** Slot component `Transcript` (`{ sessionKey }`); state is per session (keyed). */
export const TranscriptView = memo(function TranscriptView({ sessionKey }: { sessionKey: string }) {
  return <TranscriptList key={sessionKey} sessionKey={sessionKey} />;
});
