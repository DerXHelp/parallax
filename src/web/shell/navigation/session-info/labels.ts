import type { InfoKey, InfoT } from './i18n';

/** Settings sources the tabs translate; anything newer shows as the CLI sent it. */
const SOURCE_KEY: Readonly<Record<string, InfoKey>> = {
  userSettings: 'sources.userSettings',
  projectSettings: 'sources.projectSettings',
  localSettings: 'sources.localSettings',
  flagSettings: 'sources.flagSettings',
  policySettings: 'sources.policySettings',
  cliArg: 'sources.cliArg',
  command: 'sources.command',
  session: 'sources.session',
};

export function sourceLabel(it: InfoT, source: string): string {
  const key = SOURCE_KEY[source];
  return key === undefined ? source : it(key);
}

/** Case-insensitive "contains" over several fields (empty needle matches everything). */
export function matchesFilter(needle: string, ...fields: readonly (string | null)[]): boolean {
  const lowered = needle.trim().toLocaleLowerCase();
  if (lowered === '') return true;
  return fields.some((field) => field?.toLocaleLowerCase().includes(lowered) === true);
}
