# src/web/shell/new-session – Neue Session (Phase 2)

Owner: **WP-36** (zusammen mit `../NewSessionDialog.tsx`, `../NewSessionForm.tsx`,
`../EmptyState.tsx`). Auftrag: `docs/wp/WP-36.md`.

Ordner-Browser (`fs.listDirectory`, ADR-119), Profilwahl und zuletzt genutzte Projekte des Dialogs
„Neue Session“. Handler des Anfragekanals (`../requests.ts`): `newSession` (mit Vorbelegung `cwd`,
`profileId`).

| Pfad | Inhalt |
| --- | --- |
| `i18n/{en,de}.ts` | Namensraum `newSession` (registriert in `src/web/i18n/index.ts`) |
