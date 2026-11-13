import { remoteControlNewSessionsSchema, type HostState } from '@shared/model';
import { useT } from '@web/i18n';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { Switch } from '@web/ui/switch';
import { NumberField } from '../components/NumberField';
import { SettingField, SettingList } from '../components/SettingField';
import { IDLE_MINUTES } from '../lib/limits';
import type { SettingsEditor } from '../state/settings-editor';

/**
 * Sessions: idle sleep (ADR-105, the server re-plans at once), prompt suggestions (ADR-117, one
 * extra request per turn, from the next process start) and Remote Control for new sessions (WP-64:
 * "like the Claude setting" names the value Claude reported – `HostState.remoteControlDefault`).
 */
export function SessionsSection({ editor, hostState }: { editor: SettingsEditor; hostState: HostState | null }) {
  const t = useT();
  const { settings, save } = editor;
  const { idleSleep } = settings;
  const detected = hostState?.remoteControlDefault ?? null;
  const detectedText = t(
    detected === null
      ? 'preferences.sessions.remoteDetectedUnknown'
      : detected
        ? 'preferences.sessions.remoteDetectedOn'
        : 'preferences.sessions.remoteDetectedOff',
  );
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
      <SettingField
        name="remoteControl"
        label={t('preferences.sessions.remoteControl')}
        description={t('preferences.sessions.remoteControlHint')}
        below={({ id, labelId, describedBy }) => (
          <RadioGroup
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            value={settings.remoteControl.newSessions}
            onValueChange={(value) => {
              const newSessions = remoteControlNewSessionsSchema.safeParse(value);
              if (newSessions.success) save({ remoteControl: { newSessions: newSessions.data } });
            }}
            className="flex flex-wrap gap-x-5 gap-y-2"
          >
            {remoteControlNewSessionsSchema.options.map((option) => (
              <div key={option} className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-${option}`} value={option} />
                <Label htmlFor={`${id}-${option}`} className="font-normal">
                  {option === 'follow_claude'
                    ? t('preferences.sessions.remoteFollow', { detected: detectedText })
                    : t(`preferences.sessions.remoteOptions.${option}`)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
      />
    </SettingList>
  );
}
