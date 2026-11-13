import { BotIcon, SquareIcon } from 'lucide-react';
import { memo, useState } from 'react';
import type { TaskInfo } from '@shared/model';
import { useI18n, useT } from '@web/i18n';
import { shortPath } from '@web/lib/path-display';
import { isLiveToolStatus, isToolCallTaskLive } from '@web/lib/task-rows';
import { useNow } from '@web/state/clock';
import { useChildItemIds } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { BackgroundButton } from '../components/BackgroundButton';
import { Disclosure } from '../components/Disclosure';
import { ModelBadge } from '../components/ModelBadge';
import { ToolFileLink } from '../components/ToolFileLink';
import { ToolStatus } from '../components/ToolStatus';
import { useTranscriptSettings } from '../context';
import { readAgentInput, readAgentResult } from '../lib/tool-input';
import { ToolResultImages, ToolResultText } from '../renderers/parts';
import type { ToolBodyProps } from '../renderers/types';
import { expansionKey } from '../state/expansion';
import { stopTask } from '../state/tasks';

/**
 * Agent card (Plan "Agent: Subagent-Karte mit Status und Laufzeit", F.11, B "Message-Routing"):
 * title, type, status, runtime, usage and the subagent's own items – grouped by
 * `parentToolUseId` (`useChildItemIds`), collapsed in Phase 1. The tool status already follows
 * the task (completed → done, failed → error, stopped/killed → interrupted, WP-12).
 * WP-55: "Stop" while the task runs (`session.stopTask`; the composer's Stop ends only the turn,
 * F4), the output file as a `FileLink`, the progress summary (`task_progress.summary`, F5).
 */

function finishedDuration(task: TaskInfo | null): number | null {
  if (task === null) return null;
  if (task.usage !== null) return task.usage.durationMs;
  if (task.startedAt === null || task.endedAt === null) return null;
  const ms = Date.parse(task.endedAt) - Date.parse(task.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Runtime of a running agent (ticks once per second while mounted). */
function LiveRuntime({ since }: { since: string }) {
  const { t, format } = useI18n();
  const now = useNow(1000);
  const start = Date.parse(since);
  if (!Number.isFinite(start)) return null;
  return (
    <span className="tabular-nums">
      {t('transcript.agent.runtime', { duration: format.duration(Math.max(0, now - start)) })}
    </span>
  );
}

/** Stops the agent's task; stays busy until the task ends (the card then drops the button). */
function StopAgentButton({
  sessionKey,
  taskId,
  title,
}: {
  sessionKey: string;
  taskId: string;
  title: string;
}) {
  const t = useT();
  const [stopping, setStopping] = useState(false);
  const onStop = () => {
    setStopping(true);
    stopTask(sessionKey, taskId).then(
      (ok) => {
        if (!ok) setStopping(false);
      },
      () => {
        setStopping(false);
      },
    );
  };
  return (
    <Button
      size="sm"
      variant="outline"
      data-slot="agent-stop"
      disabled={stopping}
      aria-label={t('transcript.agent.stopLabel', { title })}
      onClick={onStop}
    >
      {stopping ? (
        <Spinner className="size-3" label={t('transcript.agent.stopping')} />
      ) : (
        <SquareIcon aria-hidden className="size-3" />
      )}
      {t('transcript.agent.stop')}
    </Button>
  );
}

function AgentSteps({ item, sessionKey }: ToolBodyProps) {
  const { t } = useI18n();
  const settings = useTranscriptSettings();
  const childIds = useChildItemIds(sessionKey, item.toolUseId);
  const Row = settings?.Row;
  if (childIds.length === 0 || Row === undefined) return null;
  return (
    <Disclosure
      stateKey={expansionKey(sessionKey, item.id, 'steps')}
      header={
        <span className="text-muted-foreground text-xs">
          {t('transcript.agent.steps', { count: childIds.length })}
        </span>
      }
    >
      <ol data-slot="agent-steps" className="mt-1 ml-2 grid gap-1.5 border-l pl-3">
        {childIds.map((id) => (
          <li key={id} className="min-w-0">
            <Row sessionKey={sessionKey} itemId={id} nested />
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}

export const AgentCard = memo(function AgentCard({ item, sessionKey }: ToolBodyProps) {
  const { t, format } = useI18n();
  const input = readAgentInput(item.input);
  const result = readAgentResult(item.result?.structured ?? null);
  const task = item.task;
  const taskDescription = task === null || task.description === '' ? null : task.description;
  const title = input?.description ?? taskDescription ?? item.toolName;
  const type = input?.subagent_type ?? task?.subagentType ?? null;
  // `pending` has not started: no live runtime, no Stop – the server would refuse it (CR3-07).
  const running = isLiveToolStatus(item.status);
  const startedAt = task?.startedAt ?? null;
  const duration = finishedDuration(task);
  const usage = task?.usage ?? null;
  const summary = task?.summary ?? null;
  const model = result?.resolvedModel ?? null;
  const outputFile = task?.outputFile ?? null;
  // The task panel's rule (`@web/lib/task-rows`): what `session.stopTask` takes.
  const stoppable = task !== null && isToolCallTaskLive(item);
  return (
    <div
      data-item-kind="tool_call"
      data-tool={item.toolName}
      data-status={item.status}
      className="bg-card grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 rounded-md border px-3 py-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
        <ToolStatus status={item.status} />
        <BotIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        <span className="sr-only">{t('transcript.agent.label')}</span>
        <span className="min-w-0 truncate font-medium">{title}</span>
        {type === null ? null : <Badge variant="outline">{type}</Badge>}
        <ModelBadge model={item.model} blockIndex={item.blockIndex} />
        <span className="flex-1" />
        <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-2xs">
          {running && startedAt !== null ? (
            <LiveRuntime since={startedAt} />
          ) : duration === null ? null : (
            <span className="tabular-nums">
              {t('transcript.agent.runtime', { duration: format.duration(duration) })}
            </span>
          )}
          {usage === null ? null : (
            <>
              <span>{t('transcript.agent.tokens', { count: format.compact(usage.totalTokens) })}</span>
              <span>{t('transcript.agent.toolUses', { count: usage.toolUses })}</span>
            </>
          )}
          {model === null ? null : <span>{t('transcript.agent.model', { model })}</span>}
        </span>
        {/* WP-65 §1.5: a subagent in the foreground can move to the background. */}
        {item.status === 'running' ? (
          <BackgroundButton sessionKey={sessionKey} toolUseId={item.toolUseId} title={title} />
        ) : null}
        {stoppable ? <StopAgentButton sessionKey={sessionKey} taskId={task.taskId} title={title} /> : null}
      </div>
      {summary === null || summary === '' ? null : (
        <p data-slot="agent-summary" className="text-ui break-words whitespace-pre-wrap">
          {summary}
        </p>
      )}
      {outputFile === null || outputFile === '' ? null : (
        <p
          data-slot="agent-output"
          className="text-muted-foreground flex min-w-0 items-center gap-1 text-2xs"
        >
          <span className="shrink-0">{t('transcript.agent.output')}</span>
          <span className="min-w-0 truncate *:max-w-full *:truncate *:align-bottom">
            {/* Absolute (task_notification.output_file / AgentOutput.outputFile). */}
            <ToolFileLink sessionKey={sessionKey} path={outputFile} cwd={null}>
              {shortPath(outputFile, 3)}
            </ToolFileLink>
          </span>
        </p>
      )}
      {input?.prompt === undefined ? null : (
        <Disclosure
          stateKey={expansionKey(sessionKey, item.id, 'prompt')}
          header={<span className="text-muted-foreground text-xs">{t('transcript.agent.task')}</span>}
        >
          <p className="text-muted-foreground mt-1 ml-5 text-xs break-words whitespace-pre-wrap">
            {input.prompt}
          </p>
        </Disclosure>
      )}
      {result?.isAsync === true || item.result === null ? null : (
        <Disclosure
          stateKey={expansionKey(sessionKey, item.id, 'result')}
          header={<span className="text-muted-foreground text-xs">{t('transcript.agent.summary')}</span>}
        >
          <div className="mt-1 ml-5">
            <ToolResultText item={item} sessionKey={sessionKey} hideLabel />
          </div>
        </Disclosure>
      )}
      {/* Pictures of the result without expanding it (R4W-03; the result text leaves them out). */}
      <ToolResultImages item={item} />
      <AgentSteps item={item} sessionKey={sessionKey} />
    </div>
  );
});
