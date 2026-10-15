import {
  CloudOffIcon,
  LayersIcon,
  LogInIcon,
  PowerIcon,
  RefreshCwIcon,
  ServerOffIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { HostId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import { useI18n } from '@web/i18n';
import { useNow } from '@web/state/clock';
import { errorPayloadOf, retryConnection, shutdownServer } from '@web/state/connection';
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
 * "Parallax was updated" without an earlier connection (V2-04): reloading only helps when the
 * window is older than the server. When the server is the older one (V2-03: a build replaced
 * `dist/` under it), reloading lands here again – so the view also offers "Stop server" (with an
 * inline confirmation, Cancel focused) and, should that fail, the manual way out.
 */
function OutdatedWindow({ hostId }: { hostId: HostId }) {
  const { t, tError } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const [focusAfter, setFocusAfter] = useState<'cancel' | 'stop' | null>(null);

  useEffect(() => {
    // Only after a click on "Stop server…" / "Cancel" (a user action): the button that replaced
    // the clicked one keeps the keyboard where it was.
    if (focusAfter === 'cancel') cancelRef.current?.focus();
    if (focusAfter === 'stop') stopRef.current?.focus();
  }, [focusAfter, confirming]);

  const confirm = () => {
    setPending(true);
    setError(null);
    shutdownServer(hostId).then(
      // Success: the host is "server stopped" now and HostGate shows that view.
      () => undefined,
      (caught: unknown) => {
        setPending(false);
        setError(errorPayloadOf(caught));
      },
    );
  };

  return (
    <FullPage
      icon={RefreshCwIcon}
      title={t('connection.versionMismatchTitle')}
      actions={
        confirming ? undefined : (
          <>
            <Button
              onClick={() => {
                window.location.reload();
              }}
            >
              {t('common.reload')}
            </Button>
            <Button
              ref={stopRef}
              variant="outline"
              data-action="stop-server"
              onClick={() => {
                setConfirming(true);
                setFocusAfter('cancel');
              }}
            >
              <PowerIcon aria-hidden />
              {t('serverShutdown.menuItem')}
            </Button>
          </>
        )
      }
    >
      <p className="text-muted-foreground text-xs">{t('connection.versionMismatchDescription')}</p>
      <p className="text-muted-foreground text-xs">{t('connection.versionMismatchStuck')}</p>
      {confirming ? (
        <div data-slot="outdated-stop-server" className="grid w-full gap-2 text-left">
          <Alert tone="warning" title={t('serverShutdown.title')}>
            {t('serverShutdown.outdatedDescription')}
          </Alert>
          {error === null ? null : (
            <Alert tone="error" title={t('serverShutdown.failed')}>
              <span className="grid gap-0.5">
                <span>{tError(error)}</span>
                <span>{t('serverShutdown.manualHint')}</span>
              </span>
            </Alert>
          )}
          <div className="flex justify-center gap-2">
            <Button
              ref={cancelRef}
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                setError(null);
                setFocusAfter('stop');
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              data-action="confirm-stop-server"
              disabled={pending}
              onClick={confirm}
            >
              {pending ? t('serverShutdown.stopping') : t('serverShutdown.confirm')}
            </Button>
          </div>
        </div>
      ) : null}
    </FullPage>
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
    return <OutdatedWindow hostId={host.hostId} />;
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
