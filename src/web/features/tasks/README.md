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
| `lib/rows.ts` | rein: `buildTaskRows` (Hintergrund-Tasks + Tasks der Tool-Calls + `task_notification`, je `taskId` eine Zeile; „beendet“ gewinnt), `visibleTaskRows` (beendete 10 min), `canStopTask` + Schalter `TASK_STOP_BASH`, `todoProgress` |
| `state/tasks.ts` | `useTaskRows` (rendert nur bei Änderungen an Task-Items/Hintergrundliste neu), `useTodos`, `stopTask` (Fehler als Notice, `TASK_NOT_FOUND` still), `stopTasks` (nacheinander) |
| `state/strip.ts` | Auf/Zu der Leiste je Session in localStorage (`storageKey('tasks','strip',…)`, Fehler geschluckt) |
| `components/` | `TaskRowView` (Art, Beschreibung, Laufzeit über `useNow`, Tokens/Tool-Aufrufe, Zusammenfassung, Ausgabedatei als `FileLink`, Stop), `TodoItems` (Liste mit Status-Icons) |
| `testing.ts` | Fixtures + FakeHost-Szenario (Tests, Playground) |
| `i18n/en.ts`, `i18n/de.ts` | Namespace `tasks` (statisch registriert in `src/web/i18n/index.ts`) |

## Regeln

- Stop im Composer beendet nur den Turn (F4); Hintergrund-Agents stoppt man hier oder in der
  Agent-Karte des Transkripts.
- Ambient-Tasks (keine Nutzeraktivität) erscheinen nie.
- Keine Imports aus anderen Features; Dateiverweise nur über den Slot `FileLink`, die Leiste öffnet
  das Panel über `requestShell({ kind: 'sidePanel', sessionKey, tab: 'tasks' })`.
