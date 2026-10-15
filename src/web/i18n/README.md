# src/web/i18n – Übersetzungen (WP-14)

Typisierte Wörterbücher, Englisch (Default) und Deutsch; `de` hat den Typ von `en` (fehlende Keys =
Compile-Fehler). Kleiner `t()`-Helper mit Interpolation und Plural; Datum, relative Zeit und Zahlen
über `Intl` (`format.ts`). Server-Fehlercodes (`@shared/errors`) werden hier übersetzt
(`errors.en.ts`/`errors.de.ts`, Typ `Record<ErrorCode, string>`). Kein UI-String ohne `t()`.

**Namespaces je Feature (R0-03, B „i18n-Dateien pro Feature-Bereich“):**
- Hier (WP-14): `index.ts` (`t`, `tError`, `useT`, Sprache), `en.ts`/`de.ts` mit den Namespaces
  der Shell (`common`, `shell`, `status` = `status.<DisplayStatusKind>`, `auth`, `connection`,
  `settings`), `errors.*.ts`, `format.ts`.
- Im Feature: `src/web/features/<f>/i18n/en.ts` (`export const en = { … }`) und `de.ts`
  (`export const de: typeof en = { … }`); Namespace = Ordnername (`transcript`, `decisions`,
  `composer`). WP-14 legt die drei Stub-Paare an und registriert sie statisch in `index.ts`;
  WP-15/16 ändern nur ihre eigenen Dateien. Schlüssel: `t('transcript.toolCall.running')`.
- In Welle 1b ist dieser Ordner read-only; neue Namespaces registriert der Koordinator.
