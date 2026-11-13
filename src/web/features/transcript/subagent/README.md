# src/web/features/transcript/subagent – Subagent-Verlauf (WP-69)

Inhalt des Seitenpanel-Tabs „Agent“: der ganze Verlauf eines Subagenten, nur lesend. Geladen als
Lazy-Chunk über den Slot `SubagentPanel` (`../slots.tsx`), geöffnet von der Agent-Karte über die
Shell-Anfrage `openSubagent`. Auftrag und Ergebnis: `docs/wp/WP-69.md`; Datenfluss:
`docs/architecture.md` §3.8.

| Datei | Inhalt |
| --- | --- |
| `SubagentPanel.tsx` | `SubagentPanel({sessionKey, agentId, title, subagentType})` (auch `default` für `React.lazy`): Kopf (Titel, Typ, „Läuft“/„Beendet“ mit Anzahl, „Aktualisieren“ nach dem Ende), Fehler mit „Erneut versuchen“, virtualisierte Liste (`role="region"`, `data-slot="subagent-list"`) mit denselben Zeilen wie das Transkript (`TranscriptItemView`, `StepGroupLine`, Galerie), kompakt/alle Schritte nach `transcriptView`, Hook-Läufe nach `hookDisplay`; folgt dem Ende, solange es sichtbar ist („Zu den neuesten“ sonst), „Frühere Einträge laden“ am Anfang. `TranscriptSettings.readOnly` blendet Stop und „Hintergrund“ aus |
| `SubagentPanel.test.tsx` | Polling (wächst, stoppt am Ende, bei Unmount und verborgenem Fenster), Fehler/Erneut, frühere Einträge; Panel mit Gruppen, blockiertem Hook, `readOnly`, „Alle Schritte“ |

Die Items liegen nicht im Store: sie kommen aus `../state/subagent-transcript.ts`
(`useSubagentTranscript`, Befehl `session.subagentTranscript`) und werden mit `../lib/subagent-pages.ts`
zusammengeführt. Offene Schrittgruppen unter einem eigenen Schlüssel je Agent (`../state/groups.ts`).
