# src/server/app – Komposition (WP-20a)

Kompositionswurzel des Servers: der einzige Ort, der alle Server-Module zusammensetzt. `main.ts`
lädt nur Config und Logging und ruft `startServer()`. Start-Reihenfolge, Beenden und
Backend-Wahl normativ in `docs/architecture.md` §3.3.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `compose.ts` | `startServer(options) → RunningServer`, `StartupError` (`exitCode`), `DEFAULT_FAKE_SPEED`, Typen `StartServerOptions`, `RunningServer` | Single-Instance je Home (5), Stores (3 bei neuerer `schemaVersion`), Backend `fake`/`sdk` (SDK nur hier dynamisch importiert), SessionManager + SyncHub + App, Shutdown-Rahmen + Signale vor `listen` (4 bei `EADDRINUSE`), Lockfile mit tatsächlichem Port, „Profil testen“ im Hintergrund; nach einem Fehler dieselbe Aufräumfolge wie beim Beenden |
| `compose.test.ts` | – | In-Process (FakeBackend `speed: 0`, Port 0, Temp-Home, `exit`/Signale injiziert): Lockfile, `dist/web`, Shutdown, Exit-Codes 3/4/5, Aufräumen nach Fehlschlag |

`StartServerOptions`: `config`, `webRoot` (null = keine statische UI), `logging` (wird als Letztes
geschlossen), `exit` (Default `process.exit`), `signals` (Default `process`, null = keine),
`fakeSpeed` (Default 1), `findRunning`, `logger`. Der Prozess-Test des Einstiegs liegt in
`src/server/main.integration.test.ts` (tsx-Kindprozess, Launcher-Code → Cookie → WS → Permission →
`server.shutdown`, Exit-Codes 3 und 4).
