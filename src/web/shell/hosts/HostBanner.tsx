import { useState } from 'react';
import type { HostId } from '@shared/common';
import { useT } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { hostIdOf, useHostLabels, useHostVersion, useOwnVersion, type HostLabel } from '@web/state/hosts';
import { showErrorNotice } from '@web/state/notices';
import { Banner } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { requestShell } from '../requests';

/** The text of an unavailable computer (incompatible: with both versions when known). */
function useBannerText(host: HostLabel): string {
  const t = useT();
  const version = useHostVersion(host.hostId);
  const own = useOwnVersion();
  const name = host.name;
  switch (host.availability) {
    case 'incompatible':
      if (own === null) return t('hosts.unavailable.incompatiblePlain', { name });
      return version === null
        ? t('hosts.unavailable.incompatibleUnknown', { name, own })
        : t('hosts.unavailable.incompatible', { name, version, own });
    case 'revoked':
      return t('hosts.unavailable.revoked', { name });
    default:
      return t('hosts.unavailable.unreachable', { name });
  }
}

function UnavailableBanner({ host }: { host: HostLabel }) {
  const t = useT();
  const text = useBannerText(host);
  const [pending, setPending] = useState(false);
  const reconnect = (hostId: HostId) => {
    setPending(true);
    sendCommand(null, { name: 'hosts.reconnect', hostId })
      .catch((error: unknown) => {
        showErrorNotice(errorPayloadOf(error));
      })
      .finally(() => {
        setPending(false);
      });
  };
  return (
    <Banner
      tone="warning"
      data-slot="pane-host"
      data-availability={host.availability}
      actions={
        <>
          {host.availability === 'revoked' ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                reconnect(host.hostId);
              }}
            >
              {t('hosts.unavailable.reconnect')}
            </Button>
          )}
          <Button
            size="sm"
            variant={host.availability === 'revoked' ? 'outline' : 'ghost'}
            onClick={() => {
              requestShell({ kind: 'settings', section: 'multiHost' });
            }}
          >
            {t('hosts.unavailable.settings')}
          </Button>
        </>
      }
    >
      {text}
    </Banner>
  );
}

/**
 * Banner of a session whose computer cannot be used now (WP-80, WP-75 §4.4): not reachable (with
 * "Reconnect" = `hosts.reconnect` on this computer), another version (both versions when known –
 * no update from afar, A13) or the pairing removed (settings to pair again). While a computer is
 * only connecting nothing shows (the sidebar row names it). Nothing for this computer's sessions.
 */
export function HostBanner({ sessionKey }: { sessionKey: string }) {
  const hosts = useHostLabels();
  const hostId = hostIdOf(sessionKey);
  const host = hostId === null ? undefined : hosts.get(hostId);
  if (host === undefined || host.availability === 'available' || host.availability === 'connecting')
    return null;
  return <UnavailableBanner host={host} />;
}
