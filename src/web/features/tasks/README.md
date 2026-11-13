# src/web/features/tasks – Aufgaben (Phase 3)

Owner: **WP-55**. Auftrag und Ergebnis: `docs/wp/WP-55.md` (Design: `docs/wp/WP-50.md`, ADR-149,
ADR-150).

Task-Panel (Tab „Aufgaben“ des Seitenpanels, Slot `TasksPanel`: Hintergrund-Tasks mit Stop je
Task, „Alle stoppen“, `session.stopTask`) und die angeheftete Aufgabenleiste über dem Composer
(Slot `TaskStrip`, aus `SessionDetail.todos`).

## Exporte

| Datei | Export | Zweck |
| --- | --- | --- |
| `index.ts` | `TASKS_SLOTS` (`TasksPanel`, `TaskStrip`) | WP-60 spreizt sie in `APP_SLOTS` (App.tsx); beide Lazy-Chunks, der Strip-Slot prüft vorher billig auf offene Todos |
| `TasksPanel.tsx` | `TasksPanel` (`{ sessionKey }`, default) | Panel-Inhalt (Tests, Playground) |
| `TaskStrip.tsx` | `TaskStrip` (`{ sessionKey }`, default) | Aufgabenleiste (Tests, Playground) |
| `playground.tsx` | `demos`, `slots` | Playground `#playground=tasks/<id>` |

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `lib/rows.ts` | rein, Panel-Helfer: `visibleTaskRows` (beendete 10 min), `canStopTask` + Schalter `TASK_STOP_BASH`, `finishedDuration` – nur im Panel-Chunk. Das Zeilenmodell (`buildTaskRows`, `TaskRow`, `runningTaskCount`) liegt seit WP-71 in `@shared/tasks` (vorher CR3-02 `@web/lib/task-rows`, dort bleibt der Selektor `selectTaskSources`), weil Kopfzeile und Sidebar (`SessionSummary.runningTasks` des Servers) dieselbe Zählung nutzen (ohne Ambient-Tasks, ohne Vordergrund-Shells von Subagenten – WP61-06, `pending`-Tool-Calls nicht laufend – CR3-07) |
| `lib/todo-progress.ts` | rein: `todoProgress` (erledigt/gesamt, aktiver Eintrag, offen) – als einziges Modul statisch im Start-Chunk (`index.ts`, R5W-01) |
| `state/tasks.ts` | `useTaskRows` (rendert nur bei Änderungen an Task-Items/Hintergrundliste neu), `stopTask` (Fehler als Notice, `TASK_NOT_FOUND` still), `stopTasks` (nacheinander) – nur im Panel-Chunk |
| `state/todos.ts` | `useTodos` (Leiste und Panel; zieht `rows.ts` nicht in den Leisten-Chunk) |
| `state/strip.ts` | Auf/Zu der Leiste je Session in localStorage (`storageKey('tasks','strip',…)`, Fehler geschluckt) |
| `components/` | `TaskRowView` (Art, Beschreibung, Laufzeit über `useNow`, Tokens/Tool-Aufrufe, Zusammenfassung, Ausgabedatei als `FileLink`, Stop), `TodoItems` (Liste mit Status-Icons) |
| `testing.ts` | Fixtures + FakeHost-Szenario (Tests, Playground) |
| `i18n/en.ts`, `i18n/de.ts` | Namespace `tasks` (registriert in `src/web/i18n/dictionaries.ts` bzw. `dictionary.de.ts`, ADR-153) |

## Regeln

- Stop im Composer beendet nur den Turn (F4); Hintergrund-Agents stoppt man hier oder in der
  Agent-Karte des Transkripts.
- Ambient-Tasks (keine Nutzeraktivität) erscheinen nie.
- Keine Imports aus anderen Features; Dateiverweise nur über den Slot `FileLink`, die Leiste öffnet
  das Panel über `requestShell({ kind: 'sidePanel', sessionKey, tab: 'tasks' })`.
