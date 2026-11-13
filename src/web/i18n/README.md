# src/web/i18n – Übersetzungen (WP-14)

Typisierte Wörterbücher, Englisch (Default, Start immer Englisch) und Deutsch; `de` hat den Typ
von `en` (fehlende Keys = Compile-Fehler, Test prüft zusätzlich Plural-Formen und leere Texte).
Server-Fehlercodes (`@shared/errors`) werden hier übersetzt (`errors.en.ts`/`errors.de.ts`, Typ
`Record<ErrorCode, string>`, Texte ohne Platzhalter). Kein UI-String ohne `t()` – auch `title`,
`aria-label`, `placeholder`.

| Datei | Inhalt |
|---|---|
| `index.ts` | `t`, `tError`, `translate`, `translateFrom` (WP-67: dieselbe Logik über ein beliebiges Wörterbuchpaar – Lazy-Namensräume), `translateError`, `useT`, `useI18n` (`{ t, tError, format, language }`), `useFormat`, `TranslationKey`, `KeyPaths`; Re-Exporte aus `dictionaries.ts` (`EN_DICTIONARY`, `getDictionary`, `Dictionary`) und `language.ts` |
| `dictionaries.ts` | Registrierung aller Namensräume: `EN_DICTIONARY` statisch (Start-Chunk, Rückfall), jede andere Sprache ein Lazy-Chunk (`loadDictionary`, `hasDictionary`, `getDictionary`; ADR-153). Im Vitest-Modus (`import.meta.env.MODE === 'test'`) lädt das Modul `de` vorab, damit Tests synchron umschalten können; Build und Dev-Server falten den Zweig weg |
| `dictionary.de.ts` | `deDictionary`: alle deutschen Namensräume in **einem** Chunk; wird nur dynamisch importiert (`bundle.test.ts` prüft den statischen Importgraphen von `main.tsx`) |
| `language.ts` | `getLanguage`, `setLanguage` (schaltet sofort, wenn das Wörterbuch da ist, sonst nach dem Laden; die letzte Anfrage gewinnt; setzt `<html lang>`), `useLanguage`, `LANGUAGES`, `getLanguageLoadFailure`/`useLanguageLoadFailure` (erster Ladefehler des Fensters → die Shell meldet ihn einmal, `ShellEffects`), `preloadLanguage` (lädt ohne umzuschalten), `createLanguageController` (testbarer Kern). Importiert keine App-Module (auch nicht `lib/storage`): sonst legt Rolldown den i18n-Kern in einen eigenen Start-Chunk; Merken und Vorladen der zuletzt genutzten Sprache: `state/language.ts` |
| `format.ts` | `Intl`: `formatNumber`, `formatPercent`, `formatCompactNumber`, `formatDate`, `formatDateTime`, `formatTime`, `formatRelativeTime`, `formatDuration`, `formatList` (statt `join(', ')`), `pluralCategory` |
| `en.ts`, `de.ts` | Shell-Namespaces `common`, `shell`, `status` (= `status.<DisplayStatusKind>`), `auth`, `connection`, `settings` |
| `errors.en.ts`, `errors.de.ts` | `errors.<CODE>` |
| `types.ts` | `PluralForms`, `KeyPaths`, `TranslationParams` |

**Syntax:** Platzhalter `{name}` (Zahlen werden sprachgerecht formatiert, unbekannte Platzhalter
bleiben sichtbar). Plural als Objekt `{ one: '…', other: '…' }`, gewählt über `params.count`
(`Intl.PluralRules`). `other` ist als Namespace-Schlüssel tabu.

**Sprachwechsel (ADR-153):** Start immer Englisch; `ShellEffects` wendet `settings.language` an
(`state/language.ts`). Deutsch ist ein Lazy-Chunk: bis er geladen ist, bleibt das Fenster Englisch
(wie vor dem Eintreffen von `host.state`). War Deutsch zuletzt aktiv, lädt `main.tsx` den Chunk beim
Start vorab. Schlägt das Laden fehl, bleibt Englisch und die Shell zeigt einmal je Fenster einen
Hinweis mit „Neu laden“.

**Namespaces je Feature (R0-03):** `src/web/features/<f>/i18n/en.ts` (`export const en = { … }`)
und `de.ts` (`export const de: typeof en = { … }`); Namespace = Ordnername (`transcript`,
`decisions`, `composer`). Die Stubs hat WP-14 angelegt; WP-15/16 ändern nur ihre eigenen Dateien:
`t('transcript.toolCall.running')`. Dazu kommt `serverShutdown`
(`src/web/shell/server-shutdown/i18n/{en,de}.ts`, WP-21, registriert in WP-20b). Neue Namespaces
registriert der Koordinator – in `dictionaries.ts` (en) **und** `dictionary.de.ts` (de).

**Lazy-Namensräume (WP-67, ADR-Vorschlag):** Texte, die nur ein Lazy-Chunk braucht und die das
Start-Chunk-Budget sprengen würden, liegen in einem eigenen Wörterbuchpaar, das **nur** dieser Chunk
statisch importiert und nicht in `dictionaries.ts`/`dictionary.de.ts` registriert ist. Übersetzt wird
mit `translateFrom(dictionary, en, language, key, params)` (gleiche Plural-, Platzhalter- und
Rückfallregeln wie `t`), gebunden über einen eigenen Hook (ADR-183). Bisher: die Reiter der
Session-Info (`src/web/shell/navigation/session-info/i18n/`, `useInfoT()`), WP-69 der Tab „Agent“
(`features/transcript/i18n-lazy/`), WP-70 Anmelde-Dialog (`shell/login/i18n/`) und Ausgabestil
(`shell/output-style/i18n/`). `bundle.test.ts` prüft,
dass beide Sprachen weder im Start-Chunk noch in `dictionary.de` landen, aber vom Chunk erreicht
werden (`LAZY_NAMESPACES`).
