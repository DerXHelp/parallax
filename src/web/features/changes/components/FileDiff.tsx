import { PlusIcon } from 'lucide-react';
import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import type { GitDiffFile, GitDiffScope, ReviewComment } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import type { DiffRow } from '@web/lib/diff';
import { toScreenPx } from '@web/lib/zoom';
import { useZoom } from '@web/state/zoom';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { DIFF_MARKER, DIFF_MARKER_CLASS, DIFF_ROW_CLASS } from '@web/ui/diff-view';
import { Spinner } from '@web/ui/spinner';
import { anchorOfRows, placeComments, rowIndexBySideLine, shownState, type LineAnchor } from '../lib/anchor';
import { commentLocation } from '../lib/feedback';
import { isLineRow, patchToRows } from '../lib/patch';
import { openReviewDraft, useReviewDraft, type ReviewDraft } from '../state/draft';
import { useFileDiff } from '../state/git';
import { useReanchor } from '../state/review';
import { CommentEditor } from './CommentEditor';
import { CommentNote } from './CommentNote';

/**
 * The diff of one file in the tab "Changes" (WP-113, ADR-254): the patch from `git.fileDiff` (loaded
 * when the file opens, again after every refresh), line numbers of both sides, long lines wrapped.
 * From DIFF_VIRTUALIZE_ROWS rows on, the diff scrolls in its own box and only the visible rows render
 * (virtua). Comments: hover a line → "+", or select lines → C; with the keyboard the arrow keys move
 * a line cursor (Shift extends it), C or Enter comments. Each comment shows below its last line; in
 * the complete session diff the window re-anchors comments and marks lost ones stale.
 */

/** From this many rows on the diff is virtualized (like the viewer, `files/components/CodeView.tsx`). */
export const DIFF_VIRTUALIZE_ROWS = 300;

/** Height of a diff line (`leading-5`) in layout px; virtua gets it at the zoom (WP-92). */
const DIFF_LINE_HEIGHT = 20;

const GUTTER =
  'text-muted-foreground/70 shrink-0 border-r px-1 text-right text-2xs leading-5 select-none tabular-nums';

function lineNumber(row: DiffRow): number | null {
  return row.newLine ?? row.oldLine;
}

/** Rows `[from, to]` of a selection inside `region` (null without one). */
function selectedRowRange(region: HTMLElement, lastRow: number): [number, number] | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const rowOf = (node: Node): HTMLElement | null =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-diff-row]') ?? null;
  const start = rowOf(range.startContainer);
  if (start === null || !region.contains(start)) return null;
  const end = rowOf(range.endContainer);
  const from = Number(start.dataset.diffRow);
  let to = end !== null && region.contains(end) ? Number(end.dataset.diffRow) : lastRow;
  // A triple click ends at the start of the next row.
  if (to > from && range.endOffset === 0) to -= 1;
  return Number.isInteger(from) && Number.isInteger(to) ? [from, to] : null;
}

interface RowProps {
  row: DiffRow;
  index: number;
  showOld: boolean;
  gutterCh: number;
  cursor: boolean;
  inRange: boolean;
  onComment: (index: number) => void;
  children?: ReactNode;
}

function Row({ row, index, showOld, gutterCh, cursor, inRange, onComment, children }: RowProps) {
  const { t } = useI18n();
  if (!isLineRow(row)) {
    return (
      <div
        data-diff-row={index}
        data-kind={row.kind}
        className={cn('px-2.5 leading-5', DIFF_ROW_CLASS[row.kind])}
      >
        {row.text}
      </div>
    );
  }
  const line = lineNumber(row) ?? 0;
  return (
    <div
      data-diff-row={index}
      data-kind={row.kind}
      data-old-line={row.oldLine ?? undefined}
      data-new-line={row.newLine ?? undefined}
      data-cursor={cursor ? 'true' : undefined}
    >
      <div
        className={cn(
          'group/line relative flex min-h-5',
          DIFF_ROW_CLASS[row.kind],
          inRange && 'bg-accent',
          cursor && 'outline-ring outline-1 -outline-offset-1',
        )}
      >
        {showOld ? (
          <span
            className={GUTTER}
            style={{ width: `${String(gutterCh)}ch` }}
            title={row.oldLine === null ? undefined : t('changes.diff.oldLine', { line: row.oldLine })}
          >
            {row.oldLine}
          </span>
        ) : null}
        <span
          className={GUTTER}
          style={{ width: `${String(gutterCh)}ch` }}
          title={row.newLine === null ? undefined : t('changes.diff.newLine', { line: row.newLine })}
        >
          {row.newLine}
        </span>
        <span className={cn('w-4 shrink-0 text-center select-none', DIFF_MARKER_CLASS[row.kind])}>
          {DIFF_MARKER[row.kind]}
        </span>
        <span className="min-w-0 flex-1 pr-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{row.text}</span>
        <Button
          size="icon-xs"
          tabIndex={-1}
          data-action="add-review-comment"
          aria-label={t('changes.diff.addComment', { line })}
          title={t('changes.diff.addComment', { line })}
          className="bg-brand text-brand-foreground hover:bg-brand/90 absolute top-0 left-0.5 size-5 opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100"
          // Keep the focus (and the selection) where it is until the click opens the editor.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            onComment(index);
          }}
        >
          <PlusIcon aria-hidden />
        </Button>
      </div>
      {children}
    </div>
  );
}

function announcement(
  rows: readonly DiffRow[],
  cursor: number,
  anchor: number | null,
  t: ReturnType<typeof useI18n>['t'],
) {
  const row = rows[cursor];
  if (row === undefined) return '';
  if (anchor !== null && anchor !== cursor) {
    const first = rows[Math.min(anchor, cursor)];
    const last = rows[Math.max(anchor, cursor)];
    return t('changes.diff.announceRange', {
      from: (first === undefined ? null : lineNumber(first)) ?? 0,
      to: (last === undefined ? null : lineNumber(last)) ?? 0,
    });
  }
  const text = row.text.trim();
  if (row.kind === 'add') return t('changes.diff.announce.add', { line: row.newLine ?? 0, text });
  if (row.kind === 'remove') return t('changes.diff.announce.remove', { line: row.oldLine ?? 0, text });
  return t('changes.diff.announce.context', { line: row.newLine ?? 0, text });
}

export interface FileDiffProps {
  sessionKey: string;
  /** The entry of the diff list (no patch). */
  file: GitDiffFile;
  scope: GitDiffScope;
  generation: number;
  /** The comments on this file. */
  comments: readonly ReviewComment[];
}

export function FileDiff({ sessionKey, file, scope, generation, comments }: FileDiffProps) {
  const { t, tError } = useI18n();
  const zoom = useZoom();
  const loaded = useFileDiff(sessionKey, scope, file.path, generation, !file.binary);
  const patch = loaded.file?.patch ?? null;
  const truncated = loaded.file?.truncated ?? file.truncated;
  const binary = loaded.file?.binary ?? file.binary;
  const rows = useMemo(() => (patch === null ? [] : patchToRows(patch)), [patch]);
  const lineRows = useMemo(() => rows.flatMap((row, index) => (isLineRow(row) ? [index] : [])), [rows]);
  const placed = useMemo(() => placeComments(rows, comments), [rows, comments]);
  const authoritative = scope === 'session' && loaded.file !== null && patch !== null && !truncated;
  useReanchor(sessionKey, comments, placed.placements, authoritative, loaded.at);

  const draft = useReviewDraft(sessionKey);
  const draftHere = draft !== null && draft.target.path === file.path ? draft : null;
  const draftRow = useMemo(() => {
    if (draftHere?.target.kind !== 'new') return null;
    const { anchor } = draftHere.target;
    return rowIndexBySideLine(rows).get(`${anchor.side}:${String(anchor.endLine)}`) ?? null;
  }, [draftHere, rows]);

  const keysId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  const handle = useRef<VirtualizerHandle>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [spoken, setSpoken] = useState('');
  const virtual = rows.length >= DIFF_VIRTUALIZE_ROWS;
  const showOld = file.kind !== 'added' && file.kind !== 'untracked';
  const gutterCh = useMemo(() => {
    let widest = 1;
    for (const row of rows)
      widest = Math.max(widest, String(row.oldLine ?? 0).length, String(row.newLine ?? 0).length);
    return widest + 1.5;
  }, [rows]);

  const focusRegion = () => {
    regionRef.current?.focus({ preventScroll: true });
  };

  /** Opens the editor for `anchor`; another editor with unsaved text keeps the focus instead. */
  const comment = (anchor: LineAnchor | null) => {
    if (anchor === null) return;
    if (!openReviewDraft(sessionKey, { kind: 'new', path: file.path, anchor })) {
      document
        .querySelector<HTMLTextAreaElement>(
          `[data-changes-panel="${sessionKey}"] [data-slot="review-editor"] textarea`,
        )
        ?.focus();
      return;
    }
    window.getSelection()?.removeAllRanges();
  };

  const moveTo = (next: number, extend: boolean) => {
    if (extend) setRangeStart((start) => start ?? cursor ?? next);
    else setRangeStart(null);
    setCursor(next);
    setSpoken(announcement(rows, next, extend ? (rangeStart ?? cursor ?? next) : null, t));
    if (virtual) handle.current?.scrollToIndex(next, { align: 'nearest' });
    else
      regionRef.current
        ?.querySelector(`[data-diff-row="${String(next)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
    const position = cursor === null ? -1 : lineRows.indexOf(cursor);
    const first = lineRows[0];
    const last = lineRows.at(-1);
    if (first === undefined || last === undefined) return;
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        moveTo(lineRows[Math.min(position + 1, lineRows.length - 1)] ?? first, event.shiftKey);
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        moveTo(position < 0 ? first : (lineRows[Math.max(position - 1, 0)] ?? first), event.shiftKey);
        return;
      }
      case 'Home':
        event.preventDefault();
        moveTo(first, event.shiftKey);
        return;
      case 'End':
        event.preventDefault();
        moveTo(last, event.shiftKey);
        return;
      case 'Escape':
        if (cursor === null) return;
        event.preventDefault();
        setCursor(null);
        setRangeStart(null);
        return;
      case 'Enter':
      case 'c':
      case 'C': {
        if (event.repeat) return;
        const region = regionRef.current;
        const selected = region === null ? null : selectedRowRange(region, rows.length - 1);
        if (selected !== null) {
          event.preventDefault();
          comment(anchorOfRows(rows, selected[0], selected[1]));
        } else if (cursor !== null) {
          event.preventDefault();
          comment(anchorOfRows(rows, rangeStart ?? cursor, cursor));
        }
        return;
      }
      default:
        return;
    }
  };

  if (binary) {
    return (
      <p className="text-muted-foreground px-3 py-2 text-xs" data-slot="changes-diff-binary">
        {t('changes.diff.binary')}
      </p>
    );
  }
  if (loaded.file === null) {
    if (loaded.error !== null) {
      return (
        <div className="px-3 py-2">
          <Alert
            tone="error"
            title={t('changes.diff.error')}
            actions={
              <Button variant="outline" size="sm" onClick={loaded.retry}>
                {t('changes.panel.retry')}
              </Button>
            }
          >
            {tError(loaded.error)}
          </Alert>
        </div>
      );
    }
    return (
      <p className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs" role="status">
        <Spinner aria-hidden className="size-3.5" />
        {t('changes.diff.loading')}
      </p>
    );
  }

  const rangeFrom = cursor === null ? null : Math.min(rangeStart ?? cursor, cursor);
  const rangeTo = cursor === null ? null : Math.max(rangeStart ?? cursor, cursor);

  const editorFor = (target: ReviewDraft, commented: ReviewComment | null, location: string) => (
    <CommentEditor
      key="editor"
      sessionKey={sessionKey}
      draft={target}
      comment={commented}
      location={location}
      onClosed={focusRegion}
    />
  );

  const notesOf = (list: readonly ReviewComment[], showQuote: boolean) =>
    list.map((entry) => {
      const placement = placed.placements.get(entry.id);
      const location = commentLocation(
        placement === null || placement === undefined ? entry : { path: entry.path, ...placement },
      );
      if (draftHere?.target.kind === 'edit' && draftHere.target.commentId === entry.id) {
        return <div key={entry.id}>{editorFor(draftHere, entry, location)}</div>;
      }
      return (
        <CommentNote
          key={entry.id}
          sessionKey={sessionKey}
          comment={entry}
          // A comment newer than this patch (made in another window) keeps its stored state.
          state={shownState(
            entry,
            placement,
            authoritative && Date.parse(entry.createdAt) <= (loaded.at ?? 0),
          )}
          location={location}
          showQuote={showQuote}
          onEdit={() => {
            if (
              !openReviewDraft(
                sessionKey,
                { kind: 'edit', path: entry.path, commentId: entry.id },
                entry.text,
              )
            ) {
              document
                .querySelector<HTMLTextAreaElement>(
                  `[data-changes-panel="${sessionKey}"] [data-slot="review-editor"] textarea`,
                )
                ?.focus();
            }
          }}
        />
      );
    });

  const renderRow = (row: DiffRow, index: number) => {
    const notes = placed.byRow.get(index);
    const newDraft =
      draftRow === index && draftHere?.target.kind === 'new'
        ? editorFor(draftHere, null, commentLocation({ path: file.path, ...draftHere.target.anchor }))
        : null;
    return (
      <Row
        key={index}
        row={row}
        index={index}
        showOld={showOld}
        gutterCh={gutterCh}
        cursor={cursor === index}
        inRange={
          rangeFrom !== null &&
          rangeTo !== null &&
          rangeFrom !== rangeTo &&
          index >= rangeFrom &&
          index <= rangeTo
        }
        onComment={(at) => {
          setCursor(at);
          setRangeStart(null);
          comment(anchorOfRows(rows, at, at));
        }}
      >
        {notes === undefined ? null : notesOf(notes, false)}
        {newDraft}
      </Row>
    );
  };

  return (
    <div data-slot="changes-diff" data-path={file.path} className="min-w-0">
      {truncated ? (
        <p className="text-muted-foreground border-b px-3 py-1 text-2xs" data-slot="changes-diff-truncated">
          {t('changes.diff.truncated')}
        </p>
      ) : null}
      {placed.unplaced.length > 0 ? (
        <section
          data-slot="changes-unplaced"
          aria-label={t('changes.comments.unplaced')}
          className="border-b py-1"
        >
          <h4 className="text-muted-foreground px-3 text-2xs font-medium">
            {t('changes.comments.unplaced')}
          </h4>
          {notesOf(placed.unplaced, true)}
        </section>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2 text-xs" data-slot="changes-diff-empty">
          {t('changes.diff.empty')}
        </p>
      ) : (
        <div
          ref={regionRef}
          role="region"
          tabIndex={0}
          aria-label={t('changes.diff.label', { path: file.path })}
          aria-describedby={keysId}
          data-slot="changes-diff-lines"
          data-virtualized={virtual ? 'true' : undefined}
          className={cn(
            'focus-visible:ring-ring font-mono text-xs leading-5 outline-none [font-variant-ligatures:none] [tab-size:4] focus-visible:ring-2 focus-visible:ring-inset',
            virtual && 'max-h-[60vh] overflow-auto',
          )}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setSpoken('');
          }}
        >
          {virtual ? (
            <Virtualizer
              ref={handle}
              scrollRef={regionRef}
              data={rows}
              itemSize={toScreenPx(DIFF_LINE_HEIGHT, zoom)}
            >
              {(row, index) => renderRow(row, index)}
            </Virtualizer>
          ) : (
            rows.map(renderRow)
          )}
        </div>
      )}
      <span id={keysId} className="sr-only">
        {t('changes.diff.keys')}
      </span>
      <span aria-live="polite" className="sr-only" data-slot="changes-diff-announce">
        {spoken}
      </span>
      {draftHere?.target.kind === 'new' && draftRow === null
        ? editorFor(draftHere, null, commentLocation({ path: file.path, ...draftHere.target.anchor }))
        : null}
    </div>
  );
}
