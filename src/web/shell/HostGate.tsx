import {
  CloudOffIcon,
  LayersIcon,
  LogInIcon,
  RefreshCwIcon,
  ServerOffIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { makeError } from '@shared/errors';
import { useI18n } from '@web/i18n';
import { useNow } from '@web/state/clock';
import { retryConnection } from '@web/state/connection';
import { useHostRecord } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';

function FullPage({
  icon: Icon,
  title,
  children,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <main className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <Icon aria-hidden className="text-muted-foreground size-7" />
        <h1 className="text-base font-semibold">{title}</h1>
        {children}
        {actions === undefined ? null : <div className="mt-1 flex gap-2">{actions}</div>}
      </div>
    </main>
  );
}

/** "Retrying in n s" while a reconnect is scheduled. */
export function RetryCountdown({ nextAttemptAt }: { nextAttemptAt: number | null }) {
  const { t } = useI18n();
  const now = useNow(1000);
  if (nextAttemptAt === null) return null;
  const seconds = Math.max(0, Math.ceil((nextAttemptAt - now) / 1000));
  // Not announced every second inside the banner's live region (R1W-13).
  return (
    <span aria-live="off" className="text-muted-foreground text-xs tabular-nums">
      {t('connection.retryIn', { count: seconds })}
    </span>
  );
}

/**
 * Full-page states of the local host before the shell can show anything (architecture §5.1):
 * not signed in (no WS), server stopped (close 4503), not reachable yet, outdated window,
 * connecting. Once a `hello` was accepted, later outages are banners (ShellBanners).
 */
export function HostGate({ children }: { children: ReactNode }) {
  const { t, tError } = useI18n();
  const host = useHostRecord();

  if (host.phase === 'unauthenticated') {
    return (
      <FullPage
        icon={LogInIcon}
        title={t('auth.signedOutTitle')}
        actions={
          <Button
            variant="outline"
            onClick={() => {
              retryConnection(host.hostId);
            }}
          >
            {t('auth.checkAgain')}
          </Button>
        }
      >
        <p className="text-muted-foreground text-xs">{t('auth.signedOutDescription')}</p>
        {host.authCodeRejected ? <Alert tone="error">{tError(makeError('AUTH_CODE_INVALID'))}</Alert> : null}
        {import.meta.env.DEV ? <p className="text-muted-foreground text-2xs">{t('auth.devHint')}</p> : null}
      </FullPage>
    );
  }

  if (host.phase === 'server-stopped') {
    return (
      <FullPage
        icon={ServerOffIcon}
        title={t('connection.serverStoppedTitle')}
        actions={
          <Button
            variant="outline"
            onClick={() => {
              retryConnection(host.hostId);
            }}
          >
            <RefreshCwIcon aria-hidden />
            {t('connection.reconnect')}
          </Button>
        }
      >
        <p className="text-muted-foreground text-xs">{t('connection.serverStoppedDescription')}</p>
      </FullPage>
    );
  }

  if (host.phase === 'version-mismatch' && !host.everConnected) {
    return (
      <FullPage
        icon={RefreshCwIcon}
        title={t('connection.versionMismatchTitle')}
        actions={
          <Button
            onClick={() => {
              window.location.reload();
            }}
          >
            {t('common.reload')}
          </Button>
        }
      >
        <p className="text-muted-foreground text-xs">{t('connection.versionMismatchDescription')}</p>
      </FullPage>
    );
  }

  if (!host.everConnected) {
    if (host.phase === 'reconnecting') {
      return (
        <FullPage
          icon={CloudOffIcon}
          title={t('connection.unreachableTitle')}
          actions={
            <Button
              variant="outline"
              onClick={() => {
                retryConnection(host.hostId);
              }}
            >
              {t('common.retryNow')}
            </Button>
          }
        >
          <p className="text-muted-foreground text-xs">{t('connection.unreachableDescription')}</p>
          {host.upgradeRejected ? <Alert tone="warning">{t('connection.upgradeRejected')}</Alert> : null}
          <RetryCountdown nextAttemptAt={host.nextAttemptAt} />
        </FullPage>
      );
    }
    return (
      <FullPage icon={LayersIcon} title={t('connection.connecting')}>
        <Spinner className="text-muted-foreground" label={t('connection.connecting')} />
      </FullPage>
    );
  }

  return <>{children}</>;
}
