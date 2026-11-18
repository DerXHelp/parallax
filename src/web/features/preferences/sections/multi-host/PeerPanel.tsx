import { KeyRoundIcon, LoaderCircleIcon, UnlinkIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import type { RemoteAccessState } from '@shared/model';
import { useI18n } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { useMultiHostCommands } from './commands';
import { Part } from './Part';

/** The question that is open below the paired computer (lifted: the role conflict can open it). */
export type PeerConfirm = 'unpair' | 'renew' | null;

/**
 * The paired computer (name, since, last contact, connected yes/no, version) with "Remove pairing"
 * (`remoteAccess.unpair`) and "Renew key" (`remoteAccess.renewKey`), each after an inline question.
 * Both close the other computer's connections at once (WP-76 §B.8).
 */
export function PeerPanel({
  state,
  confirm,
  onConfirmChange,
}: {
  state: RemoteAccessState;
  confirm: PeerConfirm;
  onConfirmChange: (confirm: PeerConfirm) => void;
}) {
  const { t, tError, format } = useI18n();
  const commands = useMultiHostCommands();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [done, setDone] = useState<'unpaired' | 'renewed' | null>(null);
  const unpairRef = useRef<HTMLButtonElement>(null);
  const renewRef = useRef<HTMLButtonElement>(null);
  const peer = state.peer;
  // A pairing removed elsewhere leaves nothing to ask about.
  const asking: PeerConfirm = confirm === 'unpair' && peer === null ? null : confirm;

  const run = (action: 'unpair' | 'renew') => {
    setBusy(true);
    setError(null);
    setDone(null);
    (action === 'unpair' ? commands.unpair() : commands.renewKey())
      .then(
        () => {
          onConfirmChange(null);
          setDone(action === 'unpair' ? 'unpaired' : 'renewed');
        },
        (caught: unknown) => {
          setError(errorPayloadOf(caught));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const keep = () => {
    const trigger = asking === 'unpair' ? unpairRef.current : renewRef.current;
    onConfirmChange(null);
    trigger?.focus();
  };

  let question: { title: string; body: string; confirm: string } | null = null;
  if (asking === 'unpair' && peer !== null) {
    question = {
      title: t('preferences.multiHost.share.peer.unpairTitle', { name: peer.name }),
      body: t('preferences.multiHost.share.peer.unpairBody'),
      confirm: t('preferences.multiHost.share.peer.unpairConfirm'),
    };
  } else if (asking === 'renew') {
    question = {
      title: t('preferences.multiHost.share.peer.renewTitle'),
      body:
        peer === null
          ? t('preferences.multiHost.share.peer.renewBody')
          : t('preferences.multiHost.share.peer.renewBodyPaired', { name: peer.name }),
      confirm: t('preferences.multiHost.share.peer.renewConfirm'),
    };
  }

  return (
    <Part name="peer" heading={t('preferences.multiHost.share.peer.heading')}>
      {done === null ? null : (
        <Alert tone="success" data-slot="peer-done">
          {t(`preferences.multiHost.share.peer.${done}`)}
        </Alert>
      )}
      {peer === null ? (
        <p data-slot="peer-none" className="text-muted-foreground text-xs">
          {t('preferences.multiHost.share.peer.none')}
        </p>
      ) : (
        <div data-slot="peer" className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span data-slot="peer-name" className="text-sm font-medium">
              {peer.name}
            </span>
            {peer.connected ? (
              <Badge variant="success" data-slot="peer-connected">
                {t('preferences.multiHost.share.peer.connected', { count: peer.connections })}
              </Badge>
            ) : (
              <Badge variant="outline" data-slot="peer-disconnected">
                {t('preferences.multiHost.share.peer.disconnected')}
              </Badge>
            )}
            {peer.compatible ? null : (
              <Badge variant="warning" data-slot="peer-incompatible">
                {t('preferences.multiHost.share.peer.incompatible')}
              </Badge>
            )}
          </div>
          {peer.compatible ? null : (
            <p className="text-muted-foreground text-2xs leading-relaxed">
              {t('preferences.multiHost.share.peer.incompatibleHint', {
                version: peer.appVersion ?? t('preferences.multiHost.share.peer.unknownVersion'),
              })}
            </p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t('preferences.multiHost.share.peer.pairedAt')}</dt>
            <dd>
              <time dateTime={peer.pairedAt}>{format.dateTime(peer.pairedAt)}</time>
            </dd>
            <dt className="text-muted-foreground">{t('preferences.multiHost.share.peer.lastSeen')}</dt>
            <dd data-slot="peer-last-seen">
              {peer.lastSeenAt === null ? (
                t('preferences.multiHost.share.peer.never')
              ) : (
                <time dateTime={peer.lastSeenAt}>{format.dateTime(peer.lastSeenAt)}</time>
              )}
            </dd>
            <dt className="text-muted-foreground">{t('preferences.multiHost.share.peer.lastAddress')}</dt>
            <dd className="font-mono">
              {peer.lastAddress ?? t('preferences.multiHost.share.peer.noAddress')}
            </dd>
          </dl>
        </div>
      )}
      {question === null ? null : (
        <Alert
          tone="warning"
          data-slot="peer-confirm"
          data-confirm={asking ?? undefined}
          title={question.title}
          actions={
            <>
              <Button
                size="sm"
                variant="outline"
                data-action="peer-keep"
                autoFocus
                disabled={busy}
                onClick={keep}
              >
                {t('preferences.multiHost.share.peer.cancel')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                data-action="peer-confirm"
                disabled={busy}
                onClick={() => {
                  if (asking !== null) run(asking);
                }}
              >
                {busy ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
                {question.confirm}
              </Button>
            </>
          }
        >
          {question.body}
        </Alert>
      )}
      {error === null ? null : (
        <Alert tone="error" title={t('preferences.multiHost.share.peer.failed')}>
          {tError(error)}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {peer === null ? null : (
          <Button
            ref={unpairRef}
            variant="outline"
            size="sm"
            data-action="peer-unpair"
            disabled={busy}
            onClick={() => {
              setDone(null);
              onConfirmChange('unpair');
            }}
          >
            <UnlinkIcon aria-hidden />
            {t('preferences.multiHost.share.peer.unpair')}
          </Button>
        )}
        <Button
          ref={renewRef}
          variant="ghost"
          size="sm"
          data-action="peer-renew"
          disabled={busy}
          onClick={() => {
            setDone(null);
            onConfirmChange('renew');
          }}
        >
          <KeyRoundIcon aria-hidden />
          {t('preferences.multiHost.share.peer.renew')}
        </Button>
      </div>
    </Part>
  );
}
