import { ListIcon } from 'lucide-react';
import { useRef } from 'react';
import type { DecisionId } from '@shared/common';
import type { Decision } from '@shared/model';
import { useT } from '@web/i18n';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { planTitle } from '../lib/plan';
import { requesterText } from './RequesterLabel';

function decisionLabel(decision: Decision, t: ReturnType<typeof useT>): string {
  switch (decision.kind) {
    case 'permission':
      return (
        decision.title ?? t('decisions.permission.title', { tool: decision.displayName ?? decision.toolName })
      );
    case 'question':
      return t('decisions.question.title', { count: decision.questions.length });
    case 'plan': {
      const ready = t('decisions.plan.ready', { version: decision.version });
      const title = planTitle(decision.plan);
      return title === null ? ready : `${ready} · ${title}`;
    }
  }
}

function decisionMeta(decision: Decision, t: ReturnType<typeof useT>): string {
  return `${t(`decisions.kind.${decision.kind}`)} · ${requesterText(decision.requester, t)}`;
}

/**
 * "+n more" (Review A.6): the queue of open decisions of the session, oldest first. Picking one
 * only changes which decision the bar shows (never answers); the focus then moves to its card.
 */
export function QueueMenu({
  decisions,
  displayedId,
  onPick,
}: {
  decisions: readonly Decision[];
  displayedId: DecisionId;
  onPick: (decisionId: DecisionId) => void;
}) {
  const t = useT();
  const picked = useRef<DecisionId | null>(null);
  const more = t('decisions.bar.more', { count: decisions.length - 1 });
  const oldestOpen = decisions.find((decision) => decision.state === 'open')?.id ?? decisions[0]?.id;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-action="queue"
          aria-label={`${more} · ${t('decisions.bar.moreLabel')}`}
        >
          <ListIcon aria-hidden />
          {more}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-w-96"
        onCloseAutoFocus={(event) => {
          const id = picked.current;
          picked.current = null;
          if (id === null) return;
          // The trigger belongs to the old card (unmounted): focus the newly shown card instead.
          event.preventDefault();
          onPick(id);
        }}
      >
        <DropdownMenuLabel>{t('decisions.bar.moreLabel')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={displayedId}
          onValueChange={(value) => {
            const decision = decisions.find((candidate) => candidate.id === value);
            if (decision !== undefined) picked.current = decision.id;
          }}
        >
          {decisions.map((decision) => (
            <DropdownMenuRadioItem key={decision.id} value={decision.id} className="items-start">
              <span className="grid min-w-0 gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate">{decisionLabel(decision, t)}</span>
                  {decision.state === 'expired' ? (
                    <Badge variant="warning">{t('decisions.expired.badge')}</Badge>
                  ) : null}
                  {decision.id === oldestOpen ? (
                    <Badge variant="outline">{t('decisions.bar.oldest')}</Badge>
                  ) : null}
                </span>
                <span className="text-muted-foreground text-2xs">{decisionMeta(decision, t)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
