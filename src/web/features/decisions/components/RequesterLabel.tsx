import { BotIcon, WorkflowIcon } from 'lucide-react';
import type { Requester } from '@shared/model';
import { useT, type t as translateFn } from '@web/i18n';
import { cn } from '@web/lib/cn';

/** "Main agent" / "Subagent: <description>" (Review A.6: every card names who asks). */
export function requesterText(requester: Requester, t: typeof translateFn): string {
  if (requester.kind === 'main') return t('decisions.requester.main');
  const name = requester.description ?? requester.agentId;
  return name.trim() === ''
    ? t('decisions.requester.subagentUnnamed')
    : t('decisions.requester.subagent', { name });
}

export function RequesterLabel({ requester, className }: { requester: Requester; className?: string }) {
  const t = useT();
  const Icon = requester.kind === 'main' ? BotIcon : WorkflowIcon;
  return (
    <span
      data-slot="decision-requester"
      data-requester={requester.kind}
      className={cn('text-muted-foreground inline-flex min-w-0 items-center gap-1 text-2xs', className)}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">{t('decisions.requester.label')}</span>
      <span className="truncate">{requesterText(requester, t)}</span>
    </span>
  );
}
