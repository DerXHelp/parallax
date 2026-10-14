# src/web/i18n – Übersetzungen (WP-14)

Typisierte Wörterbücher: `en.ts` (Default) und `de.ts` mit dem Typ von `en` (fehlende Keys =
Compile-Fehler), Dateien pro Feature-Bereich möglich. Kleiner `t()`-Helper mit Interpolation
und Plural; Datum, relative Zeit und Zahlen über `Intl`. Server-Fehlercodes
(`@shared/errors`) werden hier übersetzt. Kein UI-String ohne `t()`.
