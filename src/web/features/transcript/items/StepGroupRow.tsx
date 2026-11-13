import { ChevronRightIcon, CircleXIcon, LayersIcon, LoaderCircleIcon } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import type { TranscriptItem } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useItems } from '@web/state/hooks';
import { ImageGallery, galleryImages } from '../components/ImageGallery';
import { useLazyTranscriptT } from '../i18n-lazy';
import { summarizeGroup, type GroupSummary } from '../lib/grouping';
import { getToolRenderer } from '../renderers';
import { toolLabel } from '../renderers/parts';
import type { Translate } from '../renderers/types';
import { setGroupOpen } from '../state/groups';

/** Tool names shown in the line; more kinds become "+n". */
const SHOWN_TOOLS = 3;

/** "Bash `pnpm build`" – the running step in the short form of its ToolCallRow. */
function runningText(item: TranscriptItem, t: Translate): string {
  if (item.kind !== 'tool_call') return t('transcript.group.runningThinking');
  const summary = getToolRenderer(item.toolName).summary?.(item, t) ?? null;
  const label = toolLabel(item.toolName, t);
  return t('transcript.group.running', { step: summary === null ? label : `${label} ${summary}` });
}

function headline(summary: GroupSummary, t: Translate): string {
  const steps = summary.tools + summary.hooks;
  if (steps > 0) return t('transcript.group.steps', { count: steps });
  if (summary.thoughts > 0) return t('transcript.group.thinking', { count: summary.thoughts });
  return t('transcript.group.notices', { count: summary.notices });
}

export interface StepGroupLineProps {
  groupKey: string;
  /** The members (null = not loaded). */
  items: readonly (TranscriptItem | null)[];
  /** The members with pictures in their result (the gallery). */
  imageItems: readonly (TranscriptItem | null)[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The line of a run of work steps in the compact transcript (WP-63 §1.5):
 * `▸ 12 steps · 9× Bash, 2× Read, 1× Write · 1 min 40 s` – while the group runs the current step
 * ("running: Bash `pnpm build`") instead of the duration; failed tool calls as a red counter that
 * opens the group; the pictures of all results as a gallery right below, also while closed. A
 * click toggles the steps (rows of their own below, built by the list). WP-69: hook runs count as
 * steps ("2× Hook"); the line takes its members as items, so the subagent panel (items of its own,
 * not in the store) draws the same line.
 */
export const StepGroupLine = memo(function StepGroupLine({
  groupKey,
  items,
  imageItems,
  open,
  onOpenChange,
}: StepGroupLineProps) {
  const { t, format } = useI18n();
  const lt = useLazyTranscriptT();
  const summary = useMemo(() => summarizeGroup(items), [items]);
  const images = useMemo(() => galleryImages(imageItems), [imageItems]);

  const tools = summary.toolCounts
    .slice(0, SHOWN_TOOLS)
    .map(({ name, count }) => t('transcript.group.toolCount', { count, tool: toolLabel(name, t) }));
  const more = summary.toolCounts.length - SHOWN_TOOLS;
  if (more > 0) tools.push(t('transcript.group.moreTools', { count: more }));
  if (summary.hooks > 0) tools.push(lt('group.hookCount', { count: summary.hooks }));
  const duration =
    summary.running === null &&
    summary.startAt !== null &&
    summary.endAt !== null &&
    summary.endAt > summary.startAt
      ? format.duration(summary.endAt - summary.startAt)
      : null;

  return (
    <div
      data-slot="step-group"
      data-group={groupKey}
      data-state={open ? 'open' : 'closed'}
      data-running={summary.running === null ? undefined : 'true'}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1"
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          title={open ? t('transcript.group.collapse') : t('transcript.group.expand')}
          data-action="toggle-group"
          onClick={() => {
            onOpenChange(!open);
          }}
          className="group/step hover:bg-accent/60 focus-visible:ring-ring text-muted-foreground flex min-h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-left text-xs outline-none focus-visible:ring-2"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
          {summary.running === null ? (
            <LayersIcon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <LoaderCircleIcon
              aria-hidden
              className="text-status-working size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            />
          )}
          <span className="text-foreground/85 shrink-0 font-medium">{headline(summary, t)}</span>
          {tools.length === 0 ? null : (
            <>
              <span aria-hidden>·</span>
              <span data-slot="group-tools" className="min-w-0 truncate">
                {format.list(tools, { type: 'unit', style: 'narrow' })}
              </span>
            </>
          )}
          {summary.running !== null ? (
            <>
              <span aria-hidden>·</span>
              <span
                data-slot="group-running"
                className="text-status-working min-w-0 truncate font-mono text-2xs"
              >
                {runningText(summary.running, t)}
              </span>
            </>
          ) : duration === null ? null : (
            <>
              <span aria-hidden>·</span>
              <span data-slot="group-duration" className="shrink-0 tabular-nums">
                {duration}
              </span>
            </>
          )}
        </button>
        {summary.errors === 0 ? null : (
          <button
            type="button"
            data-slot="group-errors"
            title={t('transcript.group.openErrors')}
            onClick={() => {
              onOpenChange(true);
            }}
            className="text-destructive hover:bg-destructive/10 focus-visible:ring-ring flex min-h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-2xs font-medium outline-none focus-visible:ring-2"
          >
            <CircleXIcon aria-hidden className="size-3.5" />
            {t('transcript.group.errors', { count: summary.errors })}
          </button>
        )}
      </div>
      <ImageGallery images={images} className="ml-5" />
    </div>
  );
});

/**
 * The group line of the session transcript: its members from the store (`useItems` – re-renders
 * only when one of them changes), the open state per session (`state/groups.ts`).
 */
export const StepGroupRow = memo(function StepGroupRow({
  sessionKey,
  groupKey,
  ids,
  imageIds,
  open,
}: {
  sessionKey: string;
  groupKey: string;
  ids: readonly string[];
  imageIds: readonly string[];
  open: boolean;
}) {
  const items = useItems(sessionKey, ids);
  const imageItems = useItems(sessionKey, imageIds);
  const onOpenChange = useCallback(
    (next: boolean) => {
      setGroupOpen(sessionKey, groupKey, next);
    },
    [sessionKey, groupKey],
  );
  return (
    <StepGroupLine
      groupKey={groupKey}
      items={items}
      imageItems={imageItems}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
});
