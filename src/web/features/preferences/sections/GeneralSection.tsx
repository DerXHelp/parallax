import { languageSchema, themeSchema } from '@shared/common';
import { useT } from '@web/i18n';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { SettingField, SettingList } from '../components/SettingField';
import type { SettingsEditor } from '../state/settings-editor';

/** Language and theme – the same choice as the settings menu (which keeps its quick choice). */
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
    </SettingList>
  );
}
