# src/server/git – Git-Dienst (Ausbau 1)

Git-Befehle der Sessions und Worktrees (`docs/wp/WP-110.md` §3.1–3.5; ADR-250, ADR-252, ADR-253).
Angelegt als Gerüst in WP-110, gefüllt von WP-111 (`docs/wp/WP-111.md`).

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `runner.ts` | `createGitRunner()` – der einzige Weg zu `git`: absoluter Pfad (`resolveExecutable` auf dem PATH der Session), `runFile` mit Argument-Array, gehärtete Lesezugriffe, Zeit- und Ausgabegrenzen, Fehler `GIT_NOT_FOUND`/`NOT_A_GIT_REPO`/`GIT_FAILED` | WP-111 |
| `parse.ts` | Reine Parser der `-z`-Ausgaben (Status v2, Raw/Numstat, Worktree-Liste, Patch, Push-Fehlergrund), Host-Schreibweise der Ordner | WP-111 |
| `repo.ts` | Operationen auf einem Repository: Status, Diffs (Bereiche, Untracked als hinzugefügt), Commit, Branches, Push, Worktrees, `info/exclude`, `.worktreeinclude` | WP-111 |
| `commands.ts` | `createGitCommands(deps)` – Host-Befehle `git.status`, `git.diff`, `git.fileDiff`, `git.commit`, `git.branchCreate`, `git.branchSwitch`, `git.push`, `worktree.list`, `worktree.inspect`, `worktree.remove`; `sessionDiffBase` (ADR-253). Ohne `deps` (Gerüst in `compose.ts`) `NOT_IMPLEMENTED` | WP-110 (Gerüst), WP-111 |
| `testRepo.ts` | Nur Tests: echte Repositories unter dem Test-Home, git ohne globale/System-Konfiguration | WP-111 |

Regeln (ADR-252): `git` nur als absoluter Pfad, jeder Aufruf über `runFile` mit Argument-Array, Pfade nach `--`,
`GIT_TERMINAL_PROMPT=0`, `LANGUAGE=en`, ohne `GIT_DIR`/`GIT_WORK_TREE`/…; lesende Aufrufe mit
`-c core.fsmonitor=false` und `GIT_OPTIONAL_LOCKS=0`; Zeitgrenzen 10 s (lesen) bzw. 120 s (schreiben), Ausgabegrenzen
und `LIMITS` (`gitPatchBytes`, `gitFilesMax`). Ausgaben von git werden nie protokolliert, Meldungen in Fehlern ohne
Zugangsdaten.

Verdrahtung: Die Session-Engine leitet die Befehle selbst hierher (`sessions/commands.ts` →
`sessions/worktrees.ts` `engineGitCommands`, mit Einträgen, Umgebung und Session-Dateien). Der Aufruf ohne `deps` in
`app/compose.ts` ist unerreichbar und entfällt in WP-117.
