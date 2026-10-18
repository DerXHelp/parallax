# src/server/sessions/lib – Helfer der Session-Engine (WP-13b)

Kleine, gekapselte Helfer des SessionManagers („Helfer nur in `*/lib`“). Owner: WP-13b.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `serial.ts` | `createSerial()` → `Serial` (`run`, `pending`, `idle`) | Lifecycle-Lock je Eintrag: start/close/resume/rename (ruhend)/Auto-Retry strikt nacheinander, ein Fehler blockiert nichts |
| `timers.ts` | `Timers`, `TimerHandle`, `realTimers`, `createManualTimers()` → `ManualTimers` (`advance`, `runNext`, `pending`, `elapsed`) | Timer-Seam aller Engine-Verzögerungen (Retry, Context, Host-State, Shutdown-Obergrenze, Schlaf); echte Timer `unref()`; manuelle Uhr für Tests (0 ms → nächste echte Makrotask, sonst nur per `advance`) |
| `gitBranch.ts` | `readGitBranch(cwd, env, deps?)`, `GIT_BRANCH_TIMEOUT_MS` | `git rev-parse --abbrev-ref HEAD` am Turn-Ende, scheitert das (frisches Repo ohne Commit) `git branch --show-current` (V3-11); `git` nur über `resolveExecutable` (R1-04, nie nackt), kein Git → `null` |

Tests liegen daneben (`*.test.ts`).
