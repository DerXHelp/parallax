import { CircleStopIcon, CircleXIcon } from 'lucide-react';
import { memo } from 'react';
import type { TurnResultItem } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useSessionSelector } from '@web/state/hooks';
import { useTranscriptSettings } from '../context';
import { turnModels } from '../lib/turn-models';

const NO_MODELS: readonly string[] = Object.freeze([]);

/**
 * Quiet turn footer (Plan "Chat-Ansicht": Dauer, Tokens, Kosten): duration, tokens, requests;
 * costs only for API-key profiles (B "Kosten nur bei API-Key-Profilen") and only when the item
 * carries them. Synthetic turns (`/rename`, `/clear`: num_turns 0) are hidden. WP-74 (ADR-202): the
 * models that answered come first, as the ids the API reported (`claude-opus-… → claude-sonnet-…`) –
 * instead of a badge on every message.
 */
export const TurnFooter = memo(function TurnFooter({
  item,
  sessionKey,
}: {
  item: TurnResultItem;
  sessionKey: string;
}) {
  const { t, format } = useI18n();
  const settings = useTranscriptSettings();
  const models = useSessionSelector(
    sessionKey,
    (view: SessionViewState) => turnModels(view.items, item.id),
    NO_MODELS,
  );
  if (item.synthetic) return null;
  const modelText = models.join(' → ');
  const cost = item.costUsdTurn ?? item.costUsdTotal;
  const showCost = settings?.showCost === true && cost !== null;
  const input = item.usage.input + item.usage.cacheCreation;
  const parts = [
    format.duration(item.durationMs),
    t('transcript.turn.tokens', { input: format.compact(input), output: format.compact(item.usage.output) }),
    item.usage.cacheRead > 0
      ? t('transcript.turn.cached', { count: format.compact(item.usage.cacheRead) })
      : null,
    item.numTurns > 1 ? t('transcript.turn.turns', { count: item.numTurns }) : null,
    item.permissionDenials > 0 ? t('transcript.turn.denials', { count: item.permissionDenials }) : null,
  ].filter((part): part is string => part !== null);
  const OutcomeIcon =
    item.outcome === 'error' ? CircleXIcon : item.outcome === 'interrupted' ? CircleStopIcon : null;
  return (
    <div
      data-item-kind="turn_result"
      aria-label={t('transcript.turn.label')}
      role="group"
      className="text-muted-foreground flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-2xs tabular-nums"
    >
      {OutcomeIcon === null ? (
        <span className="sr-only">{t(`transcript.turn.outcome.${item.outcome}`)}</span>
      ) : (
        <span
          className={cn(
            'inline-flex items-center gap-1',
            item.outcome === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          <OutcomeIcon aria-hidden className="size-3" />
          {t(`transcript.turn.outcome.${item.outcome}`)}
        </span>
      )}
      {modelText === '' ? null : (
        <span data-slot="turn-models" title={modelText} className="max-w-80 truncate font-mono">
          <span className="sr-only">{t('transcript.turn.models', { models: modelText })}</span>
          <span aria-hidden>{modelText}</span>
        </span>
      )}
      <span>{parts.join(' · ')}</span>
      {showCost ? (
        <span title={t('transcript.turn.costTitle')}>
          {format.number(cost, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })}
        </span>
      ) : null}
      {item.errors.length === 0 ? null : (
        <span className="text-destructive w-full text-right break-words">{item.errors.join(' · ')}</span>
      )}
    </div>
  );
});
