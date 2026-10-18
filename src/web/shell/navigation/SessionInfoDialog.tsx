import type { ReactNode } from 'react';
import { LOCAL_HOST_ID, parseSessionKey } from '@shared/common';
import { useT, type TranslationKey } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useReturnFocus } from '@web/lib/return-focus';
import { knownVersion } from '@web/lib/version';
import { useHostState, useSessionDetail, useSummary } from '@web/state/hooks';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { sessionFocusTarget } from './focus';

/**
 * Known values of `init.apiKeySource` (SDK `ApiKeySource`) and of an MCP server's `status`
 * (R4W-14): shown translated, anything newer stays raw.
 */
const API_KEY_SOURCES: Readonly<Record<string, TranslationKey>> = {
  none: 'navigation.info.apiKeySources.subscription',
  ANTHROPIC_API_KEY: 'navigation.info.apiKeySources.envKey',
  apiKeyHelper: 'navigation.info.apiKeySources.helper',
  '/login managed key': 'navigation.info.apiKeySources.loginManaged',
  user: 'navigation.info.apiKeySources.user',
  project: 'navigation.info.apiKeySources.project',
  org: 'navigation.info.apiKeySources.org',
  temporary: 'navigation.info.apiKeySources.temporary',
  oauth: 'navigation.info.apiKeySources.oauth',
};

const MCP_STATUS: Readonly<Record<string, TranslationKey>> = {
  connected: 'navigation.info.mcpStatus.connected',
  failed: 'navigation.info.mcpStatus.failed',
  'needs-auth': 'navigation.info.mcpStatus.needsAuth',
  pending: 'navigation.info.mcpStatus.pending',
  disabled: 'navigation.info.mcpStatus.disabled',
};

function Row({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words', mono && 'font-mono text-2xs leading-5 break-all')}>
        {children}
      </dd>
    </>
  );
}

/**
 * Session info (request `sessionInfo`, header menu, `/status` of WP-37): model, mode, folder,
 * branch, Claude Code version, sign-in source, session id, profile and MCP servers (from
 * `detail.init`, i.e. the last start). Read-only; closing gives the focus back to where it was.
 */
export function SessionInfoDialog({ sessionKey, onClose }: { sessionKey: string; onClose: () => void }) {
  const t = useT();
  const summary = useSummary(sessionKey);
  const detail = useSessionDetail(sessionKey);
  const hostState = useHostState(parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID);
  const returnFocus = useReturnFocus(true, () => sessionFocusTarget(sessionKey));
  const init = detail?.init ?? null;
  const unknown = t('navigation.info.unknown');
  const profile = hostState?.profiles.find((candidate) => candidate.id === summary?.profileId);
  const mode = init?.permissionMode ?? summary?.permissionMode ?? null;
  const apiKeySource = init?.apiKeySource ?? summary?.apiKeySource ?? null;
  const apiKeySourceKey = apiKeySource === null ? undefined : API_KEY_SOURCES[apiKeySource];

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent data-slot="session-info" className="sm:max-w-lg" onCloseAutoFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{t('navigation.info.title')}</DialogTitle>
          <DialogDescription>{t('navigation.info.description')}</DialogDescription>
        </DialogHeader>
        {summary === null ? null : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <Row label={t('navigation.info.model')}>
              {init?.model ?? summary.model ?? summary.modelSetting ?? t('shell.session.modelDefault')}
            </Row>
            <Row label={t('navigation.info.mode')}>
              {mode === null ? unknown : t(`shell.permissionMode.${mode}`)}
            </Row>
            <Row label={t('navigation.info.cwd')} mono>
              {summary.cwd}
            </Row>
            <Row label={t('navigation.info.branch')}>{summary.gitBranch ?? t('navigation.info.none')}</Row>
            <Row label={t('navigation.info.cliVersion')}>
              {knownVersion(init?.cliVersion ?? summary.cliVersion) ?? unknown}
            </Row>
            <Row label={t('navigation.info.apiKeySource')}>
              {apiKeySourceKey === undefined ? (apiKeySource ?? unknown) : t(apiKeySourceKey)}
            </Row>
            <Row label={t('navigation.info.sessionId')} mono>
              {summary.sessionId ?? init?.sessionId ?? unknown}
            </Row>
            <Row label={t('navigation.info.profile')}>{profile?.name ?? summary.profileId}</Row>
            <Row label={t('navigation.info.mcpServers')}>
              {init === null || init.mcpServers.length === 0 ? (
                t('navigation.info.none')
              ) : (
                <ul className="grid gap-0.5">
                  {init.mcpServers.map((server) => {
                    const statusKey = MCP_STATUS[server.status];
                    return (
                      <li key={server.name} className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-2xs">{server.name}</span>
                        <span className="text-muted-foreground text-2xs" data-status={server.status}>
                          {statusKey === undefined ? server.status : t(statusKey)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Row>
          </dl>
        )}
        {init === null ? (
          <p className="text-muted-foreground text-2xs">{t('navigation.info.notStarted')}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
