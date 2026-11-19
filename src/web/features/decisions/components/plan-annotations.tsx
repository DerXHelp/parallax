import { MessageSquareIcon, MessageSquareTextIcon, StrikethroughIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { LIMITS } from '@shared/common';
import type { PlanAnnotation, PlanDecision } from '@shared/model';
import { useI18n, useT } from '@web/i18n';
import { splitPlanBlocks } from '@web/lib/plan-blocks';
import { annotationLines, sortAnnotations } from '@web/lib/plan-feedback';
import { useFeatureSlots } from '@web/shell/slots';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { revisePlan, usePlanFeedback } from '../lib/revise';
import { savePlanAnnotations, usePlanAnnotations } from '../state/annotations';
import { usePlanVersionAnnotations } from '../state/plan-data';
import { PlanAnnotator } from './PlanAnnotator';

/**
 * WP-93 (ADR-234): the annotation views of the plan tab – the open version (editable, with
 * "Keep planning"), an answered version (what was sent, read-only) and the previous version's
 * annotations above the diff of the next one.
 */

/** "(3)" next to "Keep planning" when the plan has annotations. */
export function AnnotationCount({ count }: { count: number }) {
  const t = useT();
  if (count === 0) return null;
  return (
    <Badge variant="secondary" data-slot="plan-annotation-badge" className="px-1.5">
      <span aria-hidden>{count}</span>
      <span className="sr-only">{t('decisions.annotations.count', { count })}</span>
    </Badge>
  );
}

/** "Keep planning (3)" of the plan tab: sends the annotations plus the composer text. */
function ReviseButton({ sessionKey, decision }: { sessionKey: string; decision: PlanDecision }) {
  const t = useT();
  const { format } = useI18n();
  const feedback = usePlanFeedback(sessionKey, decision);
  const [sending, setSending] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      {feedback.tooLong ? (
        <span role="alert" className="text-destructive text-2xs">
          {t('decisions.annotations.tooLong', {
            length: format.number(feedback.length),
            max: format.number(LIMITS.planFeedbackChars),
          })}
        </span>
      ) : null}
      <Button
        variant={feedback.count > 0 ? 'default' : 'outline'}
        size="sm"
        data-action="revise-annotations"
        title={t('decisions.annotations.sendHint')}
        disabled={sending || feedback.tooLong}
        onClick={() => {
          setSending(true);
          void revisePlan(sessionKey, decision, t).finally(() => {
            setSending(false);
          });
        }}
      >
        <MessageSquareTextIcon aria-hidden />
        {t('decisions.plan.keepPlanning')}
        <AnnotationCount count={feedback.count} />
      </Button>
    </span>
  );
}

/** The open version: annotate, then "Keep planning". */
export function OpenPlanAnnotations({
  sessionKey,
  decision,
  inline = false,
}: {
  sessionKey: string;
  decision: PlanDecision;
  /** Inside the card (no side panel): no sticky bar, no own send button (the card has one). */
  inline?: boolean;
}) {
  const t = useT();
  const annotations = usePlanAnnotations(decision);
  return (
    <PlanAnnotator
      sessionKey={sessionKey}
      text={decision.plan}
      annotations={annotations}
      onChange={(next) => {
        void savePlanAnnotations(sessionKey, decision, next);
      }}
      emptyHint={t('decisions.annotations.hint')}
      actions={inline ? undefined : <ReviseButton sessionKey={sessionKey} decision={decision} />}
      stickyBar={!inline}
    />
  );
}

/** An answered (or expired) version: its annotations read-only, else just the Markdown. */
export function VersionAnnotations({
  sessionKey,
  version,
  text,
  known,
}: {
  sessionKey: string;
  version: number;
  text: string;
  /** Annotations the client has already (an expired decision); null = ask `plan.read`. */
  known: readonly PlanAnnotation[] | null;
}) {
  const { Markdown } = useFeatureSlots();
  const loaded = usePlanVersionAnnotations(sessionKey, known === null ? version : null);
  const annotations = known ?? loaded ?? [];
  if (annotations.length === 0) return <Markdown text={text} sessionKey={sessionKey} />;
  return <PlanAnnotator sessionKey={sessionKey} text={text} annotations={annotations} onChange={null} />;
}

/** Above the diff to the previous version: what the user annotated there (with its old lines). */
export function PreviousAnnotations({
  sessionKey,
  version,
  text,
}: {
  sessionKey: string;
  version: number;
  text: string;
}) {
  const t = useT();
  const annotations = usePlanVersionAnnotations(sessionKey, version);
  const rows = useMemo(() => {
    if (annotations === null || annotations.length === 0) return [];
    const blocks = splitPlanBlocks(text);
    return sortAnnotations(text, annotations, blocks).map((annotation) => ({
      annotation,
      lines: annotationLines(blocks, annotation),
    }));
  }, [annotations, text]);
  if (rows.length === 0) return null;
  return (
    <section
      data-slot="plan-previous-annotations"
      className="bg-muted/30 mb-3 grid gap-1.5 rounded-md border p-2"
    >
      <h3 className="text-xs font-medium">
        {t('decisions.annotations.previousTitle', { count: rows.length, version })}
      </h3>
      <ol className="grid gap-1.5">
        {rows.map(({ annotation, lines }) => (
          <li key={annotation.id} className="flex gap-2 text-xs" data-kind={annotation.kind}>
            {annotation.kind === 'strike' ? (
              <StrikethroughIcon aria-hidden className="text-destructive mt-0.5 size-3.5 shrink-0" />
            ) : (
              <MessageSquareIcon aria-hidden className="text-warning mt-0.5 size-3.5 shrink-0" />
            )}
            <span className="grid min-w-0 gap-0.5">
              <span className="text-muted-foreground line-clamp-1 italic">
                {annotation.quote === '' ? t('decisions.annotations.wholeBlock') : annotation.quote}
                {lines === null ? null : (
                  <span className="ml-1.5 not-italic">
                    {t('decisions.annotations.oldLine', { line: lines.from, version })}
                  </span>
                )}
              </span>
              {annotation.kind === 'strike' ? (
                <span className="font-medium">{t('decisions.annotations.struck')}</span>
              ) : null}
              {annotation.comment.trim() === '' ? null : (
                <span className="break-words whitespace-pre-wrap">{annotation.comment.trim()}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
