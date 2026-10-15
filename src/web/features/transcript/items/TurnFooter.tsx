import { CircleStopIcon, CircleXIcon } from 'lucide-react';
import { memo } from 'react';
import type { TurnResultItem } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useTranscriptSettings } from '../context';

/**
 * Quiet turn footer (Plan "Chat-Ansicht": Dauer, Tokens, Kosten): duration, tokens, requests;
 * costs only for API-key profiles (B "Kosten nur bei API-Key-Profilen") and only when the item
 * carries them. Synthetic turns (`/rename`, `/clear`: num_turns 0) are hidden.
 */
export const TurnFooter = memo(function TurnFooter({ item }: { item: TurnResultItem }) {
  const { t, format } = useI18n();
  const settings = useTranscriptSettings();
  if (item.synthetic) return null;
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
