import { PlayIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { makeError } from '@shared/errors';
import { SOUND_IDS, type HostState } from '@shared/model';
import { useT } from '@web/i18n';
import { playSound, unlockAudio } from '@web/notifications/sounds';
import { startScenario } from '@web/playground/PlaygroundScenario';
import type { PlaygroundDemo } from '@web/playground/types';
import type { SettingsSection } from '@web/shell/requests';
import type { FeatureSlots } from '@web/shell/slots';
import { Button } from '@web/ui/button';
import { Slider } from '@web/ui/slider';
import { SettingsPage } from './SettingsPage';

/**
 * Playground demos of the settings page (architecture §2.3c, `#playground=preferences/<id>`): every
 * section over the FakeHost (the page saves through `settings.update` like in the app), with and
 * without the system integration of the productive server, with host warnings, plus the sound
 * preview. `slots` puts the page into the shell demos (menu "Settings…").
 */

/** Host state variants on top of the empty scenario (settings of the window are kept). */
type HostVariant = 'plain' | 'integration' | 'warnings';

const AT = new Date(Date.UTC(2026, 9, 16, 9, 30)).toISOString();

function variantOf(variant: HostVariant): Partial<HostState> {
  switch (variant) {
    case 'plain':
      return { port: 4712 };
    case 'integration':
      return { port: 4711, systemIntegration: true, backend: 'sdk', dev: false };
    case 'warnings':
      return {
        port: 4711,
        systemIntegration: true,
        backend: 'sdk',
        dev: false,
        warnings: [
          { id: 'w-protocol', error: makeError('PROTOCOL_HANDLER_FAILED'), at: AT },
          // CR2-03: a foreign Parallax.lnk – the warning says what to do.
          { id: 'w-autostart', error: makeError('AUTOSTART_FAILED', { reason: 'foreign' }), at: AT },
        ],
      };
  }
}

function PageDemo({ section, variant }: { section: SettingsSection; variant: HostVariant }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const running = startScenario('empty', { select: null });
    running.host.setHostState({ ...running.host.hostState, ...variantOf(variant) });
    return () => {
      running.stop();
    };
  }, [variant]);
  return (
    <div className="p-6">
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('preferences.menuItem')}
      </Button>
      {open ? (
        <SettingsPage
          section={section}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** All five sounds at a chosen volume (the click unlocks Web Audio). */
function SoundsDemo() {
  const t = useT();
  const [percent, setPercent] = useState(60);
  const valueText = (value: number) => t('preferences.notifications.volumeValue', { percent: value });
  return (
    <div className="mx-auto grid max-w-xl gap-5 p-6">
      <div className="flex items-center gap-3">
        <Slider
          thumbLabel={t('preferences.notifications.volume')}
          valueText={valueText}
          value={[percent]}
          onValueChange={([value]) => {
            if (value !== undefined) setPercent(value);
          }}
          className="max-w-64"
        />
        <span className="text-muted-foreground text-xs tabular-nums">{valueText(percent)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {SOUND_IDS.map((soundId) => (
          <Button
            key={soundId}
            variant="outline"
            data-sound={soundId}
            onClick={() => {
              unlockAudio();
              void playSound(soundId, percent / 100);
            }}
          >
            <PlayIcon aria-hidden />
            {t(`preferences.sounds.names.${soundId}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}

function pageDemo(id: string, title: string, section: SettingsSection, variant: HostVariant): PlaygroundDemo {
  return { id, title, render: () => <PageDemo section={section} variant={variant} /> };
}

export const demos: PlaygroundDemo[] = [
  pageDemo('general', 'Settings – General', 'general', 'plain'),
  pageDemo('notifications', 'Settings – Notifications (no system integration)', 'notifications', 'plain'),
  pageDemo(
    'notifications-integration',
    'Settings – Notifications (system integration, PROTOCOL_HANDLER_FAILED)',
    'notifications',
    'warnings',
  ),
  pageDemo('sessions', 'Settings – Sessions', 'sessions', 'plain'),
  pageDemo('profiles', 'Settings – Profiles (slot of WP-36)', 'profiles', 'plain'),
  pageDemo('server', 'Settings – Server (no system integration)', 'server', 'plain'),
  pageDemo('server-integration', 'Settings – Server (system integration)', 'server', 'integration'),
  pageDemo('server-warnings', 'Settings – Server (AUTOSTART_FAILED)', 'server', 'warnings'),
  pageDemo('about', 'Settings – About', 'about', 'integration'),
  {
    id: 'sounds',
    title: 'Notification sounds (Web Audio preview)',
    description: 'Five synthesized sounds, ≤ 600 ms; the first click unlocks audio.',
    render: () => <SoundsDemo />,
  },
];

export const slots: Partial<FeatureSlots> = { SettingsPage };
