import { ArrowDownIcon, XIcon } from 'lucide-react';
import { useMemo } from 'react';
import type { SessionSummary, TranscriptItem, TurnSummary } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { useI18n } from '@web/i18n';
import { shortPath } from '@web/lib/path-display';
import { useSessionSelector, useSummarySelector } from '@web/state/hooks';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';
import { useTranscriptSettings } from '../context';
import { sinceFacts } from '../lib/since';
import { useSessionCwd } from '../state/tasks';
import { ToolFileLink } from './ToolFileLink';

/** Changed files listed by name; the rest as "and n more". */
const FILES_SHOWN = 5;

const EMPTY_ITEMS: readonly TranscriptItem[] = Object.freeze([]);
const selectItems = (view: SessionViewState): readonly TranscriptItem[] => view.items;
const selectTurnSummary = (summary: SessionSummary): TurnSummary | null => summary.turnSummary;

/**
 * WP-65 §1.2 "Since you were last here": a closable card at the top of the transcript when at least
 * one turn happened after `since` (the session's `lastSeenAt` when the transcript opened) – turns,
 * changed files (file links, at most 5 + "and n more"), answered and open decisions, the cost of
 * those turns (API-key profiles only, like the turn footer), the last turn summary and "To the first
 * new message". Computed from the loaded items (`lib/since.ts`).
 */
export function SinceLastVisit({
  sessionKey,
  since,
  onJump,
  onClose,
}: {
  sessionKey: string;
  since: string;
  onJump: (itemId: string) => void;
  onClose: () => void;
}) {
  const { t, format } = useI18n();
  const items = useSessionSelector(sessionKey, selectItems, EMPTY_ITEMS);
  const turnSummary = useSummarySelector(sessionKey, selectTurnSummary, null);
  const cwd = useSessionCwd(sessionKey);
  const settings = useTranscriptSettings();
  const facts = useMemo(() => sinceFacts(items, since), [items, since]);
  if (facts === null) return null;
  const summary = turnSummary !== null && Date.parse(turnSummary.at) > Date.parse(since) ? turnSummary.text : null;
  const more = facts.files.length - FILES_SHOWN;
  const firstItemId = facts.firstItemId;
  return (
    <section
      data-slot="since-last-visit"
      aria-labelledby={`since-${sessionKey}`}
      className="bg-card absolute inset-x-4 top-2 z-10 mx-auto grid max-w-3xl gap-1.5 rounded-md border px-3 py-2 text-xs shadow-md"
    >
      <div className="flex items-center gap-2">
        <h2 id={`since-${sessionKey}`} className="font-semibold">
          {t('transcript.since.title')}
        </h2>
        <span className="text-muted-foreground" data-slot="since-turns">
          {t('transcript.since.turns', { count: facts.turns })}
          {facts.answered > 0 ? (
            <>
              <span aria-hidden className="mx-1">
                ·
              </span>
              {t('transcript.since.answered', { count: facts.answered })}
            </>
          ) : null}
          {facts.open > 0 ? (
            <>
              <span aria-hidden className="mx-1">
                ·
              </span>
              <span className="text-status-waiting">{t('transcript.since.open', { count: facts.open })}</span>
            </>
          ) : null}
          {settings?.showCost === true && facts.costUsd !== null ? (
            <>
              <span aria-hidden className="mx-1">
                ·
              </span>
              {t('transcript.since.cost', {
                cost: format.number(facts.costUsd, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }),
              })}
            </>
          ) : null}
        </span>
        <span className="flex-1" />
        <IconButton label={t('transcript.since.close')} size="icon-xs" data-action="since-close" onClick={onClose}>
          <XIcon aria-hidden />
        </IconButton>
      </div>
      {facts.files.length === 0 ? null : (
        <p data-slot="since-files" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-muted-foreground">{t('transcript.since.files', { count: facts.files.length })}</span>
          {facts.files.slice(0, FILES_SHOWN).map((path) => (
            <span key={path} className="min-w-0 truncate">
              <ToolFileLink sessionKey={sessionKey} path={path} cwd={cwd}>
                {shortPath(path, 2)}
              </ToolFileLink>
            </span>
          ))}
          {more > 0 ? <span className="text-muted-foreground">{t('transcript.since.more', { count: more })}</span> : null}
        </p>
      )}
      {summary === null ? null : (
        <p data-slot="since-summary" className="min-w-0 break-words">
          <span className="text-muted-foreground mr-1">{t('transcript.since.summary')}</span>
          {summary}
        </p>
      )}
      {firstItemId === null ? null : (
        <Button
          size="sm"
          variant="outline"
          data-action="since-jump"
          className="justify-self-start"
          onClick={() => {
            onJump(firstItemId);
          }}
        >
          <ArrowDownIcon aria-hidden />
          {t('transcript.since.jump')}
        </Button>
      )}
    </section>
  );
}
