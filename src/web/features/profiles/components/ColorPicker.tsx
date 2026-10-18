import { CheckIcon } from 'lucide-react';
import { PROFILE_COLORS, profileColorSchema, type ProfileColor } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { PROFILE_BG } from '@web/shell/navigation/profile-colors';
import { ToggleGroup, ToggleGroupItem } from '@web/ui/toggle-group';

/**
 * The eight profile colors (`PROFILE_COLORS`, design tokens `--profile-*`) as a radio group:
 * arrows move, Space/Enter picks; every swatch has its color name (never color only) and the
 * chosen one a check mark.
 */
export function ColorPicker({
  value,
  onChange,
  labelId,
}: {
  value: ProfileColor;
  onChange: (color: ProfileColor) => void;
  labelId: string;
}) {
  const { t } = useI18n();
  return (
    <ToggleGroup
      type="single"
      aria-labelledby={labelId}
      value={value}
      data-slot="profile-color"
      onValueChange={(next) => {
        const parsed = profileColorSchema.safeParse(next);
        if (parsed.success) onChange(parsed.data);
      }}
      className="flex flex-wrap gap-1.5"
    >
      {PROFILE_COLORS.map((color) => (
        <ToggleGroupItem
          key={color}
          value={color}
          aria-label={t(`profiles.colors.${color}`)}
          data-color={color}
          className={cn(
            'size-6 min-w-6 flex-none rounded-full p-0 first:rounded-full last:rounded-full',
            'data-[state=on]:ring-ring data-[state=on]:bg-transparent data-[state=on]:ring-2',
          )}
        >
          <span
            aria-hidden
            className={cn('text-background flex size-4.5 items-center justify-center rounded-full', PROFILE_BG[color])}
          >
            {color === value ? <CheckIcon aria-hidden className="size-3" /> : null}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
