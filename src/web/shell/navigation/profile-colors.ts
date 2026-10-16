import type { ProfileColor } from '@shared/model';

/** Static background classes per profile color (Tailwind scans literal strings only). */
export const PROFILE_BG: Readonly<Record<ProfileColor, string>> = {
  slate: 'bg-profile-slate',
  blue: 'bg-profile-blue',
  green: 'bg-profile-green',
  amber: 'bg-profile-amber',
  red: 'bg-profile-red',
  violet: 'bg-profile-violet',
  pink: 'bg-profile-pink',
  teal: 'bg-profile-teal',
};
