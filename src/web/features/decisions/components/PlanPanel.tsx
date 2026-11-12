import { ArrowDownToLineIcon, ChevronDownIcon, ClipboardListIcon, FileTextIcon } from 'lucide-react';
import { lazy, memo, Suspense, useId, useMemo, useState, type ReactNode } from 'react';
import type { PlanDecision } from '@shared/model';
import { useI18n, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { focusDecision } from '@web/shell/decision-focus';
import { useFeatureSlots } from '@web/shell/slots';
import {
  useDecisions,
  useItem,
  useSessionDetail,
  useSessionSelector,
  useSummarySelector,
} from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Badge, type BadgeProps } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { Skeleton } from '@web/ui/skeleton';
import { Spinner } from '@web/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@web/ui/toggle-group';
import { NO_OUTCOMES, selectDecisionOutcomes } from '../lib/outcomes';
import { liveWriteContent } from '../lib/plan-file';
import {
  isPendingStatus,
  mergePlanVersions,
  planStatusLabel,
  previousPlanVersion,
  resolvePlanView,
  type PlanPanelView,
  type PlanVersionEntry,
  type PlanVersionStatus,
} from '../lib/plan-versions';
import { choosePlanView, usePlanPanel, usePlanViewChoice } from '../state/bar-store';
import {
  usePlanFileActivity,
  usePlanFileText,
  usePlanText,
  usePlanVersions,
  type TextState,
} from '../state/plan-data';

/** The line diff is a chunk of its own (loaded when the user switches to "Changes"). */
const PlanDiff = lazy(() => import('./PlanDiff'));

type PanelMode = 'plan' | 'changes';

const STATUS_BADGE: Readonly<Record<PlanVersionStatus['kind'], NonNullable<BadgeProps['variant']>>> = {
  open: 'warning',
  waiting: 'warning',
  revised: 'secondary',
  approved: 'success',
  cancelled: 'outline',
  expired: 'outline',
  closed: 'outline',
};

function viewKey(view: PlanPanelView): string {
  return view === 'current' ? 'current' : `v${String(view)}`;
}

function parseViewKey(key: string): PlanPanelView | null {
  if (key === 'current') return 'current';
  const version = Number(key.slice(1));
  return key.startsWith('v') && Number.isInteger(version) && version > 0 ? version : null;
}

function isPlanDecision(decision: { kind: string }): decision is PlanDecision {
  return decision.kind === 'plan';
}

function parseTime(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

function newest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function LoadingRows({ label }: { label: string }) {
  return (
    <div data-slot="plan-loading" role="status" aria-label={label} className="grid gap-2">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div
      data-slot="plan-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <ClipboardListIcon aria-hidden className="text-muted-foreground size-6" />
      <p className="text-sm font-medium">{t('decisions.panel.empty')}</p>
      <p className="text-muted-foreground max-w-72 text-xs">{t('decisions.panel.emptyHint')}</p>
    </div>
  );
}

/** "Plan" or the line diff to the previous text (both texts may still load). */
function PlanBody({
  sessionKey,
  text,
  mode,
  previous,
}: {
  sessionKey: string;
  text: TextState;
  mode: PanelMode;
  /** The compared version and its text (diff mode only). */
  previous: { version: number; text: TextState } | null;
}) {
  const { t, tError } = useI18n();
  const { Markdown } = useFeatureSlots();
  const loading = <LoadingRows label={t('decisions.panel.loading')} />;
  if (text.text === null) {
    if (text.error !== null) {
      return (
        <Alert tone="error" title={t('decisions.panel.loadError')}>
          {tError(text.error)}
        </Alert>
      );
    }
    return loading;
  }
  if (mode === 'changes' && previous !== null) {
    if (previous.text.text === null) {
      if (previous.text.error !== null) {
        return (
          <Alert tone="error" title={t('decisions.panel.loadError')}>
            {tError(previous.text.error)}
          </Alert>
        );
      }
      return <LoadingRows label={t('decisions.panel.diffLoading')} />;
    }
    return (
      <Suspense fallback={<LoadingRows label={t('decisions.panel.diffLoading')} />}>
        <PlanDiff oldText={previous.text.text} newText={text.text} previousVersion={previous.version} />
      </Suspense>
    );
  }
  return <Markdown text={text.text} sessionKey={sessionKey} />;
}

/** A stored version (`plan.read`, or the text the client already knows). */
function VersionContent({
  sessionKey,
  version,
  entry,
  previous,
  mode,
}: {
  sessionKey: string;
  version: number;
  entry: PlanVersionEntry | null;
  previous: PlanVersionEntry | null;
  mode: PanelMode;
}) {
  const text = usePlanText(sessionKey, version, entry?.knownText ?? null);
  const previousKnown =
    previous === null
      ? null
      : ((previous.version === version - 1 ? entry?.knownPreviousText : null) ?? previous.knownText);
  const previousText = usePlanText(
    sessionKey,
    mode === 'changes' && previous !== null ? previous.version : null,
    previousKnown,
  );
  return (
    <PlanBody
      sessionKey={sessionKey}
      text={text}
      mode={mode}
      previous={previous === null ? null : { version: previous.version, text: previousText }}
    />
  );
}

/**
 * The plan file: live from the running `Write` (Markdown of the streamed `content`, "being
 * written…"), else its content from `GET /api/file` (again after every finished write); a failed
 * load shows the plan of the decision instead.
 */
function CurrentContent({
  sessionKey,
  path,
  liveItemId,
  stamp,
  fallback,
  latest,
  mode,
}: {
  sessionKey: string;
  path: string | null;
  liveItemId: string | null;
  stamp: string;
  fallback: string | null;
  latest: PlanVersionEntry | null;
  mode: PanelMode;
}) {
  const t = useT();
  const live = liveItemId !== null;
  const file = usePlanFileText(sessionKey, path, stamp, !live);
  const latestText = usePlanText(
    sessionKey,
    mode === 'changes' && latest !== null && !live ? latest.version : null,
    latest?.knownText ?? null,
  );
  if (live) return <LivePreview sessionKey={sessionKey} itemId={liveItemId} />;
  if (path === null) {
    // The file is gone (e.g. a new conversation) – the plan of the decision, if there is one.
    return fallback === null ? (
      <EmptyState />
    ) : (
      <PlanBody
        sessionKey={sessionKey}
        text={{ text: fallback, error: null, loading: false }}
        mode="plan"
        previous={null}
      />
    );
  }
  let text: TextState = file;
  let note: ReactNode = null;
  if (file.text === null && file.error !== null && fallback !== null) {
    text = { text: fallback, error: null, loading: false };
    note = (
      <p data-slot="plan-file-fallback" className="text-muted-foreground mb-2 text-2xs">
        {t('decisions.panel.fileFallback')}
      </p>
    );
  }
  return (
    <>
      {note}
      <PlanBody
        sessionKey={sessionKey}
        text={text}
        mode={mode}
        previous={latest === null ? null : { version: latest.version, text: latestText }}
      />
    </>
  );
}

/** Markdown of the streamed `Write` input – re-renders with every delta of that one item. */
function LivePreview({ sessionKey, itemId }: { sessionKey: string; itemId: string }) {
  const { Markdown } = useFeatureSlots();
  const item = useItem(sessionKey, itemId);
  const text = item?.kind === 'tool_call' ? liveWriteContent(item) : '';
  return (
    <div data-slot="plan-live">
      <Markdown text={text} sessionKey={sessionKey} />
    </div>
  );
}

function VersionMenu({
  view,
  entries,
  hasFile,
  live,
  onChoose,
}: {
  view: PlanPanelView;
  entries: readonly PlanVersionEntry[];
  hasFile: boolean;
  live: boolean;
  onChoose: (view: PlanPanelView) => void;
}) {
  const { t, format } = useI18n();
  const current = view === 'current' ? null : (entries.find((entry) => entry.version === view) ?? null);
  const value =
    view === 'current' ? t('decisions.panel.current') : t('decisions.panel.versionItem', { version: view });
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-slot="plan-version-menu"
          aria-label={t('decisions.panel.versionMenuValue', { value })}
          className="max-w-full min-w-0"
        >
          <span className="truncate">{value}</span>
          {current === null ? null : (
            <span className="text-muted-foreground truncate font-normal">
              {planStatusLabel(current.status, t)}
            </span>
          )}
          <ChevronDownIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-96 min-w-60">
        <DropdownMenuLabel>{t('decisions.panel.versionMenu')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={viewKey(view)}
          onValueChange={(key) => {
            const next = parseViewKey(key);
            if (next !== null) onChoose(next);
          }}
        >
          {hasFile || live ? (
            <DropdownMenuRadioItem value="current" className="items-start">
              <span className="grid min-w-0 gap-0.5">
                <span className="font-medium">{t('decisions.panel.current')}</span>
                <span className="text-muted-foreground text-2xs">
                  {live ? t('decisions.panel.currentWriting') : t('decisions.panel.currentHint')}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ) : null}
          {entries.map((entry) => (
            <DropdownMenuRadioItem key={entry.version} value={viewKey(entry.version)} className="items-start">
              <span className="grid min-w-0 gap-0.5">
                <span className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="font-medium">
                    {t('decisions.panel.versionItem', { version: entry.version })}
                  </span>
                  <span className="text-muted-foreground text-2xs">{planStatusLabel(entry.status, t)}</span>
                </span>
                {entry.createdAt === null && entry.stored ? null : (
                  <span className="text-muted-foreground text-2xs">
                    {entry.createdAt === null ? null : (
                      <time dateTime={entry.createdAt}>{format.dateTime(entry.createdAt)}</time>
                    )}
                    {entry.stored ? null : (
                      <span className={cn(entry.createdAt !== null && 'ml-1.5')}>
                        {t('decisions.panel.notStored')}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Content of the side panel tab "Plan" (slot `PlanPanel`, ADR-148/150; lazy chunk of
 * PlanSidePanel): the plan file live while Claude writes it, every stored version (`plan.list`,
 * newest first, with its status) as Markdown or as the line diff to the version before, the plan
 * file as a `FileLink`, and "Go to decision" while a plan decision waits. It stays usable after the
 * approval (header "Plan", WP-58) and never answers anything. Which version shows: the user's
 * pick, else the automatic rule (lib/plan-versions.ts).
 */
const PlanPanel = memo(function PlanPanel({ sessionKey }: { sessionKey: string }) {
  const { t, tError } = useI18n();
  const { FileLink } = useFeatureSlots();
  const detail = useSessionDetail(sessionKey);
  const decisions = useDecisions(sessionKey);
  const copy = usePlanPanel(sessionKey);
  const choice = usePlanViewChoice(sessionKey);
  const planMode = useSummarySelector(sessionKey, (summary) => summary.permissionMode === 'plan', false);
  const outcomes = useSessionSelector(sessionKey, selectDecisionOutcomes, NO_OUTCOMES);
  const [mode, setMode] = useState<PanelMode>('plan');

  const planDecisions = decisions.filter(isPlanDecision);
  const newestDecision = planDecisions.at(-1) ?? null;
  const refreshKey = `${String(detail?.latestPlanVersion ?? '')}|${planDecisions.map((d) => `${d.id}:${d.state}`).join(',')}`;
  const list = usePlanVersions(sessionKey, refreshKey);
  const entries = useMemo(
    () => mergePlanVersions(list.versions, decisions, outcomes, copy),
    [copy, decisions, list.versions, outcomes],
  );
  // The plan file: the engine's, else the open decision's, the copy's or the newest version's.
  const knownPath =
    detail?.planFile?.path ??
    newestDecision?.planFilePath ??
    copy?.planFilePath ??
    entries[0]?.planFilePath ??
    null;
  const activity = usePlanFileActivity(sessionKey, { planPath: knownPath, planMode });
  const filePath = knownPath ?? activity.path;
  const fileWrittenAt = newest(activity.writtenAt, parseTime(detail?.planFile?.updatedAt));
  const view = resolvePlanView(choice, {
    liveItemId: activity.liveItemId,
    hasFile: filePath !== null,
    fileWrittenAt,
    entries,
  });
  const live = view === 'current' && activity.liveItemId !== null;
  const entry =
    typeof view === 'number' ? (entries.find((candidate) => candidate.version === view) ?? null) : null;
  const previous = typeof view === 'number' ? previousPlanVersion(entries, view) : (entries[0] ?? null);
  const canDiff = previous !== null && !live;
  const effectiveMode: PanelMode = mode === 'changes' && canDiff ? 'changes' : 'plan';
  const pending = entries.find((candidate) => isPendingStatus(candidate.status)) ?? null;
  const headingId = useId();
  const fallback = newestDecision?.plan ?? copy?.plan ?? entries[0]?.knownText ?? null;
  const stamp = `${detail?.planFile?.updatedAt ?? ''}|${String(activity.writtenAt ?? '')}`;

  const choose = (next: PlanPanelView) => {
    choosePlanView(sessionKey, {
      view: next,
      decisionId: null,
      basisVersion: entries[0]?.version ?? null,
      basisLiveItemId: activity.liveItemId,
    });
  };

  let title: string;
  if (view === null) title = t('decisions.kind.plan');
  else if (view === 'current') title = t('decisions.panel.currentTitle');
  else title = t('decisions.panel.title', { version: view });

  return (
    <section
      data-plan-panel={sessionKey}
      data-slot="plan-panel"
      data-plan-view={view === null ? 'none' : viewKey(view)}
      data-plan-mode={effectiveMode}
      aria-labelledby={headingId}
      aria-busy={list.loading}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2">
        <div className="flex min-h-7 min-w-0 items-center gap-2">
          <FileTextIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
          <h2 id={headingId} className="text-ui min-w-0 truncate font-semibold">
            {title}
          </h2>
          {entry === null ? null : (
            <Badge
              variant={STATUS_BADGE[entry.status.kind]}
              data-slot="plan-status"
              className="min-w-0 truncate"
            >
              {planStatusLabel(entry.status, t)}
            </Badge>
          )}
          {live ? (
            <Badge variant="info" data-slot="plan-writing">
              <Spinner label={t('decisions.panel.writing')} className="size-3" />
              {t('decisions.panel.currentWriting')}
            </Badge>
          ) : null}
          <span className="flex-1" />
          {pending === null ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                focusDecision(sessionKey, pending.decisionId);
              }}
            >
              <ArrowDownToLineIcon aria-hidden />
              {t('decisions.panel.goTo')}
            </Button>
          )}
        </div>
        {view === null ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <VersionMenu
              view={view}
              entries={entries}
              hasFile={filePath !== null}
              live={activity.liveItemId !== null}
              onChoose={choose}
            />
            {previous === null ? null : (
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={effectiveMode}
                aria-label={t('decisions.panel.view')}
                onValueChange={(next) => {
                  if (next === 'plan' || next === 'changes') setMode(next);
                }}
              >
                <ToggleGroupItem value="plan" className="flex-none px-2">
                  {t('decisions.panel.viewPlan')}
                </ToggleGroupItem>
                {/* No diff while the file is being written (it changes with every delta). */}
                <ToggleGroupItem value="changes" className="flex-none px-2" disabled={!canDiff}>
                  {t('decisions.panel.viewChanges', { version: previous.version })}
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>
        )}
        {filePath === null ? null : (
          <div
            className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-2xs"
            data-slot="plan-file"
          >
            <span className="shrink-0">{t('decisions.panel.file')}</span>
            <span className="min-w-0">
              <FileLink sessionKey={sessionKey} path={filePath} verify={false} variant="chip" />
            </span>
          </div>
        )}
      </header>
      {list.error === null ? null : (
        <div className="shrink-0 px-3 pt-2">
          <Alert tone="warning" title={t('decisions.panel.listError')}>
            {tError(list.error)}
          </Alert>
        </div>
      )}
      {view === null ? (
        list.loading ? (
          <div className="px-4 py-3">
            <LoadingRows label={t('decisions.panel.loading')} />
          </div>
        ) : (
          <EmptyState />
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-slot="plan-content">
          {view === 'current' ? (
            <CurrentContent
              sessionKey={sessionKey}
              path={filePath}
              liveItemId={activity.liveItemId}
              stamp={stamp}
              fallback={fallback}
              latest={previous}
              mode={effectiveMode}
            />
          ) : (
            <VersionContent
              key={view}
              sessionKey={sessionKey}
              version={view}
              entry={entry}
              previous={previous}
              mode={effectiveMode}
            />
          )}
        </div>
      )}
    </section>
  );
});

export default PlanPanel;
