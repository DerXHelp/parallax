# src/server/git – Git-Dienst (Ausbau 1)

Git-Befehle der Sessions und Worktrees (`docs/wp/WP-110.md` §3.1–3.5; ADR-250, ADR-252, ADR-253).
Angelegt als Gerüst in WP-110, gefüllt von WP-111.

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `commands.ts` | `createGitCommands()` – Host-Befehle `git.status`, `git.diff`, `git.fileDiff`, `git.commit`, `git.branchCreate`, `git.branchSwitch`, `git.push`, `worktree.list`, `worktree.inspect`, `worktree.remove`; bis WP-111 ein Stub (NOT_IMPLEMENTED) | WP-110 (Gerüst), WP-111 |

Regeln (ADR-252): `git` nur als absoluter Pfad (`resolveExecutable`), jeder Aufruf über `runFile` mit
Argument-Array, Pfade nach `--`, `GIT_TERMINAL_PROMPT=0`; lesende Aufrufe mit `-c core.fsmonitor=false`
und `GIT_OPTIONAL_LOCKS=0`; Zeitgrenzen und Ausgabegrenzen aus `LIMITS` (`gitPatchBytes`, `gitFilesMax`).
Verdrahtet in `app/compose.ts` (Koordinator).
