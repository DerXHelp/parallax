import {
  BotIcon,
  LayersIcon,
  SquareIcon,
  SquareTerminalIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react';
import { memo } from 'react';
import { useI18n, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { resolveFilePath } from '@web/lib/file-refs';
import { pathTail } from '@web/lib/path-display';
import { useFeatureSlots } from '@web/shell/slots';
import { useNow } from '@web/state/clock';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { canStopTask, finishedDuration, type TaskKind, type TaskRow } from '../lib/rows';

const KIND_ICON: Readonly<Record<TaskKind, LucideIcon>> = {
  agent: BotIcon,
  bash: SquareTerminalIcon,
  workflow: WorkflowIcon,
  other: LayersIcon,
};

const KNOWN_STATUSES = ['started', 'running', 'pending', 'completed', 'failed', 'stopped', 'killed'] as const;
type KnownStatus = (typeof KNOWN_STATUSES)[number];

function isKnownStatus(status: string): status is KnownStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(status);
}

/** Runtime of a running task, ticking once per second. */
function LiveRuntime({ since }: { since: string }) {
  const { t, format } = useI18n();
  const now = useNow(1000);
  const start = Date.parse(since);
  if (!Number.isFinite(start)) return null;
  return (
    <span className="tabular-nums">
      {t('tasks.row.runtime', { duration: format.duration(Math.max(0, now - start)) })}
    </span>
  );
}

function KindBadge({ row }: { row: TaskRow }) {
  const t = useT();
  const label = row.kind === 'other' ? (row.taskType ?? '') : t(`tasks.kind.${row.kind}`);
  if (label === '') return null;
  return <Badge variant="outline">{label}</Badge>;
}

/**
 * One task of the panel (WP-55): kind, description, runtime, tokens/tool uses, progress summary,
 * output file (`FileLink`, no `verify` – the CLI named it) and Stop; finished tasks greyed out with
 * their status and end time.
 */
export const TaskRowView = memo(function TaskRowView({
  sessionKey,
  row,
  stopping,
  disabled,
  onStop,
}: {
  sessionKey: string;
  row: TaskRow;
  stopping: boolean;
  /** "Stop all" runs: single stops wait. */
  disabled: boolean;
  onStop: (row: TaskRow) => void;
}) {
  const { t, format } = useI18n();
  const { FileLink } = useFeatureSlots();
  const Icon = KIND_ICON[row.kind];
  const title = row.description === '' ? row.taskId : row.description;
  const duration = row.running ? null : finishedDuration(row);
  const output = row.outputFile === null ? null : resolveFilePath(row.outputFile, null);
  const status = isKnownStatus(row.status) ? t(`tasks.status.${row.status}`) : row.status;
  return (
    <li
      data-slot="task-row"
      data-task-id={row.taskId}
      data-state={row.running ? 'running' : 'finished'}
      className={cn(
        'bg-card grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-md border px-3 py-2',
        !row.running && 'opacity-60',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        <KindBadge row={row} />
        <span className="min-w-0 truncate font-medium" title={title}>
          {title}
        </span>
        <span className="flex-1" />
        {row.running ? null : (
          <span data-slot="task-status" className="text-muted-foreground shrink-0 text-2xs">
            {row.endedAt === null ? status : t('tasks.row.ended', { status, time: format.time(row.endedAt) })}
          </span>
        )}
        {canStopTask(row) ? (
          <Button
            size="sm"
            variant="outline"
            data-slot="task-stop"
            disabled={stopping || disabled}
            aria-label={t('tasks.row.stopLabel', { description: title })}
            onClick={() => {
              onStop(row);
            }}
          >
            {stopping ? (
              <Spinner className="size-3" label={t('tasks.row.stopping')} />
            ) : (
              <SquareIcon aria-hidden className="size-3" />
            )}
            {t('tasks.row.stop')}
          </Button>
        ) : null}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-2 text-2xs">
        {row.subagentType === null ? null : <span>{row.subagentType}</span>}
        {row.running && row.startedAt !== null ? <LiveRuntime since={row.startedAt} /> : null}
        {duration === null ? null : (
          <span className="tabular-nums">
            {t('tasks.row.runtime', { duration: format.duration(duration) })}
          </span>
        )}
        {row.usage === null ? null : (
          <>
            <span>{t('tasks.row.tokens', { count: format.compact(row.usage.totalTokens) })}</span>
            <span>{t('tasks.row.toolUses', { count: row.usage.toolUses })}</span>
          </>
        )}
      </div>
      {row.summary === null ? null : (
        <p data-slot="task-summary" className="text-xs break-words whitespace-pre-wrap">
          {row.summary}
        </p>
      )}
      {output === null ? null : (
        <p data-slot="task-output" className="text-muted-foreground flex min-w-0 items-center gap-1 text-2xs">
          <span className="shrink-0">{t('tasks.row.output')}</span>
          <span className="min-w-0 truncate *:max-w-full *:truncate *:align-bottom">
            <FileLink sessionKey={sessionKey} path={output} verify={false}>
              {pathTail(output, 3)}
            </FileLink>
          </span>
        </p>
      )}
    </li>
  );
});
