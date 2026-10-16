# src/web/features/preferences – Einstellungsseite (Phase 2)

Owner: **WP-38**. Auftrag: `docs/wp/WP-38.md`.

Die Einstellungsseite (Allgemein, Benachrichtigungen, Sessions, Profile, Server, Über) als Slot
`SettingsPage` (`src/web/shell/slots.tsx`); geöffnet über die Shell-Anfrage `{kind: 'settings'}`
(`src/web/shell/requests.ts`). Der Bereich „Profile“ rendert den Slot `ProfilesSettings` (WP-36).
Töne und ihre Zustellung liegen in `src/web/notifications/` (ebenfalls WP-38).

| Pfad | Inhalt |
| --- | --- |
| `i18n/{en,de}.ts` | Namensraum `preferences` (registriert in `src/web/i18n/index.ts`) |

Importgrenzen: kein Import aus anderen Features (ESLint), Store nur über `@web/state/hooks`.
