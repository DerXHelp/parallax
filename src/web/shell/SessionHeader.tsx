import { FolderIcon } from 'lucide-react';
import { memo } from 'react';
import { LOCAL_HOST_ID, parseSessionKey } from '@shared/common';
import type { ContextGauge } from '@shared/model';
import { useI18n, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { pathTail } from '@web/lib/path-display';
import { sessionTitle } from '@web/lib/session-title';
import { cliVersionStatus, knownVersion } from '@web/lib/version';
import { useDisplayStatus, useHostState, useSummary } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { Gauge } from '@web/ui/gauge';
import { StatusIcon } from '@web/ui/status-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';

/** Context fill as a compact, read-only meter; tokens and source in the tooltip. */
function HeaderContext({ context }: { context: ContextGauge }) {
  const { t, format } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-slot="header-context" className="inline-flex">
          <Gauge value={context.percentage} label={t('shell.session.context')} barClassName="w-10" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="tabular-nums">
          {t('shell.session.contextTokens', {
            used: format.compact(context.totalTokens),
            max: format.compact(context.maxTokens),
            source: t(`shell.session.contextSource.${context.source}`),
          })}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Claude Code version of THIS session (Plan C.7: per session, the CLI updates itself; R3-01):
 * compact text, red when older than the version the Agent SDK expects (always visible then).
 */
function HeaderCliVersion({ version, required }: { version: string; required: string | null }) {
  const t = useT();
  const tooOld = cliVersionStatus(version, required) === 'too_old';
  return (
    <div className={cn('min-w-0 items-center gap-1', tooOld ? 'flex shrink-0' : 'hidden xl:flex')}>
      <dt className="sr-only">{t('shell.session.cliVersionLabel')}</dt>
      <dd data-slot="header-cli-version" data-version-status={tooOld ? 'too_old' : 'ok'}>
        <Tooltip>
          <TooltipTrigger asChild>
            {tooOld ? (
              <Badge variant="destructive" className="tabular-nums">
                {t('shell.session.cliVersionShort', { version })}
              </Badge>
            ) : (
              <span className="tabular-nums">{t('shell.session.cliVersionShort', { version })}</span>
            )}
          </TooltipTrigger>
          <TooltipContent>
            <span className="grid gap-0.5">
              <span className="font-medium">{t('shell.session.cliVersion', { version })}</span>
              <span className="text-muted-foreground">{t('shell.session.cliVersionHint')}</span>
              {tooOld && required !== null ? (
                <span className="text-destructive">{t('shell.session.cliTooOld', { required })}</span>
              ) : null}
            </span>
          </TooltipContent>
        </Tooltip>
        {tooOld && required !== null ? (
          <span className="sr-only">{t('shell.session.cliTooOld', { required })}</span>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * Header line of a session pane (ADR-042: status only – mode, model and context are operated in
 * the composer): status (icon + text), title, badges (queue count = the only queue display next
 * to the transcript, ADR-041; compacting, retrying, background, expired decisions) and the facts
 * at a glance (folder, model, actual permission mode – C.3 –, Claude Code version – C.7 –, context
 * fill). Reads its own summary (memo: the pane above does not re-render on summary changes, R1W-04).
 */
export const SessionHeader = memo(function SessionHeader({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const summary = useSummary(sessionKey);
  const status = useDisplayStatus(sessionKey);
  const hostState = useHostState(parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID);
  if (summary === null) return null;
  const model = summary.model ?? summary.modelSetting;
  const cliVersion = knownVersion(summary.cliVersion);
  return (
    <header
      data-slot="session-header"
      data-status={status?.kind}
      className="flex h-9 shrink-0 items-center gap-3 border-b px-3"
    >
      {status === null ? null : <StatusIcon kind={status.kind} withTooltip />}
      <h1 className="min-w-0 truncate text-ui font-semibold">{sessionTitle(summary)}</h1>
      {status === null ? null : (
        // The status icon already carries the text for screen readers (V1-12).
        <span
          aria-hidden
          data-slot="header-status"
          className="text-muted-foreground hidden shrink-0 text-xs md:inline"
        >
          {t(`status.${status.kind}`)}
        </span>
      )}
      {status?.badges.compacting === true ? (
        <Badge variant="info">{t('shell.badges.compacting')}</Badge>
      ) : null}
      {status?.badges.retrying === true ? (
        <Badge variant="warning">{t('shell.badges.retrying')}</Badge>
      ) : null}
      {status !== null && status.badges.queued > 0 ? (
        <Badge variant="outline" data-slot="header-queued">
          {t('shell.badges.queued', { count: status.badges.queued })}
        </Badge>
      ) : null}
      {status?.badges.background === true && status.kind !== 'background' ? (
        <Badge variant="outline">{t('shell.badges.background')}</Badge>
      ) : null}
      {status !== null && status.badges.expiredDecisions > 0 && status.kind !== 'needs-resume' ? (
        <Badge variant="warning">
          {t('shell.badges.expiredDecisions', { count: status.badges.expiredDecisions })}
        </Badge>
      ) : null}
      <span className="flex-1" />
      <dl className="text-muted-foreground flex min-w-0 items-center gap-3 text-xs">
        <div className="flex min-w-0 items-center gap-1">
          <dt className="sr-only">{t('shell.session.cwd')}</dt>
          <dd className="flex min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Shrinks with the pane (V1-04): the path never runs under the mode badge. */}
                <span className="flex max-w-full min-w-0 items-center gap-1 font-mono text-2xs">
                  <FolderIcon aria-hidden className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">{pathTail(summary.cwd, 2)}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-mono break-all">{summary.cwd}</span>
              </TooltipContent>
            </Tooltip>
          </dd>
        </div>
        <div className="hidden min-w-0 items-center gap-1 lg:flex">
          <dt className="sr-only">{t('shell.session.model')}</dt>
          <dd className="truncate" data-slot="header-model">
            {model ?? t('shell.session.modelDefault')}
          </dd>
        </div>
        {summary.permissionMode === null ? null : (
          <div className="flex shrink-0 items-center gap-1">
            <dt className="sr-only">{t('shell.session.permissionMode')}</dt>
            <dd data-slot="header-mode">
              <Badge variant={summary.permissionMode === 'bypassPermissions' ? 'destructive' : 'outline'}>
                {t(`shell.permissionMode.${summary.permissionMode}`)}
              </Badge>
            </dd>
          </div>
        )}
        {cliVersion === null ? null : (
          <HeaderCliVersion
            version={cliVersion}
            required={knownVersion(hostState?.sdkClaudeCodeVersion ?? null)}
          />
        )}
        {summary.context === null ? null : (
          <div className="hidden shrink-0 items-center gap-1 sm:flex">
            <dt className="sr-only">{t('shell.session.context')}</dt>
            <dd>
              <HeaderContext context={summary.context} />
            </dd>
          </div>
        )}
      </dl>
    </header>
  );
});
