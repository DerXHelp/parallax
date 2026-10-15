import { BotIcon } from 'lucide-react';
import { memo } from 'react';
import type { TaskInfo } from '@shared/model';
import { useI18n } from '@web/i18n';
import { useNow } from '@web/state/clock';
import { useChildItemIds } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { Disclosure } from '../components/Disclosure';
import { ModelBadge } from '../components/ModelBadge';
import { ToolStatus } from '../components/ToolStatus';
import { useTranscriptSettings } from '../context';
import { readAgentInput, readAgentResult } from '../lib/tool-input';
import { ToolResultText } from '../renderers/parts';
import type { ToolBodyProps } from '../renderers/types';
import { expansionKey } from '../state/expansion';

/**
 * Agent card (Plan "Agent: Subagent-Karte mit Status und Laufzeit", F.11, B "Message-Routing"):
 * title, type, status, runtime, usage and the subagent's own items – grouped by
 * `parentToolUseId` (`useChildItemIds`), collapsed in Phase 1. The tool status already follows
 * the task (completed → done, failed → error, stopped/killed → interrupted, WP-12).
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
  const running = item.status === 'running' || item.status === 'background' || item.status === 'pending';
  const startedAt = task?.startedAt ?? null;
  const duration = finishedDuration(task);
  const usage = task?.usage ?? null;
  const summary = task?.summary ?? null;
  const model = result?.resolvedModel ?? null;
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
      </div>
      {summary === null || summary === '' ? null : (
        <p className="text-ui break-words whitespace-pre-wrap">{summary}</p>
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
      <AgentSteps item={item} sessionKey={sessionKey} />
    </div>
  );
});
