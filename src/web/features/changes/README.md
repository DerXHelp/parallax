# src/web/features/changes – Änderungen, Review, Git-Leiste (Ausbau 1)

Owner: **WP-113**. Auftrag: `docs/wp/WP-110.md` §3.1, §3.4, §3.5, §6 und §8; Entscheidungen ADR-252, ADR-253, ADR-254. Angelegt als
Gerüst in WP-110 (nur README und leerer Namensraum `changes`).

Tab „Änderungen“ des Seitenpanels (Slot `ChangesPanel`, Tab `changes` in `SIDE_PANEL_TABS`; nur bei einem Rechner mit
`HostState.features.git`, `useSessionFeature(sessionKey, 'git')` aus `@web/state/hosts`):
- Diff der Session gegen ihren Ausgangsstand (`git.diff`, Bereiche aus `GIT_DIFF_SCOPES`), Datei-Diff per
  `git.fileDiff`, Darstellung über `src/web/ui/diff-view.tsx`.
- Review-Kommentare an Zeilen (`review.add`/`review.update`/`review.remove`, Sync über die Ops `review.upsert` und
  `review.remove` in `SessionDetail.review`), „An Claude senden“ als eine Nachricht, danach `review.markSent`.
- Git-Leiste: Branch, ahead/behind, Commit, Branch anlegen/wechseln, Push (`git.*`).

Feature importiert keine anderen Features; Querverbindungen über `src/web/shell/requests.ts`.
