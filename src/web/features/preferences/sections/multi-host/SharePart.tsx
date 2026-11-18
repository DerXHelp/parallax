import type { MultiHostConfig, RemoteAccessState } from '@shared/model';
import { useT } from '@web/i18n';
import { AccessStatus } from './AccessStatus';
import { ConnectionLog } from './ConnectionLog';
import { ListenerSettings } from './ListenerSettings';
import { PairingPanel } from './PairingPanel';
import { PeerPanel, type PeerConfirm } from './PeerPanel';
import type { ConfigureState } from './use-configure';

/**
 * Part "Share" of the section "Several computers" (WP-78b): listener state and checks, the paired
 * computer, pairing, port and address, connection log. `state` is null while the server sets the
 * role up (the host state follows the ack).
 */
export function SharePart({
  state,
  config,
  configure,
  peerConfirm,
  onPeerConfirmChange,
}: {
  state: RemoteAccessState | null;
  config: MultiHostConfig;
  configure: ConfigureState;
  peerConfirm: PeerConfirm;
  onPeerConfirmChange: (confirm: PeerConfirm) => void;
}) {
  const t = useT();
  if (state === null) {
    return (
      <p data-slot="multi-host-share-starting" className="text-muted-foreground text-xs">
        {t('preferences.multiHost.share.starting')}
      </p>
    );
  }
  return (
    <div data-slot="multi-host-share" className="grid gap-5">
      <AccessStatus state={state} config={config} />
      <PeerPanel state={state} confirm={peerConfirm} onConfirmChange={onPeerConfirmChange} />
      <PairingPanel state={state} />
      <ListenerSettings state={state} configure={configure} />
      <ConnectionLog state={state} />
    </div>
  );
}
