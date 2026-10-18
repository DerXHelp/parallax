import { PlayIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  SOUND_IDS,
  soundIdSchema,
  type HostState,
  type NotificationEventSettings,
  type NotificationSettings,
  type SoundId,
} from '@shared/model';
import { NOTIFICATION_KINDS, type NotificationKind } from '@shared/status';
import { useT } from '@web/i18n';
import { playSound, unlockAudio } from '@web/notifications/sounds';
import { IconButton } from '@web/ui/icon-button';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/ui/select';
import { Slider } from '@web/ui/slider';
import { Switch } from '@web/ui/switch';
import { HostWarnings } from '../components/HostWarnings';
import { NumberField } from '../components/NumberField';
import { SettingField, SettingList } from '../components/SettingField';
import { DONE_SECONDS } from '../lib/limits';
import type { SettingsEditor } from '../state/settings-editor';

/** Played after a volume change (the user hears the new loudness). */
const VOLUME_PREVIEW: SoundId = 'ping';
/** Arrow/Page/Home/End keys on the volume: saved and played once this long after the last key. */
export const VOLUME_KEY_COMMIT_MS = 300;

/** "Play" and every choice in the sound list: the click is the interaction that unlocks Web Audio. */
function preview(soundId: SoundId, volume: number): void {
  unlockAudio();
  void playSound(soundId, volume);
}

function EventRow({
  kind,
  event,
  volume,
  onChange,
}: {
  kind: NotificationKind;
  event: NotificationEventSettings;
  volume: number;
  onChange: (event: NotificationEventSettings) => void;
}) {
  const t = useT();
  const name = t(`preferences.notifications.kinds.${kind}`);
  return (
    <tr data-event={kind} className="border-t">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
        {name}
      </th>
      <td className="px-3 py-1.5">
        <Switch
          aria-label={t('preferences.notifications.toastFor', { event: name })}
          checked={event.toast}
          onCheckedChange={(toast) => {
            onChange({ ...event, toast });
          }}
        />
      </td>
      <td className="py-1.5 pl-3">
        <div className="flex items-center gap-2">
          <Switch
            aria-label={t('preferences.notifications.soundFor', { event: name })}
            checked={event.sound}
            onCheckedChange={(sound) => {
              onChange({ ...event, sound });
            }}
          />
          <Select
            value={event.soundId}
            disabled={!event.sound}
            onValueChange={(value) => {
              const soundId = soundIdSchema.safeParse(value);
              if (!soundId.success) return;
              onChange({ ...event, soundId: soundId.data });
              preview(soundId.data, volume);
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-32"
              aria-label={t('preferences.notifications.soundIdFor', { event: name })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOUND_IDS.map((soundId) => (
                <SelectItem key={soundId} value={soundId}>
                  {t(`preferences.sounds.names.${soundId}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <IconButton
            label={t('preferences.notifications.previewFor', { event: name })}
            size="icon-sm"
            onClick={() => {
              preview(event.soundId, volume);
            }}
          >
            <PlayIcon aria-hidden />
          </IconButton>
        </div>
      </td>
    </tr>
  );
}

function VolumeSlider({ volume, onCommit }: { volume: number; onCommit: (volume: number) => void }) {
  const t = useT();
  /** Percent while dragging or between key presses (saved once at the end, not per pixel/key). */
  const [dragging, setDragging] = useState<number | null>(null);
  const viaKeyboard = useRef(false);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyValue = useRef<number | null>(null);
  const latestCommit = useRef(onCommit);
  useLayoutEffect(() => {
    latestCommit.current = onCommit;
  }, [onCommit]);

  const commit = (value: number, withPreview: boolean) => {
    setDragging(null);
    latestCommit.current(value / 100);
    if (withPreview) preview(VOLUME_PREVIEW, value / 100);
  };
  /** Saves the pending keyboard value and plays it. */
  const flushKeys = () => {
    keyTimer.current = null;
    const value = keyValue.current;
    keyValue.current = null;
    if (value !== null) commit(value, true);
  };
  // The page closes right after a key press: the value is still saved (without a sound).
  useEffect(
    () => () => {
      if (keyTimer.current !== null) clearTimeout(keyTimer.current);
      const value = keyValue.current;
      if (value !== null) latestCommit.current(value / 100);
    },
    [],
  );

  const percent = dragging ?? Math.round(volume * 100);
  const valueText = (value: number) => t('preferences.notifications.volumeValue', { percent: value });
  return (
    <div className="flex w-56 items-center gap-3">
      <Slider
        thumbLabel={t('preferences.notifications.volume')}
        valueText={valueText}
        min={0}
        max={100}
        step={1}
        value={[percent]}
        onKeyDown={() => {
          viaKeyboard.current = true;
        }}
        onPointerDown={() => {
          viaKeyboard.current = false;
        }}
        onValueChange={([value]) => {
          if (value !== undefined) setDragging(value);
        }}
        onValueCommit={([value]) => {
          if (value === undefined) return;
          if (!viaKeyboard.current) {
            commit(value, true);
            return;
          }
          // R4W-17: Radix commits on every key – save and play once after the last one.
          keyValue.current = value;
          if (keyTimer.current !== null) clearTimeout(keyTimer.current);
          keyTimer.current = setTimeout(flushKeys, VOLUME_KEY_COMMIT_MS);
        }}
      />
      <span className="text-muted-foreground w-10 text-right text-xs tabular-nums" aria-hidden>
        {valueText(percent)}
      </span>
    </div>
  );
}

/**
 * Notifications (ADR-109, Plan "Benachrichtigungen"): per event toast/sound/sound choice with a
 * preview, volume, "Do not disturb", focus rule, "done" threshold, click opens the session
 * (needs the system integration, ADR-110). The server applies all but the sounds.
 */
export function NotificationsSection({
  editor,
  hostState,
}: {
  editor: SettingsEditor;
  hostState: HostState | null;
}) {
  const t = useT();
  const { settings, save } = editor;
  const notifications = settings.notifications;
  const integration = hostState?.systemIntegration ?? false;
  const update = (patch: Partial<NotificationSettings>) => {
    save({ notifications: { ...notifications, ...patch } });
  };
  const updateEvent = (kind: NotificationKind, event: NotificationEventSettings) => {
    update({ events: { ...notifications.events, [kind]: event } });
  };

  return (
    <SettingList>
      <SettingField
        name="events"
        label={t('preferences.notifications.events')}
        description={t('preferences.notifications.eventsHint')}
        below={({ labelId }) => (
          <div className="overflow-x-auto">
            <table aria-labelledby={labelId} className="w-full text-xs">
              <thead className="text-muted-foreground text-2xs">
                <tr>
                  <th scope="col" className="pr-3 pb-1.5 text-left font-medium">
                    {t('preferences.notifications.columns.event')}
                  </th>
                  <th scope="col" className="px-3 pb-1.5 text-left font-medium">
                    {t('preferences.notifications.columns.toast')}
                  </th>
                  <th scope="col" className="pb-1.5 pl-3 text-left font-medium">
                    {t('preferences.notifications.columns.sound')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {NOTIFICATION_KINDS.map((kind) => (
                  <EventRow
                    key={kind}
                    kind={kind}
                    event={notifications.events[kind]}
                    volume={notifications.volume}
                    onChange={(event) => {
                      updateEvent(kind, event);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      />
      <SettingField
        name="volume"
        label={t('preferences.notifications.volume')}
        // The slider thumb is no labelable element; it carries the name itself (V3-12).
        labelFor={false}
        control={() => (
          <VolumeSlider
            volume={notifications.volume}
            onCommit={(volume) => {
              update({ volume });
            }}
          />
        )}
      />
      <SettingField
        name="doNotDisturb"
        label={t('preferences.notifications.doNotDisturb')}
        description={t('preferences.notifications.doNotDisturbHint')}
        control={({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            checked={notifications.doNotDisturb}
            onCheckedChange={(doNotDisturb) => {
              update({ doNotDisturb });
            }}
          />
        )}
      />
      <SettingField
        name="focusedElsewhere"
        label={t('preferences.notifications.focusedElsewhere')}
        below={({ id, labelId }) => (
          <RadioGroup
            aria-labelledby={labelId}
            value={notifications.focusedElsewhere}
            onValueChange={(value) => {
              if (value === 'in_app' || value === 'system') update({ focusedElsewhere: value });
            }}
          >
            {(['in_app', 'system'] as const).map((value) => (
              <div key={value} className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-${value}`} value={value} />
                <Label htmlFor={`${id}-${value}`} className="font-normal">
                  {value === 'in_app'
                    ? t('preferences.notifications.focusedElsewhereInApp')
                    : t('preferences.notifications.focusedElsewhereSystem')}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
      />
      <SettingField
        name="doneMinSeconds"
        label={t('preferences.notifications.doneMinSeconds')}
        description={t('preferences.notifications.doneMinSecondsHint')}
        control={({ id, describedBy }) => (
          <NumberField
            id={id}
            describedBy={describedBy}
            value={notifications.doneMinSeconds}
            range={DONE_SECONDS}
            unit={t('preferences.notifications.seconds')}
            onCommit={(value) => {
              if (value !== null) update({ doneMinSeconds: value });
            }}
          />
        )}
      />
      <SettingField
        name="openOnClick"
        label={t('preferences.notifications.openOnClick')}
        description={t('preferences.notifications.openOnClickHint')}
        disabled={!integration}
        disabledReason={integration ? null : t('preferences.systemIntegrationOff')}
        control={({ id, describedBy }) => (
          <Switch
            id={id}
            aria-describedby={describedBy}
            disabled={!integration}
            checked={notifications.openOnClick}
            onCheckedChange={(openOnClick) => {
              update({ openOnClick });
            }}
          />
        )}
        below={() => <HostWarnings hostState={hostState} codes={['PROTOCOL_HANDLER_FAILED']} />}
      />
    </SettingList>
  );
}
