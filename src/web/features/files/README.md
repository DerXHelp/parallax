# src/web/features/files – Dateien (Phase 3)

Owner: **WP-54**. Auftrag: `docs/wp/WP-54.md` (Design: `docs/wp/WP-50.md`, ADR-141 … ADR-146, ADR-150).

Datei-Viewer (Tab „Datei“ des Seitenpanels, Slot `FilePanel`), klickbare Dateiverweise mit Aktionen
(Slot `FileLink`: Viewer, Editor, Explorer, Standardprogramm) und „Dateien dieser Session“ (Slot
`FilesPanel`) über die Host-Befehle `file.*`/`files.*` und `GET /api/file`.

| Pfad | Inhalt |
| --- | --- |
| `i18n/en.ts`, `i18n/de.ts` | Namespace `files` (Stub aus WP-50 Teil 2, statisch registriert in `src/web/i18n/index.ts`) |

Stand WP-50 Teil 2: nur der Namespace; die Slots zeigen die Platzhalter aus `shell/placeholders.tsx`.
