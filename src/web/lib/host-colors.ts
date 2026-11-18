import type { HostColor } from '@shared/model';

/**
 * Colors of a computer's badge (WP-80, `HOST_COLORS`). There are no own host tokens in index.css
 * (coordinator area), so the badge reuses the eight profile tokens – each host color maps to a
 * different one (rose → pink, orange → red). Static class strings: Tailwind scans literals only.
 * The color never stands alone: the badge always carries the computer's short name.
 */
export const HOST_BG: Readonly<Record<HostColor, string>> = {
  blue: 'bg-profile-blue',
  green: 'bg-profile-green',
  amber: 'bg-profile-amber',
  violet: 'bg-profile-violet',
  rose: 'bg-profile-pink',
  teal: 'bg-profile-teal',
  orange: 'bg-profile-red',
  slate: 'bg-profile-slate',
};

/** Border classes of the same colors (badge outline, group header marker). */
export const HOST_BORDER: Readonly<Record<HostColor, string>> = {
  blue: 'border-profile-blue',
  green: 'border-profile-green',
  amber: 'border-profile-amber',
  violet: 'border-profile-violet',
  rose: 'border-profile-pink',
  teal: 'border-profile-teal',
  orange: 'border-profile-red',
  slate: 'border-profile-slate',
};

/** Longest short name on a badge (characters, by code point). */
export const HOST_SHORT_NAME_MAX = 12;

/**
 * Short name of a computer for its badge: the display name, cut to HOST_SHORT_NAME_MAX code points
 * with an ellipsis (the full name stays in the tooltip/aria-label).
 */
export function hostShortName(name: string): string {
  const trimmed = name.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= HOST_SHORT_NAME_MAX) return trimmed;
  return `${chars
    .slice(0, HOST_SHORT_NAME_MAX - 1)
    .join('')
    .trimEnd()}…`;
}
