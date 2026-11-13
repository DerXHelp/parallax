import { languageSchema, themeSchema } from '@shared/common';
import { useT } from '@web/i18n';
import { HOOK_DISPLAYS } from '@web/state/hook-display';
import { TRANSCRIPT_VIEWS } from '@web/state/transcript-view';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { SettingField, SettingList } from '../components/SettingField';
import type { SettingsEditor } from '../state/settings-editor';

/**
 * Language and theme – the same choice as the settings menu (which keeps its quick choice); WP-63:
 * the transcript view (compact / all steps; WP-65: a server setting like the others); WP-69: hook
 * runs in the transcript (all / failed and blocking only – default / off).
 */
export function GeneralSection({ editor }: { editor: SettingsEditor }) {
  const t = useT();
  const { settings, save } = editor;
  return (
    <SettingList>
      <SettingField
        name="language"
        label={t('settings.language')}
        description={t('preferences.general.languageHint')}
        below={({ id, labelId, describedBy }) => (
          <RadioGroup
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            value={settings.language}
            onValueChange={(value) => {
              const language = languageSchema.safeParse(value);
              if (language.success) save({ language: language.data });
            }}
            className="flex flex-wrap gap-x-5 gap-y-2"
          >
            {languageSchema.options.map((language) => (
              <div key={language} className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-${language}`} value={language} />
                <Label htmlFor={`${id}-${language}`} lang={language} className="font-normal">
                  {t(`settings.languages.${language}`)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
      />
      <SettingField
        name="theme"
        label={t('settings.theme')}
        description={t('preferences.general.themeHint')}
        below={({ id, labelId, describedBy }) => (
          <RadioGroup
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            value={settings.theme}
            onValueChange={(value) => {
              const theme = themeSchema.safeParse(value);
              if (theme.success) save({ theme: theme.data });
            }}
            className="flex flex-wrap gap-x-5 gap-y-2"
          >
            {themeSchema.options.map((theme) => (
              <div key={theme} className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-${theme}`} value={theme} />
                <Label htmlFor={`${id}-${theme}`} className="font-normal">
                  {t(`settings.themes.${theme}`)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
      />
      <SettingField
        name="transcriptView"
        label={t('preferences.general.transcript')}
        description={t('preferences.general.transcriptHint')}
        below={({ id, labelId, describedBy }) => (
          <RadioGroup
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            value={settings.transcriptView}
            onValueChange={(value) => {
              const view = TRANSCRIPT_VIEWS.find((candidate) => candidate === value);
              if (view !== undefined) save({ transcriptView: view });
            }}
            className="flex flex-wrap gap-x-5 gap-y-2"
          >
            {TRANSCRIPT_VIEWS.map((view) => (
              <div key={view} className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-${view}`} value={view} />
                <Label htmlFor={`${id}-${view}`} className="font-normal">
                  {t(`preferences.general.transcriptViews.${view}`)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
      />
      <SettingField
        name="hookDisplay"
        label={t('preferences.general.hooks')}
        description={t('preferences.general.hooksHint')}
        below={({ id, labelId, describedBy }) => (
          <RadioGroup
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            value={settings.hookDisplay}
            onValueChange={(value) => {
              const display = HOOK_DISPLAYS.find((candidate) => candidate === value);
              if (display !== undefined) save({ hookDisplay: display });
            }}
            className="flex flex-wrap gap-x-5 gap-y-2"
          >
            {HOOK_DISPLAYS.map((display) => (
              <div key={display} className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-${display}`} value={display} />
                <Label htmlFor={`${id}-${display}`} className="font-normal">
                  {t(`preferences.general.hookDisplays.${display}`)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
      />
    </SettingList>
  );
}
