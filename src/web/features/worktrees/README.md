# src/web/features/worktrees – Worktree-Sessions (Ausbau 1)

Owner: **WP-114**. Auftrag: `docs/wp/WP-110.md` §3.2, §3.3, §6 und §8; Entscheidungen ADR-250, ADR-251. Angelegt als Gerüst in
WP-110 (nur README und leerer Namensraum `worktrees`).

- Slot `WorktreeNotice` (im Session-Bereich unter den Pane-Bannern): Branch, Basis und Zustand des Setups
  (`SessionSummary.worktreeSetup`: `creating`, `setup`, `failed` mit Exit-Code und Terminal).
- Slot `WorktreeCleanup` (fensterweit): behandelt die Shell-Anfrage `worktree.cleanup` (`then: 'archive' | 'remove'`),
  prüft per `worktree.inspect` (ungesicherte Dateien, nicht gepushte Commits, Branch gemergt) und räumt per
  `worktree.remove` auf.
- Einstellungen je Projekt (Setup-/Teardown-Befehl, Shell, Port-Block, Worktree als Standard) im Bereich
  `projects` der Einstellungen (`features/preferences/sections/ProjectsSection.tsx`, Platzhalter aus WP-110).

Feature importiert keine anderen Features; Querverbindungen über `src/web/shell/requests.ts`.
