import { MinimizeIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { parseSessionKey } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { ContextBreakdown, ContextGauge as ContextGaugeData } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { errorPayloadOf } from '@web/state/connection';
import {
  sendCommand,
  useSessionConnectionStatus,
  useSessionSelector,
  useSummarySelector,
} from '@web/state/hooks';
import { Button } from '@web/ui/button';
import { Gauge, gaugeLevel } from '@web/ui/gauge';
import { Popover, PopoverContent, PopoverTrigger } from '@web/ui/popover';
import { Spinner } from '@web/ui/spinner';
import { sendPrompt } from './lib/commands';

type Breakdown =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; data: ContextBreakdown }
  | { state: 'failed'; error: ErrorPayload };

/** The CLI's compact command (Plan "Context-Gauge … Compact-Button"; slash commands go as prompts). */
export const COMPACT_COMMAND = '/compact';

/**
 * Context gauge (C.1, Plan "Kopfleiste"): percentage + bar (from 70 % yellow, from 85 % red –
 * thresholds of the `Gauge` primitive, never color only: the percentage is always written). A
 * click shows the facts of the summary and loads the breakdown (`session.getContext`, only while
 * the session runs); "Compact now" sends `/compact` as a prompt.
 */
export const ContextGauge = memo(function ContextGauge({ sessionKey }: { sessionKey: string }) {
  const { t, format, tError } = useI18n();
  const context = useSummarySelector<ContextGaugeData | null>(sessionKey, (s) => s.context, null);
  const slashCommands = useSessionSelector<readonly string[] | null>(
    sessionKey,
    (view) => view.detail.init?.slashCommands ?? null,
    null,
  );
  const online = useSessionConnectionStatus(sessionKey) === 'open';
  const [breakdown, setBreakdown] = useState<Breakdown>({ state: 'idle' });
  const canCompact = slashCommands === null || slashCommands.includes(COMPACT_COMMAND.slice(1));

  const load = async () => {
    const parsed = parseSessionKey(sessionKey);
    if (parsed === null) return;
    setBreakdown({ state: 'loading' });
    try {
      const result = await sendCommand(sessionKey, {
        name: 'session.getContext',
        entryId: parsed.entryId,
        detail: 'summary',
      });
      setBreakdown({ state: 'ready', data: result.context });
    } catch (caught) {
      setBreakdown({ state: 'failed', error: errorPayloadOf(caught) });
    }
  };

  const percent = context?.percentage ?? null;
  const shown = breakdown.state === 'ready' ? breakdown.data : context;
  const total = shown === null ? 0 : shown.maxTokens;

  return (
    <Popover
      onOpenChange={(open) => {
        if (open && online) void load();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-slot="context-gauge"
          data-level={percent === null ? 'unknown' : gaugeLevel(percent)}
          aria-label={
            percent === null
              ? t('composer.context.unknown')
              : t('composer.context.button', { percent: format.percent(percent) })
          }
        >
          {percent === null ? (
            <span className="text-muted-foreground text-2xs">{t('composer.context.label')}</span>
          ) : (
            <Gauge value={percent} label={t('composer.context.label')} />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="grid gap-2 text-xs">
          <div className="font-semibold">{t('composer.context.title')}</div>
          {shown === null ? (
            <p className="text-muted-foreground">{t('composer.context.unknown')}</p>
          ) : (
            <div className="grid gap-1">
              <Gauge
                value={shown.percentage}
                label={t('composer.context.label')}
                barClassName="w-full"
                className="w-full"
              />
              <span>
                {t('composer.context.tokens', {
                  used: format.number(shown.totalTokens),
                  max: format.number(shown.maxTokens),
                })}
              </span>
              <span className="text-muted-foreground">{t(`composer.context.source.${shown.source}`)}</span>
              {shown.model === null ? null : (
                <span className="text-muted-foreground">
                  {t('composer.context.model', { model: shown.model })}
                </span>
              )}
            </div>
          )}
          <div className="grid gap-1 border-t pt-2">
            <div className="font-medium">{t('composer.context.breakdown')}</div>
            {breakdown.state === 'loading' ? (
              <span className="text-muted-foreground inline-flex items-center gap-1.5">
                <Spinner className="size-3" />
                {t('composer.context.loading')}
              </span>
            ) : null}
            {breakdown.state === 'failed' ? (
              <span className="text-muted-foreground">
                {breakdown.error.code === 'SESSION_NOT_RUNNING'
                  ? t('composer.context.unavailable')
                  : tError(breakdown.error)}
              </span>
            ) : null}
            {breakdown.state === 'idle' && !online ? (
              <span className="text-muted-foreground">{t('composer.context.unavailable')}</span>
            ) : null}
            {breakdown.state === 'ready' ? (
              <>
                <ul data-slot="context-categories" className="grid gap-1">
                  {breakdown.data.categories.map((category) => (
                    <li key={`${category.kind}:${category.name}`} className="grid gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{category.name}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {format.compact(category.tokens)}
                        </span>
                        <span className="text-muted-foreground w-16 text-right text-2xs">
                          {t(`composer.context.kinds.${category.kind}`)}
                        </span>
                      </span>
                      <span aria-hidden className="bg-muted block h-1 overflow-hidden rounded-full">
                        <span
                          className={cn(
                            'block h-full rounded-full',
                            category.kind === 'free' ? 'bg-muted-foreground/30' : 'bg-foreground/45',
                          )}
                          style={{
                            width: `${String(total > 0 ? Math.min(100, (category.tokens / total) * 100) : 0)}%`,
                          }}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
                {/* WP22-14: same total as /context, but the SDK splits the categories differently. */}
                <span data-slot="context-source" className="text-muted-foreground text-2xs">
                  {t('composer.context.categoriesSource')}
                </span>
                <span className="text-muted-foreground">
                  {breakdown.data.isAutoCompactEnabled === false
                    ? t('composer.context.autoCompactOff')
                    : breakdown.data.autoCompactThreshold === null
                      ? null
                      : t('composer.context.autoCompact', {
                          tokens: format.number(breakdown.data.autoCompactThreshold),
                        })}
                </span>
              </>
            ) : null}
          </div>
          {canCompact ? (
            <div className="grid gap-1 border-t pt-2">
              <Button
                variant="outline"
                size="sm"
                data-action="compact"
                disabled={!online}
                className="justify-self-start"
                onClick={() => {
                  void sendPrompt(sessionKey, COMPACT_COMMAND, 'next');
                }}
              >
                <MinimizeIcon aria-hidden />
                {t('composer.context.compact')}
              </Button>
              <span className="text-muted-foreground text-2xs">{t('composer.context.compactHint')}</span>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
});
