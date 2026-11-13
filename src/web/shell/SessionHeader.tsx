import { FolderIcon } from 'lucide-react';
import { memo } from 'react';
import { LOCAL_HOST_ID, parseSessionKey } from '@shared/common';
import type { EffortLevel } from '@shared/common';
import type { ContextGauge } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { useT } from '@web/i18n';
import { sessionLine } from '@web/lib/activity';
import { cn } from '@web/lib/cn';
import { effectiveEffort } from '@web/lib/effort';
import { sessionTitle } from '@web/lib/session-title';
import { cliVersionStatus, knownVersion } from '@web/lib/version';
import { useDisplayStatus, useHostState, useSessionSelector, useSummary } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { Gauge } from '@web/ui/gauge';
import { StatusIcon } from '@web/ui/status-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { ContextCompactIcon, useContextTexts } from './context-display';
import { HeaderPanelButtons, HeaderPanelMenuItems, useCompactHeader } from './header-panels';
import { RenameField } from './navigation/RenameField';
import { PathTail } from './navigation/PathTail';
import { showsRemoteInHeader } from './navigation/remote-control';
import { RemoteControlMenu } from './navigation/RemoteControlMenu';
import { startRename, useRenameHeader, useRenaming } from './navigation/rename';
import { SessionLineText, useSessionLineText } from './navigation/session-line';
import { SessionMenu } from './navigation/SessionMenu';

/**
 * Context fill as a compact, read-only meter (WP-63 §1.4): the bar runs up to the autocompact, the
 * color says "really full" (share of the model window), a symbol says "autocompact soon"; the
 * details and the source in the tooltip.
 */
function HeaderContext({ context }: { context: ContextGauge }) {
  const t = useT();
  const texts = useContextTexts(context);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-slot="header-context"
          data-compact-soon={texts.compactSoon === null ? undefined : 'true'}
          className="inline-flex items-center gap-1"
        >
          <Gauge
            value={texts.display.fill}
            level={texts.display.level}
            valueText={texts.short}
            valueLabel={texts.compactSoon === null ? texts.detail : `${texts.detail} · ${texts.compactSoon}`}
            label={t('shell.session.context')}
            barClassName="w-10"
          />
          {texts.compactSoon === null ? null : <ContextCompactIcon />}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="grid gap-0.5 tabular-nums">
          <span>{texts.detail}</span>
          {texts.compactSoon === null ? null : <span>{texts.compactSoon}</span>}
          <span className="text-muted-foreground">{texts.source}</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

const selectInitEffort = (view: SessionViewState): EffortLevel | null => view.detail.init?.effort ?? null;

/**
 * Claude Code version of THIS session (Plan C.7: per session, the CLI updates itself; R3-01):
 * compact text, red when older than the version the Agent SDK expects (always visible then).
 */
function HeaderCliVersion({ version, required }: { version: string; required: string | null }) {
  const t = useT();
  const tooOld = cliVersionStatus(version, required) === 'too_old';
  return (
    // Never shrinks (V3-05: a squeezed "CLI 2.1.300" ran under the context gauge); narrow panes
    // hide it instead (below xl), unless it is too old.
    <div className={cn('shrink-0 items-center gap-1', tooOld ? 'flex' : 'hidden xl:flex')}>
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
 * Phase 2 (WP-35): the title is edited inline (double click, F2, `/rename`); the "…" session menu
 * sits next to the status line. Phase 3 (WP-58): the side panel buttons "Plan", "Files", "Tasks"
 * sit before the "…" – in a narrow bar they move into that menu (`data-compact`). WP-64: the
 * Remote Control icon with its own menu while the bridge is live or wanted. WP-65: the session line
 * (live sentence / turn summary) after the badges – not in a compact bar or a narrow window.
 */
export const SessionHeader = memo(function SessionHeader({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const summary = useSummary(sessionKey);
  const status = useDisplayStatus(sessionKey);
  const hostState = useHostState(parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID);
  useRenameHeader(sessionKey);
  const editing = useRenaming(sessionKey, 'header');
  const [compact, barRef] = useCompactHeader();
  // The header sits in a pane that holds the subscription; this only reads the reported effort.
  const initEffort = useSessionSelector(sessionKey, selectInitEffort, null);
  // WP-65 §1.1: the sidebar's session line, after the badges while the bar is wide enough.
  const line = summary === null || status === null ? null : sessionLine(summary, status.kind);
  const lineText = useSessionLineText(line);
  if (summary === null) return null;
  const model = summary.model ?? summary.modelSetting;
  const effort = effectiveEffort({
    effort: summary.effort,
    initEffort,
    profileEffort: hostState?.profiles.find((p) => p.id === summary.profileId)?.defaults.effort ?? null,
  });
  const cliVersion = knownVersion(summary.cliVersion);
  return (
    <div
      ref={barRef}
      data-slot="session-bar"
      data-compact={compact ? 'true' : undefined}
      className="flex h-9 shrink-0 items-center border-b"
    >
      <header
        data-slot="session-header"
        data-status={status?.kind}
        className="flex h-full min-w-0 flex-1 items-center gap-3 pr-2 pl-3"
      >
        {status === null ? null : <StatusIcon kind={status.kind} withTooltip />}
        {editing ? (
          <RenameField sessionKey={sessionKey} summary={summary} className="w-72 min-w-24 shrink" />
        ) : (
          // The title gives way first (shrink 8 against the facts' 1, V3-05), down to 6rem.
          <h1
            className="min-w-24 shrink-[8] truncate text-ui font-semibold"
            onDoubleClick={() => {
              startRename(sessionKey, 'header');
            }}
          >
            {sessionTitle(summary)}
          </h1>
        )}
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
        {compact || line === null ? null : (
          // Gives way before the title (shrink 12); the whole text in the native tooltip.
          <span data-slot="header-line" title={lineText ?? undefined} className="hidden min-w-0 shrink-[12] text-xs lg:flex">
            <SessionLineText line={line} />
          </span>
        )}
        <span className="flex-1" />
        {/* Only path and model shrink (with an ellipsis); every other fact keeps its width. */}
        <dl
          data-slot="header-facts"
          className="text-muted-foreground flex min-w-0 items-center gap-3 text-xs whitespace-nowrap"
        >
          <div className="flex min-w-0 items-center gap-1">
            <dt className="sr-only">{t('shell.session.cwd')}</dt>
            <dd className="flex min-w-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* Shrinks with the pane (V1-04): the path never runs under the mode badge. */}
                  <span className="flex max-w-full min-w-0 items-center gap-1 font-mono text-2xs">
                    <FolderIcon aria-hidden className="size-3 shrink-0" />
                    {/* WP41-02: the project folder stays whole, the folder before it shrinks. */}
                    <PathTail path={summary.cwd} data-slot="header-path" />
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
            {/* WP-63 §1.1: the effective effort next to the model ("opus · high"). */}
            {effort === null ? null : (
              <>
                <dt className="sr-only">{t('shell.session.effort')}</dt>
                <dd data-slot="header-effort" data-effort={effort} className="shrink-0">
                  <span aria-hidden className="mr-1">
                    ·
                  </span>
                  {t(`shell.effortLevels.${effort}`)}
                </dd>
              </>
            )}
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
      <div className="flex shrink-0 items-center gap-1 pr-2">
        {showsRemoteInHeader(summary.remoteControl) ? (
          <RemoteControlMenu sessionKey={sessionKey} summary={summary} />
        ) : null}
        {compact ? null : <HeaderPanelButtons sessionKey={sessionKey} />}
        <SessionMenu
          sessionKey={sessionKey}
          summary={summary}
          leading={compact ? <HeaderPanelMenuItems sessionKey={sessionKey} /> : undefined}
        />
      </div>
    </div>
  );
});
