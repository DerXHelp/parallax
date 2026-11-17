import { useState } from 'react';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ClaudeInstallStatus, HostState, ProfileSummary } from '@shared/model';
import { useI18n } from '@web/i18n';
import { retryConnection } from '@web/state/connection';
import { useHostRecord, useHostState } from '@web/state/hooks';
import { Banner } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { RetryCountdown } from './HostGate';
import { LoginButton, needsSignIn } from './login/LoginButton';
import { NotificationPermissionBanner } from './NotificationPermissionBanner';
import { useFeatureSlots } from './slots';

/**
 * Close 4504 (WP-88b): the server restarts for an update or a rollback and the window reconnects
 * by itself – no "Retry now", no countdown. The spinner takes the place of the banner icon.
 */
function RestartBanner() {
  const { t } = useI18n();
  return (
    <Banner tone="info" data-slot="restart-banner" className="[&>svg]:hidden">
      <span className="inline-flex flex-wrap items-center gap-x-1.5">
        <Spinner aria-hidden role="presentation" className="text-info" />
        <span className="font-medium">{t('connection.restartingTitle')}</span>
        <span className="text-muted-foreground">{t('connection.restartingDescription')}</span>
      </span>
    </Banner>
  );
}

/** Connection lost / restarting / outdated window (after the first successful handshake). */
function ConnectionBanner() {
  const { t } = useI18n();
  const host = useHostRecord();
  if (!host.everConnected || host.status === 'open' || host.phase === 'stopped') return null;
  if (host.phase === 'restarting') return <RestartBanner />;
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

/** The default profile (`defaultProfileId`, else the first one). */
export function defaultProfileOf(hostState: HostState): ProfileSummary | undefined {
  return hostState.profiles.find((p) => p.id === hostState.defaultProfileId) ?? hostState.profiles[0];
}

/**
 * Setup hint (C.5 / B "First-Run"): the default profile cannot run sessions (claude missing, not
 * logged in …, `host.state.setupRequired`) or its CLI is too old (warning only). The translated
 * reason plus a pointer to `pnpm preflight`; the full setup screen (preflight in the UI, path
 * choice, retry) follows in Phase 2. While the server still tests the profile after its start
 * (`claude.state === 'checking'`, R3-03) a neutral "checking" line replaces the warning – the
 * server reports `setupRequired` until the first check is done.
 */
function SetupHint() {
  const { t, tError } = useI18n();
  const hostState = useHostState();
  if (hostState === null) return null;
  const profile = defaultProfileOf(hostState);
  if (profile?.claude.state === 'checking') {
    return (
      <Banner tone="info" data-slot="setup-hint" data-state="checking">
        <span className="inline-flex flex-wrap gap-x-1.5">
          <span className="font-medium">{t('shell.setup.checkingTitle')}</span>
          <span className="text-muted-foreground">{t('shell.setup.checkingDescription')}</span>
        </span>
      </Banner>
    );
  }
  const issue = profile === undefined ? null : setupIssue(profile.claude);
  const tooOld = profile?.claude.versionStatus === 'too_old';
  if (!hostState.setupRequired && !tooOld) return null;
  return (
    <Banner
      tone={hostState.setupRequired ? 'warning' : 'info'}
      data-slot="setup-hint"
      data-state={hostState.setupRequired ? 'required' : 'too-old'}
      // WP-70: not signed in → sign in from here (the server checks the profile again afterwards).
      actions={
        profile !== undefined && needsSignIn(profile.claude) ? (
          <LoginButton profileId={profile.id} />
        ) : undefined
      }
    >
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

/**
 * All banners above the session area (most urgent first). The slot `UpdateBanner` (WP-88a:
 * "Updated to <v>", "Update to <v> failed") follows the connection; its placeholder renders nothing.
 */
export function ShellBanners() {
  const { UpdateBanner } = useFeatureSlots();
  return (
    <>
      <ConnectionBanner />
      <UpdateBanner />
      <SetupHint />
      <HostWarnings />
      <NotificationPermissionBanner />
    </>
  );
}
