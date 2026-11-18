import { useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import type { RemoteAccessState } from '@shared/model';
import { useI18n } from '@web/i18n';
import { Alert } from '@web/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/ui/select';
import { NumberField } from '../../components/NumberField';
import { SettingField, SettingList } from '../../components/SettingField';
import { ALL_ADDRESSES, REMOTE_PORT_RANGE, bindAddressChoices } from '../../lib/multi-host';
import { Part } from './Part';
import type { ConfigureState } from './use-configure';

/**
 * Port and bind address of the listener (`multiHost.configure`; the server restarts the listener).
 * The address offers every IPv4 address (`0.0.0.0`) or one detected address of this computer.
 */
export function ListenerSettings({
  state,
  configure,
}: {
  state: RemoteAccessState;
  configure: ConfigureState;
}) {
  const { t, tError } = useI18n();
  const [error, setError] = useState<ErrorPayload | null>(null);
  const { config, busy } = configure;
  const choices = bindAddressChoices(config.bindAddress, state.addresses);

  const save = (change: { port: number } | { bindAddress: string }) => {
    setError(null);
    configure.configure(change, setError);
  };

  return (
    <Part name="listener" heading={t('preferences.multiHost.share.listener.heading')}>
      <SettingList>
        <SettingField
          name="remotePort"
          label={t('preferences.multiHost.share.listener.port')}
          description={t('preferences.multiHost.share.listener.portHint')}
          control={({ id, describedBy }) => (
            <NumberField
              id={id}
              describedBy={describedBy}
              value={config.port}
              range={REMOTE_PORT_RANGE}
              disabled={busy}
              onCommit={(port) => {
                if (port !== null) save({ port });
              }}
            />
          )}
        />
        <SettingField
          name="remoteBindAddress"
          label={t('preferences.multiHost.share.listener.bindAddress')}
          description={t('preferences.multiHost.share.listener.bindAddressHint')}
          control={({ id, describedBy }) => (
            <Select
              value={config.bindAddress}
              disabled={busy}
              onValueChange={(bindAddress) => {
                if (bindAddress !== config.bindAddress && choices.includes(bindAddress))
                  save({ bindAddress });
              }}
            >
              <SelectTrigger id={id} size="sm" className="w-56 font-mono" aria-describedby={describedBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((address) => (
                  <SelectItem key={address} value={address} className="font-mono">
                    {address === ALL_ADDRESSES
                      ? t('preferences.multiHost.share.listener.allAddresses', { address })
                      : address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </SettingList>
      {error === null ? null : (
        <Alert tone="error" title={t('preferences.multiHost.share.listener.failed')}>
          {tError(error)}
        </Alert>
      )}
    </Part>
  );
}
