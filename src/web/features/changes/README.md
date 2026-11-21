# src/web/features/changes – Änderungen, Review, Git-Leiste (Ausbau 1)

Owner: **WP-113**. Auftrag: `docs/wp/WP-110.md` §3.4, §3.5, §6 und §8; Entscheidungen ADR-252, ADR-253, ADR-254.
Ergebnis und Entscheidungen: `docs/wp/WP-113.md`.

Tab „Änderungen“ des Seitenpanels (Slot `ChangesPanel`, Tab `changes` in `SIDE_PANEL_TABS`). Nur bei einem Rechner mit
`HostState.features.git` (`useSessionFeature(sessionKey, 'git')`); sonst zeigt das Panel einen Hinweis. Alle Befehle
gehen über `sendCommand(sessionKey, …)` an den Rechner der Session (auch entfernte Rechner).

## Export

| Export | Datei | Zweck |
|---|---|---|
| `CHANGES_SLOTS` | `index.ts` | `Pick<FeatureSlots, 'ChangesPanel'>`, lädt `ChangesPanel.tsx` per `lazy()`; `index.ts` importiert nur React |
| `ChangesPanel` (auch default) | `ChangesPanel.tsx` | `({sessionKey}) => …` – der Tab |

Verdrahtung (Koordinator, `src/web/App.tsx`): `ChangesPanel: bounded(CHANGES_SLOTS.ChangesPanel, bySessionKey)`.

## Aufbau

- `ChangesPanel.tsx` – Kopf (Branch-Zeile, Git-Aktionen, Bereich und Filter), Dateiliste mit Diffs, weitere
  Kommentare, unten „An Claude senden“ und das Commit-Feld. Fehler der Aktionen zeigt das Panel (`Alert role="alert"`).
- `components/` – `ChangesHeader` (Branch, Upstream, ahead/behind, Aktualisieren, Bereich, Filter „Nur Dateien dieser
  Session“), `FileList` (Status, +/−, Auswahl für den Commit, „Datei öffnen“), `FileDiff` (Diff je Datei mit
  Zeilennummern, „+“, Tastatur-Cursor, virtualisiert ab 300 Zeilen), `CommentEditor`, `CommentNote`, `SendBar`,
  `GitBar` (Commit, Push), `BranchMenu`, `GitError` (Fehler, „Im Terminal pushen“), `StatusMark`.
- `lib/` (rein, getestet in `lib.test.ts`) – `patch.ts` (Unified Diff → Zeilen mit Nummern), `anchor.ts` (Anker aus
  markierten Zeilen, Neuverankerung über das Zitat), `feedback.ts` (nummerierte Liste für Claude).
- `state/` – `git.ts` (Befehle, `useChangesData`, `useFileDiff`), `review.ts` (Kommentare aus `SessionDetail.review`,
  Neuverankerung an den Server melden), `view.ts` (Bereich, Filter, aufgeklappte und ausgewählte Dateien je Session),
  `draft.ts` (ein offener Kommentar-Editor je Session).
- `testing.ts` – Test-Host mit Fake-Git und Fake-Review über `onCommand` (nur für Tests).

## Bedienung

- Kommentar: Zeile überfahren → „+“, oder Zeilen mit der Maus markieren bzw. im Diff mit Pfeiltasten (Umschalt für
  einen Bereich) wählen → `C` (oder Enter). Enter speichert, Umschalt+Enter neue Zeile, Esc bricht ab.
- Zustände: offen, gesendet (eingeklappt, aufklappbar), veraltet (Zitat nicht mehr im Diff, bleibt sichtbar).
- „An Claude senden (n)“ legt die offenen Kommentare als Paste-Chip in den Composer der Session
  (`requestShell({kind:'composerText', asPaste:true})`), danach `review.markSent`.
- Aktualisiert nach jedem Turn-Ende, bei einem Branch-Wechsel, beim Öffnen des Tabs und nach jeder Aktion.

## Test-Anker

`data-slot`: `changes-panel`, `changes-files`, `changes-file`, `changes-diff`, `changes-diff-lines`, `review-editor`,
`review-comment` (`data-state`), `review-comment-sent`, `changes-send`, `changes-commit`, `changes-error`.
`data-action`: `changes-refresh`, `changes-open-file`, `add-review-comment`, `save-review-comment`,
`remove-review-comment`, `send-review`, `git-commit`, `git-push`, `branch-menu`, `branch-create`,
`branch-create-switch`, `branch-switch`, `push-in-terminal`. Das Panel trägt `data-changes-panel=<sessionKey>`.

Feature importiert keine anderen Features; Querverbindungen über `src/web/shell/requests.ts` (`composerText`,
`openFile`, `sidePanel`).
