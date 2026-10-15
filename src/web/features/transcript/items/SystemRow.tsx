import {
  BellIcon,
  BookOpenIcon,
  CircleStopIcon,
  LayersIcon,
  MessageSquareDashedIcon,
  RotateCwIcon,
  ScissorsIcon,
  ShieldXIcon,
  SquarePenIcon,
  WebhookIcon,
  type LucideIcon,
} from 'lucide-react';
import { memo, type ReactNode } from 'react';
import type { SystemItem } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { TONE_ICON, type AlertTone } from '@web/ui/alert';
import { CappedContent } from '../components/CappedContent';
import { Disclosure } from '../components/Disclosure';
import { TerminalOutput } from '../renderers/parts';
import { expansionKey } from '../state/expansion';

/**
 * System items (Plan "System-Elemente", architecture §6). Transcript notices have no live-region
 * role: the transcript is history (rows re-mount while scrolling); live hints come from the shell
 * (notifications, banners).
 */

const NOTICE_TONE: Readonly<Record<AlertTone, string>> = {
  info: 'border-info/30 bg-info/8 [&>svg]:text-info',
  warning: 'border-warning/35 bg-warning/8 [&>svg]:text-warning',
  error: 'border-destructive/35 bg-destructive/8 [&>svg]:text-destructive',
  success: 'border-success/30 bg-success/8 [&>svg]:text-success',
};

function Notice({ tone, title, children }: { tone: AlertTone; title: ReactNode; children?: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      data-tone={tone}
      className={cn(
        'grid grid-cols-[auto_1fr] items-start gap-x-2 rounded-md border px-3 py-1.5 text-xs [&>svg]:mt-0.5 [&>svg]:size-3.5',
        NOTICE_TONE[tone],
      )}
    >
      <Icon aria-hidden />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5">
        <div className="font-medium">{title}</div>
        {children === undefined ? null : <div className="text-muted-foreground break-words">{children}</div>}
      </div>
    </div>
  );
}

function Line({
  icon: Icon,
  children,
  className,
}: {
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('text-muted-foreground flex min-w-0 items-start gap-1.5 text-xs', className)}>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

/** Horizontal divider with a label (compaction, new conversation). */
function Divider({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div role="separator" className="text-muted-foreground flex items-center gap-2 py-1 text-2xs">
      <span className="bg-border h-px flex-1" />
      <Icon aria-hidden className="size-3.5" />
      <span>{children}</span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

/** Parts joined with " · " (computed outside JSX). */
function joined(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(' · ');
}

export const SystemRow = memo(function SystemRow({
  item,
  sessionKey,
}: {
  item: SystemItem;
  sessionKey: string;
}) {
  const { t, tError, format } = useI18n();
  switch (item.event) {
    case 'compact_boundary': {
      const label = joined([
        item.trigger === 'auto' ? t('transcript.system.compact.auto') : t('transcript.system.compact.manual'),
        item.preTokens === null || item.postTokens === null
          ? null
          : t('transcript.system.compact.tokens', {
              before: format.compact(item.preTokens),
              after: format.compact(item.postTokens),
            }),
      ]);
      return <Divider icon={ScissorsIcon}>{label}</Divider>;
    }
    case 'conversation_reset':
      return (
        <Divider icon={SquarePenIcon}>
          {item.trigger === null || item.trigger === ''
            ? t('transcript.system.conversationReset')
            : t('transcript.system.conversationResetTrigger', { trigger: item.trigger })}
        </Divider>
      );
    case 'api_retry': {
      const status =
        item.errorStatus === null
          ? null
          : t('transcript.system.apiRetry.status', { status: item.errorStatus });
      if (!item.active) {
        return (
          <Line icon={RotateCwIcon}>
            {joined([t('transcript.system.apiRetry.done', { count: item.attempt }), status])}
          </Line>
        );
      }
      return (
        <Notice
          tone="warning"
          title={t('transcript.system.apiRetry.active', {
            attempt: item.attempt,
            max: item.maxRetries,
            delay: format.duration(item.retryDelayMs),
          })}
        >
          {joined([tError({ code: item.errorCode, params: {} }), status])}
        </Notice>
      );
    }
    case 'rate_limit': {
      const { info } = item;
      const details = joined([
        info.utilization === null
          ? null
          : t('transcript.system.rateLimit.utilization', { percent: format.percent(info.utilization * 100) }),
        info.resetsAt === null
          ? null
          : t('transcript.system.rateLimit.resetsAt', { time: format.dateTime(info.resetsAt) }),
        info.rateLimitType,
      ]);
      return (
        <Notice
          tone={info.status === 'rejected' ? 'error' : 'warning'}
          title={
            info.status === 'rejected'
              ? t('transcript.system.rateLimit.rejected')
              : t('transcript.system.rateLimit.warning')
          }
        >
          {details === '' ? undefined : details}
        </Notice>
      );
    }
    case 'notification':
      return (
        <Line icon={BellIcon}>
          <span className="sr-only">{t('transcript.system.notification')}</span>
          {item.text}
        </Line>
      );
    case 'informational': {
      const warning = item.level === 'warning' || item.level === 'error';
      return (
        <Notice
          tone={warning ? 'warning' : 'info'}
          title={warning ? t('transcript.system.informationalWarning') : t('transcript.system.informational')}
        >
          <CappedContent text={item.text.text} truncated={item.text.truncated} sessionKey={sessionKey}>
            {(text) => <span className="whitespace-pre-wrap">{text}</span>}
          </CappedContent>
          {item.preventContinuation ? (
            <span className="block">{t('transcript.system.preventContinuation')}</span>
          ) : null}
        </Notice>
      );
    }
    case 'hook': {
      const label = (
        <span className="text-muted-foreground text-xs">
          {joined([
            t('transcript.system.hook', { name: item.hookName }),
            item.outcome === null
              ? null
              : t('transcript.system.hookOutcome', { event: item.hookEvent, outcome: item.outcome }),
          ])}
        </span>
      );
      if (item.output.text.trim() === '') return <Line icon={WebhookIcon}>{label}</Line>;
      return (
        <Disclosure stateKey={expansionKey(sessionKey, item.id)} header={label}>
          <div className="mt-1 ml-5">
            <CappedContent text={item.output.text} truncated={item.output.truncated} sessionKey={sessionKey}>
              {(text) => <TerminalOutput text={text} />}
            </CappedContent>
          </div>
        </Disclosure>
      );
    }
    case 'permission_denied':
      return (
        <Line icon={ShieldXIcon} className="text-destructive">
          <span className="font-medium">
            {t('transcript.system.permissionDenied', { tool: item.toolName })}
          </span>
          {item.message === '' ? null : <span className="text-muted-foreground block">{item.message}</span>}
        </Line>
      );
    case 'memory_recall':
      return (
        <Disclosure
          stateKey={expansionKey(sessionKey, item.id)}
          header={
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <BookOpenIcon aria-hidden className="size-3.5" />
              {t('transcript.system.memoryRecall', { count: item.memories.length })}
            </span>
          }
        >
          <ul className="mt-1 ml-5 grid gap-1.5">
            {item.memories.map((memory, index) => (
              <li key={index} className="grid gap-0.5 text-xs">
                <span className="font-mono">{joined([memory.path, memory.scope])}</span>
                {memory.content === null ? null : (
                  <CappedContent
                    text={memory.content.text}
                    truncated={memory.content.truncated}
                    sessionKey={sessionKey}
                  >
                    {(text) => (
                      <span className="text-muted-foreground line-clamp-6 whitespace-pre-wrap">{text}</span>
                    )}
                  </CappedContent>
                )}
              </li>
            ))}
          </ul>
        </Disclosure>
      );
    case 'local_command_output':
      return (
        <div className="grid gap-1">
          <span className="text-muted-foreground text-2xs">{t('transcript.system.localCommandOutput')}</span>
          <CappedContent text={item.text.text} truncated={item.text.truncated} sessionKey={sessionKey}>
            {(text) => <TerminalOutput text={text} />}
          </CappedContent>
        </div>
      );
    case 'model_fallback':
      return (
        <Notice
          tone="warning"
          title={t('transcript.system.modelFallback', { from: item.originalModel, to: item.fallbackModel })}
        >
          {item.text === '' ? undefined : item.text}
        </Notice>
      );
    case 'interrupted':
      return (
        <Line icon={CircleStopIcon}>
          {item.forToolUse ? t('transcript.system.interruptedTool') : t('transcript.system.interrupted')}
        </Line>
      );
    case 'task_notification':
      return (
        <Line icon={LayersIcon}>
          {joined([
            t('transcript.system.taskNotification', {
              description: item.task.description === '' ? item.task.taskId : item.task.description,
            }),
            item.task.status,
          ])}
          {item.task.summary === null || item.task.summary === '' ? null : (
            <span className="block whitespace-pre-wrap">{item.task.summary}</span>
          )}
        </Line>
      );
    case 'error':
      return (
        <Notice tone="error" title={t('transcript.system.error')}>
          {tError(item.error)}
        </Notice>
      );
    case 'unknown':
      return (
        <Disclosure
          stateKey={expansionKey(sessionKey, item.id)}
          header={
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <MessageSquareDashedIcon aria-hidden className="size-3.5" />
              {t('transcript.system.unknown', {
                type: item.sdkSubtype === null ? item.sdkType : `${item.sdkType}/${item.sdkSubtype}`,
              })}
            </span>
          }
        >
          <pre className="bg-muted/40 mt-1 ml-5 max-h-60 overflow-auto rounded-md border p-2 font-mono text-2xs whitespace-pre-wrap">
            {item.preview}
          </pre>
        </Disclosure>
      );
  }
});
