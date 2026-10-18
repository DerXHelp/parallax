import { ClockIcon, TimerResetIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { parseSessionKey } from '@shared/common';
import type { SessionSummary } from '@shared/model';
import type { StatusFacts } from '@shared/status';
import { useFormat, useT } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSessionConnectionStatus, useSummarySelector } from '@web/state/hooks';
import { useNowUntil } from '@web/state/clock';
import { showErrorNotice } from '@web/state/notices';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { rateLimitBannerState } from './lib/rate-limit';

type LimitFacts = Pick<StatusFacts, 'rateLimitedUntil' | 'wakeupAt' | 'runState' | 'lastTurn'>;

const NO_FACTS: LimitFacts = { rateLimitedUntil: null, wakeupAt: null, runState: 'idle', lastTurn: null };

const selectFacts = (summary: SessionSummary): LimitFacts => ({
  rateLimitedUntil: summary.status.rateLimitedUntil,
  wakeupAt: summary.status.wakeupAt,
  runState: summary.status.runState,
  lastTurn: summary.status.lastTurn,
});

/** A day: later resets (weekly limits) show date and time instead of only the time. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rate-limit banner above the message field (ADR-112, WP-37 §6): while the limit lasts "Usage
 * limit reached – resets at HH:MM" with "Continue at HH:MM" (`session.continueAfterLimit`
 * `enabled: true` plans a "continue"); planned → "Continue planned at HH:MM" + "Cancel"; after the
 * reset without a plan "Continue" (right away). Re-renders only when a deadline passes.
 */
export const RateLimitBanner = memo(function RateLimitBanner({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const format = useFormat();
  const facts = useSummarySelector(sessionKey, selectFacts, NO_FACTS);
  const now = useNowUntil([facts.rateLimitedUntil, facts.wakeupAt]);
  const online = useSessionConnectionStatus(sessionKey) === 'open';
  const [pending, setPending] = useState(false);
  const state = rateLimitBannerState(facts, now);
  if (state === null) return null;

  const when = (iso: string) => (Date.parse(iso) - now < DAY_MS ? format.time(iso) : format.dateTime(iso));

  const send = (enabled: boolean) => {
    const parsed = parseSessionKey(sessionKey);
    if (parsed === null) return;
    setPending(true);
    sendCommand(sessionKey, { name: 'session.continueAfterLimit', entryId: parsed.entryId, enabled })
      .catch((caught: unknown) => {
        showErrorNotice(errorPayloadOf(caught), { sessionKey, id: `composer.rateLimit.${sessionKey}` });
      })
      .finally(() => {
        setPending(false);
      });
  };

  let text: string;
  let action: string;
  let enabled: boolean;
  switch (state.kind) {
    case 'limited':
      text = t('composer.rateLimit.limited', { time: when(state.until) });
      action = t('composer.rateLimit.continueAt', { time: when(state.until) });
      enabled = true;
      break;
    case 'scheduled':
      text = t('composer.rateLimit.scheduled', { time: when(state.at) });
      action = t('composer.rateLimit.cancel');
      enabled = false;
      break;
    case 'expired':
      text = t('composer.rateLimit.expired');
      action = t('composer.rateLimit.continue');
      enabled = true;
      break;
  }
  const Icon = state.kind === 'scheduled' ? ClockIcon : TimerResetIcon;

  return (
    <div
      role="status"
      data-slot="rate-limit-banner"
      data-state={state.kind}
      className="border-warning/35 bg-warning/8 mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1 text-xs"
    >
      <Icon aria-hidden className="text-warning size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={!online || pending}
        onClick={() => {
          send(enabled);
        }}
      >
        {pending ? <Spinner className="size-3" /> : null}
        {action}
      </Button>
    </div>
  );
});
