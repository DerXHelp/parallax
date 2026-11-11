# src/web/features/tasks – Aufgaben (Phase 3)

Owner: **WP-55**. Auftrag: `docs/wp/WP-55.md` (Design: `docs/wp/WP-50.md`, ADR-149, ADR-150).

Task-Panel (Tab „Aufgaben“ des Seitenpanels, Slot `TasksPanel`: Hintergrund-Tasks mit Stop je
Task, `session.stopTask`) und die angeheftete Aufgabenleiste über dem Composer (Slot `TaskStrip`,
aus `SessionDetail.todos`).

| Pfad | Inhalt |
| --- | --- |
| `i18n/en.ts`, `i18n/de.ts` | Namespace `tasks` (Stub aus WP-50 Teil 2, statisch registriert in `src/web/i18n/index.ts`) |

Stand WP-50 Teil 2: nur der Namespace; die Slots zeigen die Platzhalter aus `shell/placeholders.tsx`.
