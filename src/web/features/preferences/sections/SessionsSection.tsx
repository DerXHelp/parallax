import { useT } from '@web/i18n';
import { Switch } from '@web/ui/switch';
import { NumberField } from '../components/NumberField';
import { SettingField, SettingList } from '../components/SettingField';
import { IDLE_MINUTES } from '../lib/limits';
import type { SettingsEditor } from '../state/settings-editor';

/**
 * Sessions: idle sleep (ADR-105, the server re-plans at once) and prompt suggestions (ADR-117, one
 * extra request per turn, from the next process start).
 */
export function SessionsSection({ editor }: { editor: SettingsEditor }) {
  const t = useT();
  const { settings, save } = editor;
  const { idleSleep } = settings;
  return (
    <SettingList>
      <SettingField
        name="idleSleep"
        label={t('preferences.sessions.idleSleep')}
        description={t('preferences.sessions.idleSleepHint')}
        control={({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            checked={idleSleep.enabled}
            onCheckedChange={(enabled) => {
              save({ idleSleep: { ...idleSleep, enabled } });
            }}
          />
        )}
      />
      <SettingField
        name="idleMinutes"
        label={t('preferences.sessions.idleMinutes')}
        disabled={!idleSleep.enabled}
        control={({ id, describedBy }) => (
          <NumberField
            id={id}
            describedBy={describedBy}
            value={idleSleep.minutes}
            range={IDLE_MINUTES}
            disabled={!idleSleep.enabled}
            unit={t('preferences.sessions.minutes')}
            onCommit={(minutes) => {
              if (minutes !== null) save({ idleSleep: { ...idleSleep, minutes } });
            }}
          />
        )}
      />
      <SettingField
        name="promptSuggestions"
        label={t('preferences.sessions.promptSuggestions')}
        description={t('preferences.sessions.promptSuggestionsHint')}
        control={({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            checked={settings.promptSuggestions}
            onCheckedChange={(promptSuggestions) => {
              save({ promptSuggestions });
            }}
          />
        )}
      />
    </SettingList>
  );
}
