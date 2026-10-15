# src/server/app – Komposition (WP-20a, WP-20c)

Kompositionswurzel des Servers: der einzige Ort, der alle Server-Module zusammensetzt. `main.ts`
lädt Config, nimmt den Home-Lock (R2-05) und das Logging und ruft `startServer()`.
Start-Reihenfolge, Beenden und Backend-Wahl normativ in `docs/architecture.md` §3.3.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `compose.ts` | `startServer(options) → RunningServer`, `StartupError` (`exitCode`), `DEFAULT_FAKE_SPEED`, Typen `StartServerOptions`, `RunningServer` | Single-Instance je Home (5), Stores (3 bei neuerer `schemaVersion`), Backend `fake`/`sdk` (SDK nur hier dynamisch geladen: `import('../backend/sdkBackend')` + `loadAgentSdk()`), SessionManager + SyncHub + App, Shutdown-Rahmen + Signale vor `listen` (4 bei `EADDRINUSE`), Lockfile mit tatsächlichem Port, im Hintergrund Zugriffsprüfung des Homes (`logHomeAccess`) und „Profil testen“; nach einem Fehler dieselbe Aufräumfolge wie beim Beenden |
| `compose.test.ts` | – | In-Process (FakeBackend `speed: 0`, Port 0, Temp-Home, `exit`/Signale injiziert): Lockfile, `dist/web`, Shutdown, Home-Lock/Zugriffsprüfung, Exit-Codes 3/4/5, Aufräumen nach Fehlschlag |
| `bundle.test.ts` | – | esbuild wie `scripts/build-server.ts`: das Bundle importiert das Agent SDK nur dynamisch |

`StartServerOptions`: `config`, `webRoot` (null = keine statische UI), `logging` (wird als Letztes
geschlossen), `exit` (Default `process.exit`), `signals` (Default `process`, null = keine),
`fakeSpeed` (Default 1), `findRunning`, `homeLock` (von `main.ts`, Schritt nach dem Lockfile),
`homeAccess` (Default `logHomeAccess`, null = keine), `logger`. Shutdown-Schritte nach
`manager.shutdown()` (der auch `backend.dispose()` ruft): `http → stores → homeAccess → lock →
homeLock`. Der Prozess-Test des Einstiegs liegt in `src/server/main.integration.test.ts`
(tsx-Kindprozess, Launcher-Code → Cookie → WS → Permission → `server.shutdown`, Exit-Codes 3, 4, 5).
