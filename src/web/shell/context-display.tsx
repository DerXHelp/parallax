import { FoldVerticalIcon } from 'lucide-react';
import { useMemo } from 'react';
import type { ContextGauge } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { contextDisplay, type ContextDisplay } from '@web/lib/context-display';

/**
 * Texts and parts of the context display in the sidebar row and the session header (WP-63 §1.4,
 * rule in `@web/lib/context-display`): short value ("260K"), the detail line for the tooltip and
 * `aria-valuetext`, and the "autocompact soon" symbol – its own channel, never a color.
 */
export interface ContextTexts {
  display: ContextDisplay;
  /** Short visible value: the used tokens ("260K"). */
  short: string;
  /** "260K of 400K until autocompact · model 1M (26 %)" or "120K of 200K (60 %)". */
  detail: string;
  /** "Autocompact in about 30K" while it is soon, else null. */
  compactSoon: string | null;
  /** "measured" / "estimated". */
  source: string;
}

export function useContextTexts(gauge: ContextGauge): ContextTexts {
  const { t, format } = useI18n();
  return useMemo(() => {
    const display = contextDisplay(gauge);
    const used = format.compact(display.usedTokens);
    const max = format.compact(display.maxTokens);
    const percent = format.percent(Math.floor(display.windowPercent));
    const detail =
      display.autoCompactAt === null
        ? t('shell.session.contextOfWindow', { used, max, percent })
        : t('shell.session.contextUntilCompact', {
            used,
            threshold: format.compact(display.autoCompactAt),
            max,
            percent,
          });
    return {
      display,
      short: used,
      detail,
      compactSoon:
        display.compactSoon && display.tokensUntilCompact !== null
          ? t('shell.session.contextCompactSoon', { left: format.compact(display.tokensUntilCompact) })
          : null,
      source: t(`shell.session.contextSource.${gauge.source}`),
    };
  }, [gauge, t, format]);
}

/** The "autocompact soon" symbol next to the value (decorative – the text says it). */
export function ContextCompactIcon({ className }: { className?: string }) {
  return (
    <FoldVerticalIcon
      aria-hidden
      data-slot="context-compact-soon"
      className={cn('text-muted-foreground size-3 shrink-0', className)}
    />
  );
}
