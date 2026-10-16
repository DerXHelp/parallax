# src/web/shell/navigation – Navigation (Phase 2)

Owner: **WP-35**. Auftrag: `docs/wp/WP-35.md`.

Bausteine von Sidebar (flach/gruppiert, zweizeilig, Archiv), Quick-Switcher (Strg+K),
Kontextmenüs, Inline-Umbenennen, Kopfzeilen-Menü (Frühere Unterhaltungen, Session-Info, externe
Konsole) und Abo-Limit-Anzeige. Handler des Anfragekanals (`../requests.ts`): `renameTitle`,
`conversations`, `sessionInfo`, `quickSwitcher`.

| Pfad | Inhalt |
| --- | --- |
| `i18n/{en,de}.ts` | Namensraum `navigation` (registriert in `src/web/i18n/index.ts`) |
