import { BotIcon, LayersIcon, SquareTerminalIcon, type LucideIcon } from 'lucide-react';
import type { TaskKind } from '@shared/model';
import type { RunningTaskCounts } from '@shared/tasks';
import { useFormat, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';

/**
 * WP-71 "what runs where": the running tasks of a session by kind – agents, shells, the rest
 * (workflows, unknown kinds) – as small symbol counters (sidebar row, the header's "Tasks" button)
 * and as words ("2 agents and 1 shell"). Counted like the task panel (`@shared/tasks`): the row
 * reads `SessionSummary.runningTasks`, the header the session's detail.
 */

export type RunningGroup = 'agents' | 'shells' | 'misc';

interface RunningPart {
  group: RunningGroup;
  icon: LucideIcon;
  count: number;
}

/** The symbol of a task kind (the task panel uses the same ones). */
export const TASK_KIND_ICON: Readonly<Record<TaskKind, LucideIcon>> = {
  agent: BotIcon,
  bash: SquareTerminalIcon,
  workflow: LayersIcon,
  other: LayersIcon,
};

/** The groups with at least one running task, in a fixed order. */
function runningParts(counts: RunningTaskCounts): RunningPart[] {
  const parts: RunningPart[] = [];
  if (counts.agents > 0) parts.push({ group: 'agents', icon: BotIcon, count: counts.agents });
  if (counts.shells > 0) parts.push({ group: 'shells', icon: SquareTerminalIcon, count: counts.shells });
  if (counts.other > 0) parts.push({ group: 'misc', icon: LayersIcon, count: counts.other });
  return parts;
}

/** "2 agents and 1 shell" (en/de, plurals); '' when nothing runs. */
export function useRunningWords(counts: RunningTaskCounts): string {
  const t = useT();
  const format = useFormat();
  return format.list(
    runningParts(counts).map(({ group, count }) => t(`navigation.running.${group}`, { count })),
  );
}

/**
 * The counters: symbol + number per group, hidden from screen readers (the caller names them in
 * words). Counts above `max` show as "99+" (`navigation.panels.countOverflow`).
 */
export function RunningCounts({
  counts,
  max,
  className,
}: {
  counts: RunningTaskCounts;
  max: number;
  className?: string;
}) {
  const t = useT();
  return (
    <span aria-hidden className={cn('flex items-center gap-1.5 tabular-nums', className)}>
      {runningParts(counts).map(({ group, icon: Icon, count }) => (
        <span key={group} data-slot="running-count" data-group={group} className="flex items-center gap-0.5">
          <Icon className="size-3 shrink-0" />
          {count > max ? t('navigation.panels.countOverflow', { max }) : count}
        </span>
      ))}
    </span>
  );
}
