# src/web/features/worktrees – Worktree-Sessions (Ausbau 1)

Owner: **WP-114**. Auftrag: `docs/wp/WP-110.md` §3.2, §3.3, §6 und §8; Ergebnis: `docs/wp/WP-114.md`; Entscheidungen
ADR-250, ADR-251. Gerüst aus WP-110 (README, leerer Namensraum `worktrees`).

Export für die Verdrahtung (WP-117): `WORKTREE_SLOTS` aus `index.ts` (`...WORKTREE_SLOTS` in `App.tsx`). Beide Körper
sind Lazy-Chunks.

| Pfad | Inhalt |
| --- | --- |
| `index.ts` | `WORKTREE_SLOTS` = `{ WorktreeNotice, WorktreeCleanup }`. Der Hinweis lädt seinen Chunk nur, solange `SessionSummary.worktreeSetup` gesetzt ist. Der Aufräum-Slot nimmt die Shell-Anfrage `worktree.cleanup {sessionKey, then}` an, aber nur für Sessions mit `worktree` auf einem Rechner mit `features.git` (sonst `false`: der Aufrufer archiviert bzw. entfernt wie bisher), und zeigt den Dialog |
| `WorktreeNotice.tsx` | Banner im Session-Bereich (`data-slot="worktree-notice"`, `data-state`): `creating` und `setup` (Spinner, beim Setup „Ausgabe ansehen“), `failed` mit Terminal (Exit-Code bzw. „abgebrochen“, „Ausgabe ansehen“, „Trotzdem starten“ = `session.resume`), `create-failed` (`failed` ohne Terminal: `git worktree add` schlug fehl, Ton Fehler, ohne Knöpfe). „Ausgabe ansehen“ öffnet den Terminal-Tab des Seitenpanels (`showSessionTerminal`/`openTerminalPanel`) und erscheint nur mit `terminalAvailable` |
| `WorktreeCleanup.tsx` | Dialog „Archivieren“/„Entfernen“ einer Worktree-Session: `worktree.inspect` beim Öffnen (ungesicherte Dateien, Commits nur auf dem Branch, gemergt in die Basis), drei Optionen (behalten / Worktree löschen, Branch behalten / beides löschen), Bestätigung per Kontrollkästchen, wenn offene Arbeit verloren ginge, Hinweis auf den Teardown-Befehl des Projekts. Ablauf mit Schritten: `session.close` (nur bei laufendem Prozess), `worktree.remove`, danach `session.setArchived` bzw. `removeSession`. `WORKTREE_DIRTY` aktualisiert die Prüfung und bietet „Trotzdem löschen“ (`force`), ein fehlgeschlagener Teardown (`GIT_FAILED {op: 'teardown'}`) „Ausgabe ansehen“ und „Trotzdem löschen“ (`skipTeardown`); andere Fehler im Dialog (`Alert`). Schließen ist während des Ablaufs gesperrt |
| `components/WorktreeIdentity.tsx` | „Worktree `<branch>` · Ports von–bis“ (`data-slot="worktree-identity"`) |
| `lib/cleanup.ts` | Reine Regeln: `wantsCleanup`, `defaultCleanupOption` (offen oder unbekannt → behalten; sauber → Worktree löschen, gemergt → beides), `workLost`/`losesWork`, `dirtyWork`, `teardownExit`, `needsClose` |
| `lib/ports.ts` | `WORKTREE_PORT_BLOCK` (10), `portRange(portBase)` |
| `i18n/{en,de}.ts` | Namensraum `worktrees` (`identity`, `notice`, `cleanup`) |

Tests: `WorktreeNotice.test.tsx`, `WorktreeCleanup.test.tsx`, `lib/cleanup.test.ts`, `i18n/i18n.test.ts` (gleiche
Schlüssel und Platzhalter, keine Literale in `aria-label`/`title`/`placeholder`/`alt`). Host-Befehle über `onCommand`
von `startNewSessionDemo`.

Außerhalb dieses Ordners (ebenfalls WP-114): Schalter „In eigenem Worktree“ in `shell/NewSessionForm.tsx` mit
`shell/new-session/{WorktreeFields.tsx,use-worktree-choice.ts,use-repo-worktrees.ts,worktree-lib.ts,project-roots.ts}`,
Abschnitt „Projekte“ in `features/preferences/sections/ProjectsSection.tsx`, Sendesperre während des Setups und
`composerText {asPaste}` in `features/composer/Composer.tsx`.

Feature importiert keine anderen Features; Querverbindungen über `src/web/shell/requests.ts`.
