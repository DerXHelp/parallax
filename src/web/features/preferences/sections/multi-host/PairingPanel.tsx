import { LinkIcon, LoaderCircleIcon } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import type { RemoteAccessState } from '@shared/model';
import { PAIRING_MAX_FAILURES, PAIRING_WINDOW_MS } from '@shared/pairing';
import { useI18n } from '@web/i18n';
import { useNow, useNowUntil } from '@web/state/clock';
import { errorPayloadOf } from '@web/state/connection';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { countdownText, minutesLeft, pairingGroups, secondsLeft } from '../../lib/multi-host';
import { useMultiHostCommands, type PairingWindow } from './commands';
import { Part } from './Part';

/** The code this window got (only here – never in HostState) and what it knew when asking. */
interface ShownCode extends PairingWindow {
  /** `peer.pairedAt` when the code was requested (a newer one = this pairing succeeded). */
  peerAt: string | null;
  /** HostState showed this window open at least once (only then does "closed" mean something). */
  seenOpen: boolean;
}

type Notice =
  { kind: 'paired'; name: string } | { kind: 'expired' } | { kind: 'closed' } | { kind: 'cancelled' };

/** The code card: 7 groups, countdown (announced once a minute), computer name, addresses, port. */
function CodeCard({ shown, busy, onCancel }: { shown: ShownCode; busy: boolean; onCancel: () => void }) {
  const { t, format } = useI18n();
  const now = useNow(1000);
  const labelId = useId();
  // The shared clock may lag a moment behind the ack; a window never lasts longer than the contract's.
  const seconds = Math.min(secondsLeft(shown.expiresAt, now), PAIRING_WINDOW_MS / 1000);
  const groups = pairingGroups(shown.code);
  return (
    <div
      data-slot="pairing-card"
      role="group"
      aria-labelledby={labelId}
      className="bg-muted/30 grid gap-3 rounded-lg border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span id={labelId} className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
          {t('preferences.multiHost.share.pairing.codeLabel')}
        </span>
        <span
          role="timer"
          data-slot="pairing-countdown"
          className="text-muted-foreground text-xs tabular-nums"
        >
          {t('preferences.multiHost.share.pairing.validFor', { time: countdownText(seconds) })}
        </span>
      </div>
      <p
        data-slot="pairing-code"
        className="flex flex-wrap gap-x-1.5 gap-y-1 font-mono text-2xl leading-tight font-semibold tracking-wider select-all"
      >
        {groups.map((group, index) => (
          <Fragment key={`${String(index)}-${group}`}>
            {index === 0 ? null : (
              <span aria-hidden className="text-muted-foreground/50">
                -
              </span>
            )}
            <span data-slot="pairing-code-group">{group}</span>
          </Fragment>
        ))}
      </p>
      {/* Screen readers hear the remaining time once a minute, not every second. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {t('preferences.multiHost.share.pairing.minutesLeft', { count: minutesLeft(seconds) })}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t('preferences.multiHost.share.pairing.computer')}</dt>
        <dd data-slot="pairing-host-name" className="font-medium">
          {shown.hostName}
        </dd>
        <dt className="text-muted-foreground">{t('preferences.multiHost.share.pairing.addresses')}</dt>
        <dd data-slot="pairing-addresses" className="font-mono">
          {format.list(shown.addresses, { type: 'disjunction', style: 'long' })}
        </dd>
        <dt className="text-muted-foreground">{t('preferences.multiHost.share.pairing.port')}</dt>
        <dd data-slot="pairing-port" className="font-mono">
          {String(shown.port)}
        </dd>
      </dl>
      <div>
        <Button variant="outline" size="sm" data-action="pairing-cancel" disabled={busy} onClick={onCancel}>
          {t('preferences.multiHost.share.pairing.cancel')}
        </Button>
      </div>
    </div>
  );
}

/**
 * "Pair a computer" (`remoteAccess.pair`, WP-76 §B.7): the code comes only in the ack and stays in
 * this component (never in the store). A new pairing replaces an existing one only after asking;
 * the window ends by success (newer `peer.pairedAt`), expiry, "Cancel" (`cancelPairing`) or the
 * server closing it (too many wrong codes). A window opened by another local window shows without
 * a code and can be replaced or cancelled.
 */
export function PairingPanel({ state }: { state: RemoteAccessState }) {
  const { t, tError, format } = useI18n();
  const commands = useMultiHostCommands();
  const [shown, setShown] = useState<ShownCode | null>(null);
  const [busy, setBusy] = useState<'pair' | 'cancel' | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Re-renders exactly when a window expires (the card ticks on its own).
  const now = useNowUntil([shown?.expiresAt, state.pairingExpiresAt]);
  const peer = state.peer;

  // Follow the server's window during render (no effect): expired, seen open, closed.
  if (shown !== null) {
    const open = state.pairingExpiresAt === shown.expiresAt;
    if (now >= Date.parse(shown.expiresAt)) {
      setShown(null);
      setNotice({ kind: 'expired' });
    } else if (open && !shown.seenOpen) {
      setShown({ ...shown, seenOpen: true });
    } else if (!open && shown.seenOpen) {
      setShown(null);
      setNotice(
        peer !== null && peer.pairedAt !== shown.peerAt
          ? { kind: 'paired', name: peer.name }
          : { kind: 'closed' },
      );
    }
  }

  const pair = () => {
    setConfirmReplace(false);
    setBusy('pair');
    setError(null);
    setNotice(null);
    const peerAt = peer?.pairedAt ?? null;
    commands
      .pair()
      .then(
        (result) => {
          setShown({ ...result, peerAt, seenOpen: false });
        },
        (caught: unknown) => {
          setError(errorPayloadOf(caught));
        },
      )
      .finally(() => {
        setBusy(null);
      });
  };

  const start = () => {
    if (peer !== null) {
      setConfirmReplace(true);
      return;
    }
    pair();
  };

  const cancel = () => {
    setBusy('cancel');
    setError(null);
    commands
      .cancelPairing()
      .then(
        () => {
          setShown(null);
          setNotice({ kind: 'cancelled' });
        },
        (caught: unknown) => {
          setError(errorPayloadOf(caught));
        },
      )
      .finally(() => {
        setBusy(null);
      });
  };

  const elsewhere =
    shown === null &&
    busy !== 'pair' &&
    state.pairingExpiresAt !== null &&
    now < Date.parse(state.pairingExpiresAt);

  let noticeText: string | null = null;
  if (notice?.kind === 'paired')
    noticeText = t('preferences.multiHost.share.pairing.paired', { name: notice.name });
  else if (notice !== null) noticeText = t(`preferences.multiHost.share.pairing.${notice.kind}`);

  return (
    <Part
      name="pairing"
      heading={t('preferences.multiHost.share.pairing.heading')}
      hint={t('preferences.multiHost.share.pairing.hint', {
        minutes: Math.round(PAIRING_WINDOW_MS / 60_000),
        failures: PAIRING_MAX_FAILURES,
      })}
    >
      {noticeText === null ? null : (
        <Alert tone={notice?.kind === 'paired' ? 'success' : 'info'} data-slot="pairing-notice">
          {noticeText}
        </Alert>
      )}
      {error === null ? null : (
        <Alert tone="error" title={t('preferences.multiHost.share.pairing.failed')}>
          {tError(error)}
        </Alert>
      )}
      {confirmReplace && peer !== null ? (
        <Alert
          tone="warning"
          data-slot="pairing-replace-confirm"
          title={t('preferences.multiHost.share.pairing.replaceTitle', { name: peer.name })}
          actions={
            <>
              <Button
                size="sm"
                variant="outline"
                data-action="pairing-keep"
                autoFocus
                onClick={() => {
                  setConfirmReplace(false);
                }}
              >
                {t('preferences.multiHost.share.pairing.keep')}
              </Button>
              <Button size="sm" variant="destructive" data-action="pairing-replace" onClick={pair}>
                {t('preferences.multiHost.share.pairing.replaceConfirm')}
              </Button>
            </>
          }
        >
          {t('preferences.multiHost.share.pairing.replaceBody')}
        </Alert>
      ) : null}
      {shown !== null ? (
        <CodeCard shown={shown} busy={busy !== null} onCancel={cancel} />
      ) : elsewhere && state.pairingExpiresAt !== null ? (
        <Alert
          tone="info"
          data-slot="pairing-elsewhere"
          actions={
            <>
              <Button
                size="sm"
                variant="outline"
                data-action="pairing-new-code"
                disabled={busy !== null}
                onClick={start}
              >
                {t('preferences.multiHost.share.pairing.newCode')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-action="pairing-cancel"
                disabled={busy !== null}
                onClick={cancel}
              >
                {t('preferences.multiHost.share.pairing.cancel')}
              </Button>
            </>
          }
        >
          {t('preferences.multiHost.share.pairing.openElsewhere', {
            time: format.time(state.pairingExpiresAt),
          })}
        </Alert>
      ) : (
        <div>
          <Button
            variant="outline"
            data-action="pairing-start"
            disabled={busy !== null || confirmReplace || !state.listening}
            onClick={start}
          >
            {busy === 'pair' ? (
              <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" />
            ) : (
              <LinkIcon aria-hidden />
            )}
            {busy === 'pair'
              ? t('preferences.multiHost.share.pairing.starting')
              : t('preferences.multiHost.share.pairing.start')}
          </Button>
        </div>
      )}
    </Part>
  );
}
