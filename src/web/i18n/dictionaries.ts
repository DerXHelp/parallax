import type { Language } from '@shared/common';
import { en as composerEn } from '@web/features/composer/i18n/en';
import { en as decisionsEn } from '@web/features/decisions/i18n/en';
import { en as filesEn } from '@web/features/files/i18n/en';
import { en as preferencesEn } from '@web/features/preferences/i18n/en';
import { en as profilesEn } from '@web/features/profiles/i18n/en';
import { en as tasksEn } from '@web/features/tasks/i18n/en';
import { en as transcriptEn } from '@web/features/transcript/i18n/en';
import { en as navigationEn } from '@web/shell/navigation/i18n/en';
import { en as newSessionEn } from '@web/shell/new-session/i18n/en';
import { en as serverShutdownEn } from '@web/shell/server-shutdown/i18n/en';
import { en as sidePanelEn } from '@web/shell/side-panel/i18n/en';
import { en } from './en';
import { errorsEn } from './errors.en';

/**
 * The dictionaries of all namespaces (Plan Punkt 5, architecture §2.3a, ADR-153). English – the
 * default, the start language and the fallback of every missing text – is static and part of the
 * start chunk. Every other language is ONE lazy chunk (`dictionary.<language>.ts`, all of its
 * namespaces) that `loadDictionary` fetches before `setLanguage` switches (language.ts).
 *
 * Namespaces: shell (`common`, `shell`, `status`, `auth`, `connection`, `settings` – en.ts),
 * `errors` (errors.*.ts), one per feature (`transcript`, `decisions`, `composer` –
 * src/web/features/<f>/i18n) and `serverShutdown` (src/web/shell/server-shutdown/i18n, WP-21).
 * Phase 2 (WP-30 §4.14 C): `navigation` (shell/navigation, WP-35), `newSession` (shell/new-session,
 * WP-36), `profiles` (features/profiles, WP-36), `preferences` (features/preferences, WP-38).
 * Phase 3 (WP-50 §4.14 C): `files` (features/files, WP-54), `tasks` (features/tasks, WP-55),
 * `sidePanel` (shell/side-panel, WP-54). A new namespace is registered by the coordinator (or the
 * WP that owns this folder) – here AND in every `dictionary.<language>.ts`.
 */
export const EN_DICTIONARY = {
  ...en,
  errors: errorsEn,
  transcript: transcriptEn,
  decisions: decisionsEn,
  composer: composerEn,
  serverShutdown: serverShutdownEn,
  navigation: navigationEn,
  newSession: newSessionEn,
  profiles: profilesEn,
  preferences: preferencesEn,
  files: filesEn,
  tasks: tasksEn,
  sidePanel: sidePanelEn,
};

/** Shape of every language's dictionary (English is the reference). */
export type Dictionary = typeof EN_DICTIONARY;

/** Languages whose dictionary is a lazy chunk (every language but English). */
export type LazyLanguage = Exclude<Language, 'en'>;

/**
 * One dynamic import per lazy language – never a static one (`bundle.test.ts` walks the static
 * import graph of main.tsx). A new language without an entry here is a compile error.
 */
const IMPORTERS: Readonly<Record<LazyLanguage, () => Promise<Dictionary>>> = {
  de: () => import('./dictionary.de').then((module) => module.deDictionary),
};

const loaded = new Map<Language, Dictionary>([['en', EN_DICTIONARY]]);
const pending = new Map<LazyLanguage, Promise<Dictionary>>();

/** The dictionary of `language` once it is in memory (English always), else undefined. */
export function getDictionary(language: Language): Dictionary | undefined {
  return loaded.get(language);
}

export function hasDictionary(language: Language): boolean {
  return loaded.has(language);
}

/**
 * Loads the dictionary of `language` (one request at a time). A failed chunk is not remembered:
 * the next call tries again (e.g. the next language switch after a reconnect).
 */
export function loadDictionary(language: Language): Promise<Dictionary> {
  if (language === 'en') return Promise.resolve(EN_DICTIONARY);
  const ready = loaded.get(language);
  if (ready !== undefined) return Promise.resolve(ready);
  let request = pending.get(language);
  if (request === undefined) {
    request = IMPORTERS[language]()
      .then((dictionary) => {
        loaded.set(language, dictionary);
        return dictionary;
      })
      .finally(() => {
        pending.delete(language);
      });
    pending.set(language, request);
  }
  return request;
}

// Vitest (mode 'test') only: tests switch the language synchronously (`setLanguage('de')`, then
// assert German texts), so the lazy dictionaries are in memory before any test module runs. Builds
// and the dev server (mode 'production' / 'development') fold this branch away.
if (import.meta.env.MODE === 'test') await loadDictionary('de');
