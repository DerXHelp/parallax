import { BotIcon, PlugIcon, WorkflowIcon } from 'lucide-react';
import type { ElicitationDecision, Requester } from '@shared/model';
import { useT, type t as translateFn } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { elicitationServerText } from '../lib/elicitation';

/** "Main agent" / "Subagent: <description>" (Review A.6: every card names who asks). */
export function requesterText(requester: Requester, t: typeof translateFn): string {
  if (requester.kind === 'main') return t('decisions.requester.main');
  const name = requester.description ?? requester.agentId;
  return name.trim() === ''
    ? t('decisions.requester.subagentUnnamed')
    : t('decisions.requester.subagent', { name });
}

const LABEL_CLASS = 'text-muted-foreground inline-flex min-w-0 items-center gap-1 text-2xs';

export function RequesterLabel({ requester, className }: { requester: Requester; className?: string }) {
  const t = useT();
  const Icon = requester.kind === 'main' ? BotIcon : WorkflowIcon;
  return (
    <span
      data-slot="decision-requester"
      data-requester={requester.kind}
      className={cn(LABEL_CLASS, className)}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">{t('decisions.requester.label')}</span>
      <span className="truncate">{requesterText(requester, t)}</span>
    </span>
  );
}

/** WP-116: an elicitation is asked by its MCP server, not by an agent ("MCP server <name>"). */
export function ElicitationServerLabel({
  decision,
  className,
}: {
  decision: ElicitationDecision;
  className?: string;
}) {
  const t = useT();
  return (
    <span data-slot="decision-requester" data-requester="mcp" className={cn(LABEL_CLASS, className)}>
      <PlugIcon aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">{t('decisions.requester.label')}</span>
      <span className="truncate">{elicitationServerText(decision, t)}</span>
    </span>
  );
}
