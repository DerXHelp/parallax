# src/web/i18n – Übersetzungen (WP-14)

Typisierte Wörterbücher, Englisch (Default, Start immer Englisch) und Deutsch; `de` hat den Typ
von `en` (fehlende Keys = Compile-Fehler, Test prüft zusätzlich Plural-Formen und leere Texte).
Server-Fehlercodes (`@shared/errors`) werden hier übersetzt (`errors.en.ts`/`errors.de.ts`, Typ
`Record<ErrorCode, string>`, Texte ohne Platzhalter). Kein UI-String ohne `t()` – auch `title`,
`aria-label`, `placeholder`.

| Datei | Inhalt |
|---|---|
| `index.ts` | `t`, `tError`, `translate`, `translateError`, `useT`, `useI18n` (`{ t, tError, format, language }`), `useFormat`, `TranslationKey`, `Dictionary`, `DICTIONARIES`; Re-Exporte aus `language.ts` |
| `language.ts` | `getLanguage`, `setLanguage` (setzt `<html lang>`), `useLanguage`, `LANGUAGES` |
| `format.ts` | `Intl`: `formatNumber`, `formatPercent`, `formatCompactNumber`, `formatDate`, `formatDateTime`, `formatTime`, `formatRelativeTime`, `formatDuration`, `pluralCategory` |
| `en.ts`, `de.ts` | Shell-Namespaces `common`, `shell`, `status` (= `status.<DisplayStatusKind>`), `auth`, `connection`, `settings` |
| `errors.en.ts`, `errors.de.ts` | `errors.<CODE>` |
| `types.ts` | `PluralForms`, `KeyPaths`, `TranslationParams` |

**Syntax:** Platzhalter `{name}` (Zahlen werden sprachgerecht formatiert, unbekannte Platzhalter
bleiben sichtbar). Plural als Objekt `{ one: '…', other: '…' }`, gewählt über `params.count`
(`Intl.PluralRules`). `other` ist als Namespace-Schlüssel tabu.

**Namespaces je Feature (R0-03):** `src/web/features/<f>/i18n/en.ts` (`export const en = { … }`)
und `de.ts` (`export const de: typeof en = { … }`); Namespace = Ordnername (`transcript`,
`decisions`, `composer`). Die Stubs hat WP-14 angelegt und statisch in `index.ts` registriert;
WP-15/16 ändern nur ihre eigenen Dateien: `t('transcript.toolCall.running')`. Neue Namespaces
registriert der Koordinator. In Welle 1b ist dieser Ordner read-only.
