# src/web/features/profiles – Profil-Editor (Phase 2)

Owner: **WP-36**. Auftrag: `docs/wp/WP-36.md`.

Profilliste und Editor (Name, Farbe, Default, executable, `configDir`, Env mit Maskierung, Args mit
Befunden je Zeile, `contextWindow`, Vorgaben), „Profil testen“, Löschschutz – über die Host-Befehle
`profile.*` (ADR-101, ADR-102). Die Einstellungsseite (WP-38) rendert ihn über den Slot
`ProfilesSettings` (`src/web/shell/slots.tsx`); WP-40 setzt den Slot in `App.tsx`.

| Pfad | Inhalt |
| --- | --- |
| `i18n/{en,de}.ts` | Namensraum `profiles` (registriert in `src/web/i18n/index.ts`) |

Importgrenzen: kein Import aus anderen Features (ESLint), Store nur über `@web/state/hooks`.
