import { useState } from 'react';
import { useI18n } from '@web/i18n';
import { retryConnection } from '@web/state/connection';
import { useHostRecord, useHostState } from '@web/state/hooks';
import { Banner } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { RetryCountdown } from './HostGate';

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
        {host.phase === 'reconnecting' ? <RetryCountdown nextAttemptAt={host.nextAttemptAt} /> : null}
      </span>
    </Banner>
  );
}

/**
 * Setup hint placeholder (C.5 / B "First-Run"): the full setup screen (preflight in the UI, path
 * choice, retry) follows later; for now the default profile's error and a pointer to preflight.
 */
function SetupHint() {
  const { t, tError } = useI18n();
  const hostState = useHostState();
  if (hostState?.setupRequired !== true) return null;
  const profile =
    hostState.profiles.find((p) => p.id === hostState.defaultProfileId) ?? hostState.profiles[0];
  const error = profile?.claude.error ?? null;
  return (
    <Banner tone="warning">
      <span className="inline-flex flex-wrap gap-x-1.5">
        <span className="font-medium">{t('shell.setup.title')}</span>
        <span className="text-muted-foreground">
          {error === null ? t('shell.setup.description') : tError(error)}
        </span>
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

/** All banners above the session area. */
export function ShellBanners() {
  return (
    <>
      <ConnectionBanner />
      <SetupHint />
      <HostWarnings />
    </>
  );
}
