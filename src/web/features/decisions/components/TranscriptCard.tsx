import { ArrowDownToLineIcon, ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import type { Decision } from '@shared/model';
import type { DisplayStatusKind } from '@shared/status';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { focusDecision } from '@web/shell/decision-focus';
import { useFeatureSlots } from '@web/shell/slots';
import { Button } from '@web/ui/button';
import { StatusIcon } from '@web/ui/status-icon';
import { planTitle } from '../lib/plan';
import { summarizeToolInput } from '../lib/tool-input';
import { RequesterLabel } from './RequesterLabel';

const STATUS: Readonly<Record<Decision['kind'], DisplayStatusKind>> = {
  permission: 'needs-permission',
  question: 'needs-answer',
  plan: 'needs-review',
};

/** Plans longer than this are clamped until "Show full plan". */
const CLAMP_CHARS = 1200;

function Body({ sessionKey, decision }: { sessionKey: string; decision: Decision }) {
  const t = useT();
  const { Markdown } = useFeatureSlots();
  const [expanded, setExpanded] = useState(false);
  switch (decision.kind) {
    case 'plan': {
      const long = decision.plan.length > CLAMP_CHARS;
      return (
        <div>
          <div
            data-slot="transcript-plan"
            className={cn('relative', long && !expanded && 'max-h-56 overflow-hidden')}
          >
            <Markdown text={decision.plan} sessionKey={sessionKey} />
            {long && !expanded ? (
              <span
                aria-hidden
                className="from-card pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t"
              />
            ) : null}
          </div>
          {long ? (
            <Button
              variant="link"
              size="sm"
              className="px-0"
              aria-expanded={expanded}
              onClick={() => {
                setExpanded((value) => !value);
              }}
            >
              <ChevronDownIcon aria-hidden className={cn('transition-transform', expanded && 'rotate-180')} />
              {expanded ? t('decisions.transcript.showLess') : t('decisions.transcript.showMore')}
            </Button>
          ) : null}
        </div>
      );
    }
    case 'permission':
      return (
        <p className="text-muted-foreground font-mono text-2xs break-all">
          {summarizeToolInput(decision.toolName, decision.input).text}
        </p>
      );
    case 'question':
      return (
        <ul className="text-muted-foreground list-disc pl-4 text-xs">
          {decision.questions.map((question) => (
            <li key={question.question}>{question.question}</li>
          ))}
        </ul>
      );
  }
}

/**
 * Read-only card for the transcript (`placement: 'transcript'`, architecture §2.3e, ADR-031):
 * plan text (slot `Markdown`), status (icon + text) and "Go to decision" (→ focusDecision). No
 * answer controls – the bar is the only operable instance.
 */
export function TranscriptCard({ sessionKey, decision }: { sessionKey: string; decision: Decision }) {
  const t = useT();
  const expired = decision.state === 'expired';
  const status = expired ? 'needs-resume' : STATUS[decision.kind];
  let heading: string;
  if (decision.kind === 'plan') {
    const title = planTitle(decision.plan);
    const ready = t('decisions.plan.ready', { version: decision.version });
    heading = title === null ? ready : `${ready} · ${title}`;
  } else if (decision.kind === 'permission') {
    heading =
      decision.title ?? t('decisions.permission.title', { tool: decision.displayName ?? decision.toolName });
  } else {
    heading = t('decisions.question.title', { count: decision.questions.length });
  }
  return (
    <article
      data-slot="decision-card-transcript"
      data-decision-kind={decision.kind}
      data-decision-state={decision.state}
      aria-label={heading}
      className="bg-card text-card-foreground grid gap-2 rounded-lg border px-3 py-2"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="min-w-0 truncate font-semibold">{heading}</span>
        <RequesterLabel requester={decision.requester} />
      </header>
      <Body sessionKey={sessionKey} decision={decision} />
      <footer className="flex flex-wrap items-center gap-2">
        <StatusIcon kind={status} showLabel className="text-xs" />
        <span className="text-muted-foreground text-2xs">
          {expired ? t('decisions.transcript.expired') : t('decisions.transcript.waiting')}
        </span>
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          data-action="go-to-decision"
          onClick={() => {
            focusDecision(sessionKey, decision.id);
          }}
        >
          <ArrowDownToLineIcon aria-hidden />
          {t('decisions.transcript.goTo')}
        </Button>
      </footer>
    </article>
  );
}
