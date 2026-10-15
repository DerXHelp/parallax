import { useState } from 'react';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ClaudeInstallStatus } from '@shared/model';
import { useI18n } from '@web/i18n';
import { retryConnection } from '@web/state/connection';
import { useHostRecord, useHostState } from '@web/state/hooks';
import { Banner } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { RetryCountdown } from './HostGate';
import { NotificationPermissionBanner } from './NotificationPermissionBanner';

/** Connection lost / outdated window (after the first successful handshake). */
function ConnectionBanner() {
  const { t } = useI18n();
  const host = useHostRecord();
  if (!host.everConnected || host.status === 'open' || host.phase === 'stopped') return null;
  if (host.phase === 'version-mismatch') {
    return (
      <Banner
        tone="error"
        actions={
          <Button
            size="sm"
            onClick={() => {
              window.location.reload();
            }}
          >
            {t('common.reload')}
          </Button>
        }
      >
        <span className="inline-flex flex-wrap gap-x-1.5">
          <span className="font-medium">{t('connection.versionMismatchTitle')}</span>
          <span className="text-muted-foreground">{t('connection.versionMismatchDescription')}</span>
        </span>
      </Banner>
    );
  }
  return (
    <Banner
      tone="warning"
      actions={
        host.phase === 'reconnecting' ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              retryConnection(host.hostId);
            }}
          >
            {t('common.retryNow')}
          </Button>
        ) : undefined
      }
    >
      <span className="inline-flex flex-wrap items-center gap-x-2">
        <span>{t('connection.reconnecting')}</span>
        {host.upgradeRejected ? (
          <span className="text-muted-foreground">{t('connection.upgradeRejected')}</span>
        ) : null}
        {host.phase === 'reconnecting' ? <RetryCountdown nextAttemptAt={host.nextAttemptAt} /> : null}
      </span>
    </Banner>
  );
}

/**
 * What is wrong with the default profile's `claude` (B "First-Run und Fehler"): the server's
 * error, else derived from the install status (missing, logged out, too old); null = nothing known.
 */
export function setupIssue(claude: ClaudeInstallStatus): ErrorPayload | null {
  if (claude.error !== null) return claude.error;
  if (claude.state === 'not_found') return makeError('CLAUDE_NOT_FOUND');
  if (claude.auth.state === 'logged_out') return makeError('CLAUDE_NOT_LOGGED_IN');
  if (claude.auth.state === 'error') return makeError('CLAUDE_AUTH_FAILED');
  if (claude.versionStatus === 'too_old') return makeError('CLAUDE_VERSION_TOO_OLD');
  return null;
}

/**
 * Setup hint (C.5 / B "First-Run"): the default profile cannot run sessions (claude missing, not
 * logged in …, `host.state.setupRequired`) or its CLI is too old (warning only). The translated
 * reason plus a pointer to `pnpm preflight`; the full setup screen (preflight in the UI, path
 * choice, retry) follows in Phase 2.
 */
function SetupHint() {
  const { t, tError } = useI18n();
  const hostState = useHostState();
  if (hostState === null) return null;
  const profile =
    hostState.profiles.find((p) => p.id === hostState.defaultProfileId) ?? hostState.profiles[0];
  const issue = profile === undefined ? null : setupIssue(profile.claude);
  const tooOld = profile?.claude.versionStatus === 'too_old';
  if (!hostState.setupRequired && !tooOld) return null;
  return (
    <Banner tone={hostState.setupRequired ? 'warning' : 'info'} data-slot="setup-hint">
      <span className="inline-flex flex-wrap gap-x-1.5">
        <span className="font-medium">{t('shell.setup.title')}</span>
        <span className="text-muted-foreground">
          {issue === null ? t('shell.setup.description') : tError(issue)}
        </span>
        {issue === null ? null : <span className="text-muted-foreground">{t('shell.setup.preflight')}</span>}
      </span>
    </Banner>
  );
}

/** Server warnings from `host.state.warnings` (e.g. STORE_CORRUPT_QUARANTINED), dismissable per window. */
function HostWarnings() {
  const { t, tError } = useI18n();
  const hostState = useHostState();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const warnings = (hostState?.warnings ?? []).filter((warning) => !dismissed.has(warning.id));
  return warnings.map((warning) => (
    <Banner
      key={warning.id}
      tone="warning"
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDismissed((current) => new Set(current).add(warning.id));
          }}
        >
          {t('common.dismiss')}
        </Button>
      }
    >
      <span className="inline-flex flex-wrap gap-x-1.5">
        <span className="font-medium">{t('shell.warnings.title')}</span>
        <span className="text-muted-foreground">{tError(warning.error)}</span>
      </span>
    </Banner>
  ));
}

/** All banners above the session area (most urgent first). */
export function ShellBanners() {
  return (
    <>
      <ConnectionBanner />
      <SetupHint />
      <HostWarnings />
      <NotificationPermissionBanner />
    </>
  );
}
