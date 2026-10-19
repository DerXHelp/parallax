import { DEFAULT_PORT, type HostState } from '@shared/model';
import { useT } from '@web/i18n';
import { Switch } from '@web/ui/switch';
import { HostWarnings } from '../components/HostWarnings';
import { NumberField } from '../components/NumberField';
import { SettingField, SettingList } from '../components/SettingField';
import { PORT_RANGE } from '../lib/limits';
import type { SettingsEditor } from '../state/settings-editor';

/**
 * Server: the port (ADR-111, after "Stop server" and a restart; `HostState.port` is the actual one)
 * and autostart (ADR-110, only with the system integration of the productive server).
 */
export function ServerSection({
  editor,
  hostState,
}: {
  editor: SettingsEditor;
  hostState: HostState | null;
}) {
  const t = useT();
  const { settings, save } = editor;
  const { autostart } = settings;
  const integration = hostState?.systemIntegration ?? false;
  const defaultPort = String(DEFAULT_PORT);
  const currentPort = hostState?.port ?? null;
  const integrationReason = integration ? null : t('preferences.systemIntegrationOff');
  // R4W-18: the sub-option says why it cannot be used (no integration, or autostart is off).
  const openWindowReason =
    integrationReason ?? (autostart.enabled ? null : t('preferences.server.openWindowNeedsAutostart'));
  return (
    <SettingList>
      <SettingField
        name="port"
        label={t('preferences.server.port')}
        description={
          currentPort === null
            ? t('preferences.server.portHint', { port: defaultPort })
            : `${t('preferences.server.portHint', { port: defaultPort })} ${t('preferences.server.currentPort', { port: String(currentPort) })}`
        }
        control={({ id, describedBy }) => (
          <NumberField
            id={id}
            describedBy={describedBy}
            value={settings.port}
            range={PORT_RANGE}
            allowEmpty
            placeholder={t('preferences.server.portPlaceholder', { port: defaultPort })}
            onCommit={(port) => {
              save({ port });
            }}
          />
        )}
      />
      <SettingField
        name="autostart"
        label={t('preferences.server.autostart')}
        description={t('preferences.server.autostartHint')}
        disabled={!integration}
        disabledReason={integrationReason}
        control={({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            disabled={!integration}
            checked={autostart.enabled}
            onCheckedChange={(enabled) => {
              save({ autostart: { ...autostart, enabled } });
            }}
          />
        )}
        below={() => (
          <HostWarnings
            hostState={hostState}
            codes={['AUTOSTART_FAILED']}
            foreignHint={t('preferences.server.autostartForeign')}
          />
        )}
      />
      <SettingField
        name="openWindow"
        label={t('preferences.server.openWindow')}
        disabled={openWindowReason !== null}
        disabledReason={openWindowReason}
        control={({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            disabled={openWindowReason !== null}
            checked={autostart.openWindow}
            onCheckedChange={(openWindow) => {
              save({ autostart: { ...autostart, openWindow } });
            }}
          />
        )}
      />
    </SettingList>
  );
}
