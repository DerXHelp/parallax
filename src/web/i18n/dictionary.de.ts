import { de as composerDe } from '@web/features/composer/i18n/de';
import { de as decisionsDe } from '@web/features/decisions/i18n/de';
import { de as filesDe } from '@web/features/files/i18n/de';
import { de as preferencesDe } from '@web/features/preferences/i18n/de';
import { de as profilesDe } from '@web/features/profiles/i18n/de';
import { de as tasksDe } from '@web/features/tasks/i18n/de';
import { de as transcriptDe } from '@web/features/transcript/i18n/de';
import { de as navigationDe } from '@web/shell/navigation/i18n/de';
import { de as newSessionDe } from '@web/shell/new-session/i18n/de';
import { de as serverShutdownDe } from '@web/shell/server-shutdown/i18n/de';
import { de as sidePanelDe } from '@web/shell/side-panel/i18n/de';
import { de } from './de';
import type { Dictionary } from './dictionaries';
import { errorsDe } from './errors.de';

/**
 * Every German text in ONE lazy chunk (ADR-153): `loadDictionary('de')` (dictionaries.ts) imports
 * this module dynamically before the switch; nothing imports it statically (bundle.test.ts). The
 * type `Dictionary` (= the English shape) makes a missing namespace or key a compile error.
 */
export const deDictionary: Dictionary = {
  ...de,
  errors: errorsDe,
  transcript: transcriptDe,
  decisions: decisionsDe,
  composer: composerDe,
  serverShutdown: serverShutdownDe,
  navigation: navigationDe,
  newSession: newSessionDe,
  profiles: profilesDe,
  preferences: preferencesDe,
  files: filesDe,
  tasks: tasksDe,
  sidePanel: sidePanelDe,
};
