# WP-20a – Server-Verdrahtung

> Welle 2, Teil von WP-20 (20a Server, 20b Web parallel, danach 20c E2E in Edge). Worktree
> `.worktrees/wp-20a`, Branch `wp/20a`, Basis `main` = `2299eb0`. Kein Live-`claude`.

## Auftrag (sinngemäß)

- **Ziel:** Alle gemergten Bausteine im Server-Einstieg zusammensetzen, sodass `pnpm dev`
  (FakeBackend) und `pnpm start` (Launcher → `dist/server.js`) funktionieren:
  `src/server/main.ts` + Kompositionsmodul (`src/server/app/compose.ts`) mit Config
  (`loadConfig`, Flags/Env), Logging, Stores (Registry, Settings, Decisions, Transcripts, Blobs,
  `openProcessStore`; `StoreVersionTooNewError` → Exit 3), Auth, `createApp`,
  `createSyncHub({source, instance})` inkl. `authorizeUpgrade`, Claude-Integration (Profil
  „Standard“, `resolveClaude`), Backend nach `--backend` (`fake` mit interaktivem Dev-Szenario,
  `sdk` mit dynamisch geladenem SDK), `createSessionManager` mit `attachPublisher` vor `start()`,
  `warnings.onChange`/`checkProfile` → `publishHostState`, `listen` (EADDRINUSE → Exit 4),
  `writeServerLock` mit tatsächlichem Port + `auth.launcherToken`, `createServerShutdown`
  (Reihenfolge `manager.shutdown()` → `app.close()` → Stores → Lock → `backend.dispose()`),
  Signale, `onShutdownRequested` → `shutdown.stop('command')`, statische Auslieferung von
  `dist/web` im Prod-Modus.
- **Backend-Default:** Dev = fake, Prod (Launcher) = sdk; explizite Umschaltung für Smoke-/E2E-Tests
  des echten Startpfads ohne `claude` (z. B. `PARALLAX_BACKEND=fake`), im Launcher höchstens minimal.
- **Tests:** Server-Integrationstest als Kindprozess (`--backend=fake`, Temp-Home, Port 0): Health,
  Code über den Launcher-Endpunkt → Cookie → WS `hello` → Session → Permission → Antwort → `idle`;
  `server.shutdown` → Prozess endet, Lock weg, keine Kindprozesse; dazu Exit 3 und 4.
- **Doku:** README „Installation und Start“/„Starten“, `CLAUDE.md`-Befehle, architecture §5.1 (h)
  und neuer Abschnitt „Komposition/Start-Reihenfolge“, `src/server/README.md`, dieses Dokument.
- **Besitz-Pfade:** `src/server/{main,bootstrap}.ts`, `src/server/app/**`, zugehörige Tests,
  minimal `src/server/launcher/**` (Backend-Umschaltung), README (Start-Abschnitte), CLAUDE.md
  (Befehle), architecture (§5.1 (h) + Kompositions-Abschnitt), `src/server/README.md`, dieses
  Dokument. **Abnahme:** `pnpm check` 2×, `pnpm build`, Integrationstest grün; `pnpm dev` und
  `pnpm start` (`PARALLAX_BACKEND=fake`, Temp-Home, Edge) manuell; Diff nur in Besitz-Pfaden; keine
  übrig gebliebenen Prozesse. Kein `pnpm dev:live`, kein echter `--backend=sdk`-Start.

---

## Ergebnis

**Status:** fertig. Keine Contract-, Port- oder Script-Änderung; `package.json` zeigt `start`
bereits auf den Launcher (`0f553bd`).

### Dateien

| Datei | Inhalt |
| --- | --- |
| `src/server/main.ts` | Einstieg: `loadConfig` (ConfigError → stderr, Exit 1) → `initLogging` (Konsole nur im Dev-Modus oder an einem TTY, `tty.isatty(1)`) → `startServer()`; ein `StartupError` (bzw. unerwarteter Fehler) wird geloggt, die Log-Datei geschlossen und die Ursache als **letzte** Zeile auf stderr geschrieben, dann `exit(code)` nach dem Flush. `webRoot` = `dist/web` neben dem Bundle, im Dev-Modus keiner. |
| `src/server/app/compose.ts` | Kompositionswurzel `startServer(options) → RunningServer` (`port`, `origin`, `app`, `auth`, `manager`, `backend`, `lock`, `shutdown`, `instance`, `config`), `StartupError(exitCode)`, `DEFAULT_FAKE_SPEED` (1). Injizierbar für Tests: `exit`, `signals` (null = keine), `fakeSpeed`, `findRunning`, `logger`, `logging`. |
| `src/server/app/compose.test.ts` | In-Process: Lockfile mit tatsächlichem Port/Token/PID, Health, `dist/web` (`GET /`), Host-State, Shutdown (`exit(0)`, App geschlossen, Lock weg, Befehle danach `SERVER_SHUTTING_DOWN`), Exit 5 (zweiter Server auf demselben Home), Exit 3 (`processes.json` neuer, Datei unverändert), Exit 4 + vollständiges Aufräumen (ein neuer Start auf demselben Home klappt). |
| `src/server/main.integration.test.ts` | Prozess-Test über tsx wie `pnpm dev:server` (siehe „Tests“). |
| `src/server/app/README.md` | Ordner-README. |
| `src/server/launcher/args.ts` (+ Test) | nur Usage-Text: `--backend` nennt `PARALLAX_BACKEND`; Test, dass `PARALLAX_BACKEND=fake` als `--backend=fake` an den Server geht (Flag gewinnt). |
| `src/server/bootstrap.ts` (+ Test) | **gelöscht** (WP-00-Stub, WP-10 Follow-up 4). |

### Start-Reihenfolge (normativ: `docs/architecture.md` §3.3)

1. `loadConfig` → 2. `initLogging` → 3. Single-Instance `findRunningServer({home})` (läuft → **5**)
→ 4. `createServerInstance`, Stores Registry → Settings → `processes.json` → Auth-Secret → Blobs,
Decisions, Transkripte (eine `createStoreWarnings()`-Instanz; neuere `schemaVersion` → **3**) →
5. Backend + Claude-Integration (`fake`: `createFakeBackend({speed: 1})` +
`createFakeClaudeIntegration()`; `sdk`: `await import('../backend/sdkBackend')` +
`createClaudeIntegration({appVersion})`) → 6. `createSessionManager` → `createSyncHub({source:
manager, instance})` → `attachPublisher` → `warnings.onChange → publishHostState` →
`await manager.start()` → 7. `createApp({… hub, webRoot})` (die App ruft `hub.attach` mit
`authorizeUpgrade` selbst auf) → 8. `createServerShutdown` + `installSignalHandlers()` **vor**
`listen` → 9. `listen` (`EADDRINUSE` → **4**) → 10. `writeServerLock` → 11. `checkProfile(default)`
im Hintergrund → `publishHostState`.

**Beenden:** `manager.shutdown()` (über `stopSessions`, 5 s Gnadenfrist → `killChildProcessTrees`)
→ `http` (`app.close()`, WS 4503) → `stores` (alle `close()`) → `lock` (`release()`, nur das eigene)
→ `backend` (`dispose()`, idempotent; die Engine ruft es schon in `manager.shutdown()`) → Log-Datei
schließen (im `exit`-Wrapper, damit „shutdown: done“ noch in der Datei landet) → `exit(code)`.
Nach einem Fehler ab Schritt 5 läuft dieselbe Folge ohne `exit`, dann wirft `startServer` den
`StartupError`.

### Backend-Umschaltung

- Ohne `--backend`: Dev → `fake`, sonst `sdk` (config.ts, WP-10). Der Launcher löst Backend, Home
  und Port mit `loadConfig` auf und übergibt `--backend=…` explizit (`serverArgsFor`) –
  `PARALLAX_BACKEND=fake pnpm start` (bzw. `--backend=fake`) fährt also den echten Prod-Pfad
  (Launcher, `dist/server.js`, Edge, Lockfile, Code-Austausch) mit FakeBackend. Dafür war im
  Launcher **kein Code** nötig, nur Usage-Text und Test.
- `fake` nimmt auch die Fake-Claude-Integration (alle Profile `ok`/`logged_in`, kein Spawn): mit der
  echten Integration würde schon „Profil testen“ `claude --version`/`auth status` starten und ohne
  installiertes `claude` jede Session mit `CLAUDE_NOT_FOUND` scheitern.

### Entscheidungen

1. **Eigenes Kompositionsmodul `app/compose.ts` statt `bootstrap.ts`:** `main.ts` bleibt ein dünner
   Prozess-Rahmen (Exit-Codes, stderr), die Komposition ist in-process testbar (`exit`/Signale
   injiziert). `bootstrap.ts` ist gelöscht.
2. **Shutdown-Rahmen vor `listen`:** Ein Signal oder `server.shutdown` findet ihn immer; der Lock-
   Schritt greift erst, wenn das Lockfile geschrieben ist. Das Log wird im `exit`-Wrapper
   geschlossen (≤ 2 s), nicht als Schritt.
3. **Single-Instance-Vorprüfung (Exit 5) vor den Stores** (WP-21 „optional“): verhindert einen
   zweiten Schreiber auf demselben Home; ein verwaistes Lockfile (Absturz, `tsx watch`-Neustart)
   zählt nicht (Health-Ping, Log „stale lock file found“).

### Tests

- `main.integration.test.ts` (3 Tests): `node <repo>/node_modules/tsx/dist/cli.mjs --tsconfig
  src/server/tsconfig.json src/server/main.ts --backend=fake --port=0 --home=<tmp>` als Kindprozess
  (`spawnHidden`, Pipes). Warten wie der Launcher (Lockfile + Health gleiche Instanz) → Health →
  `requestLauncherCode` (Bearer aus dem Lockfile) → `POST /api/auth` → Cookie → WS `hello` (gleiche
  `serverInstanceId`) → `host.state` (`backend: 'fake'`, `setupRequired: false`) →
  `session.create` mit `fake:permission …` in einem Temp-cwd → Abo → Permission aus Snapshot/Ops →
  `decision.respond allow` → `summary.upsert` `idle` mit `lastTurn`, ohne offene Permission →
  `server.shutdown` (ack) → WS-Close 4503 → Exit 0 → Lockfile `missing`, Server-PID tot, keine
  Kindprozesse (`childProcesses(pid)` nach dem Exit, jünger als der Start) → Log-Datei enthält
  „server listening“ und „shutdown: done“. Exit 3 (`sessions.json` mit `schemaVersion` 99: letzte
  stderr-Zeile „sessions.json was written by a newer Parallax“, Datei byte-gleich, kein Lockfile),
  Exit 4 (belegter Port: „EADDRINUSE“ auf stderr, kein Lockfile). tsx reicht den Exit-Code des
  Servers durch; der Server läuft als Kind von tsx (`lock.pid ≠ child.pid`). ≈ 35 s.
- `app/compose.test.ts` (4 Tests, ≈ 10 s) siehe oben; `launcher/args.test.ts` +1 Test.
- Unter Vitest erbt der Kindprozess `VITEST` → Hub und Transkript-Store validieren mit `throw`.

### Manuelle Abnahme (kein Live-`claude`)

- **`pnpm dev`:** Server (`tsx watch`, 4712, `.parallax-dev`) + Vite (5173) starten ohne Fehler;
  `GET http://127.0.0.1:5173/api/health` über den Proxy 200, `GET /` 200; Dev-Login-URL im Log.
  Ablauf über den Vite-Proxy mit einem Skript im Scratch-Ordner (Code über den Launcher-Endpunkt,
  `POST /api/auth` mit Origin 5173, Cookie `parallax_4712`, WS `ws://127.0.0.1:5173/api/ws`):
  `host.state` (`fake`, `dev: true`), `session.create` → `idle`. Ein `tsx watch`-Neustart (Datei
  berührt) startet eine neue Instanz („stale lock file found“, neue `serverInstanceId`).
  `server.shutdown` → Ack `{sessionsStopped: 1}`, Close 4503, „shutdown: done“, Lockfile weg; danach
  den `pnpm dev`-Prozessbaum beendet (`tsx watch` und Vite laufen nach „Server beenden“ weiter).
- **`pnpm start`** mit `PARALLAX_BACKEND=fake`, `PARALLAX_HOME=<scratch>\home-start`,
  `PARALLAX_PORT=4791`: Build aktuell (kein Rebuild), „Starting the Parallax server in the
  background…“, „Parallax runs on http://127.0.0.1:4791 (PID …)“, Launcher-Exit 0; `node.exe
  dist\server.js` läuft versteckt, `server.out.log` leer (keine Konsole), `parallax.*.log` mit
  „server listening“; Edge-App-Fenster mit Titel „Parallax“ (eigenes Profil im Temp-Home). Danach
  über das Skript: Session → `idle`, `server.shutdown` → Close 4503, Server beendet, Lockfile weg;
  nur den eigenen Edge-Prozessbaum (`--user-data-dir=<Temp-Home>\edge`) beendet. Keine Prozesse mit
  `wp-20a`/Temp-Home im Befehl übrig, Ports 4712/5173/4791 frei.

### Abweichungen und bekannte Lücken

1. **SDK im Bundle nicht wirklich lazy:** `compose.ts` lädt `backend/sdkBackend.ts` per
   `await import()`. Unter tsx (`pnpm dev`) ist das lazy; esbuild (ein Bundle, `packages:
   'external'`, ohne `splitting`) hebt aber das statische `import { query } from
   '@anthropic-ai/claude-agent-sdk'` aus `sdkBackend.ts` an den Anfang von `dist/server.js` – das
   SDK-Modul wird im Prod-Bundle immer geladen (≈ 0,5 s, kein Prozessstart, kein Funktionsfehler).
   Abhilfe (fremde Pfade): `scripts/build-server.ts` mit `splitting: true` + `outdir` (Chunk für das
   SdkBackend; Launcher-Banner-Prüfung bleibt auf `dist/server.js`) **oder** in `sdkBackend.ts` das
   SDK in `createSdkBackend` dynamisch laden (13c).
2. **`pnpm start -- --port=4800` scheitert:** pnpm 12 reicht `--` wörtlich weiter, `loadConfig`
   (`parseArgs`, keine Positionals) meldet „Unexpected argument“. `pnpm start --port=4800` (ohne
   `--`) funktioniert; README entsprechend. Fix im Launcher (`args.ts`: ein `--` überspringen) und
   WP-21.md korrigieren – nicht für die Verdrahtung nötig, daher nur gemeldet.
3. **Geerbte Pipe-Handles:** Der detached gestartete Server und Edge erben die stdout/stderr-Handles
   des Launchers (libuv vererbt alle vererbbaren Handles). Wer den Launcher mit Pipes startet und auf
   deren Ende wartet, wartet bis Server **und** Edge beendet sind (hier 424 s statt ≈ 10 s); auf
   `exit` des Launcher-Prozesses warten. Im Konsolenfenster/Doppelklick unkritisch.
4. **SDK-Pfad nur typgeprüft und gebündelt**, nicht gestartet (kein Live-`claude`): echte
   Integration, `checkProfile` beim Start, Verlaufs-Worker – WP-22.
5. **Dev-Modus:** „Server beenden“ beendet nur den Server; `tsx watch` wartet auf die nächste
   Änderung, Vite läuft weiter (README).
6. Ungültige Optionen enden mit Exit 1 (`SERVER_EXIT_CODES` kennt keinen eigenen Usage-Code; der
   Launcher prüft die Optionen ohnehin vorher mit derselben `loadConfig`).
7. `HostState.sdkVersion`/`sdkClaudeCodeVersion` = `unknown`, falls das SDK-Manifest nicht lesbar ist.
8. Der Hub loggt Verbindungen nicht (Info-Level); ob ein Edge-Fenster verbunden ist, sieht man im
   Prod-Log nicht – nur abgelehnte Requests (`request rejected`, warn).

### Wünsche an den Koordinator

- `CLAUDE.md` Ownership-Zeile `src/server/{main,bootstrap}.ts` → `src/server/main.ts`,
  `src/server/app/` (WP-20); `bootstrap.ts` existiert nicht mehr. `docs/architecture.md` §2.1
  entsprechend, falls dort genannt.
- `docs/progress.md` Sammelliste: Server-Punkte (`main.ts`, Backend, Engine-Verdrahtung, Doku §5.1
  (h)) erledigt; „Bekannt: pnpm start endet nach 30 s“ entfällt.
- Lücke 1 (Bundle-Splitting oder Lazy-Import im SdkBackend) und Lücke 2 (`--` im Launcher) als
  kleine Folgeaufträge.
- Optional: `PARALLAX_FAKE_SPEED` (config.ts, WP-10) für schnellere E2E-Läufe; heute fest 1.

### Hinweise für WP-20c (E2E in Edge)

- **Server für Playwright:** nach `pnpm build` `node dist/server.js --backend=fake --port=0
  --home=<tmp>` (oder der Launcher mit `PARALLAX_BACKEND=fake PARALLAX_HOME=<tmp> PARALLAX_PORT=0
  … --print-url`, die URL steht in „Open this address within 60 seconds …: <url>“; auf das
  `exit`-Event warten, siehe Lücke 3). Bereit = `server.lock.json` + Health mit derselben
  `serverInstanceId`; Code über `POST /api/launcher/code` (Bearer `launcherToken`, ohne Origin) →
  `http://127.0.0.1:<port>/#code=<code>` öffnen. Ein neuer Port heißt neues Cookie (neue Anmeldung).
- **FakeBackend `speed: 1`:** Echo ≈ 1 s, Permission-/Frage-/Plan-Flows wenige Sekunden,
  `fake:slow` ≈ 20 s (Stop-Test); Schlüsselwörter in `docs/wp/WP-13a.md` („Interaktives
  Dev-Szenario“). `session.create` braucht ein existierendes `cwd` (echtes `checkCwd`).
- **„Server beenden“:** Ack, dann Close 4503 an alle Fenster, Exit 0, Lockfile weg – im Test prüfbar
  wie in `main.integration.test.ts`. Aufräumen sonst über `killProcessTree(lock.pid)`.
- Unter Vitest/`NODE_ENV=test` validiert der Server ausgehende Werte mit `throw`; Playwright-Läufe
  ohne diese Variablen laufen mit `off` (`--dev` gäbe `log`, verlangt aber Vite als Origin).

### Hinweise für WP-22 (Live-Abnahme)

- `pnpm start` ohne `PARALLAX_BACKEND` = SdkBackend + echte Integration; beim Start läuft „Profil
  testen“ (`claude --version`, `claude auth status --json`) im Hintergrund → `setupRequired` im
  Host-State sollte nach wenigen Sekunden `false` werden.
- Prüfen: SDK-Import und Verlaufs-Worker aus `dist/server.js` (`createRequire` relativ zum Bundle,
  `node_modules` muss da sein), Shutdown mit laufenden Sessions < 5 s ohne Waisen, Waisen-Bereinigung
  nach hartem Abbruch (Task-Manager) beim nächsten Start, `server.out.log` bleibt leer (nur
  Abstürze vor dem Logger).

### Checks

- Eigene Tests: `main.integration.test.ts` 3 Tests (≈ 35 s), `app/compose.test.ts` 4 Tests
  (≈ 10 s), `launcher/args.test.ts` 4 Tests (+1); `pnpm exec eslint src/server/app
  src/server/main.ts src/server/main.integration.test.ts src/server/launcher/args*.ts` ohne Befund,
  Prettier auf alle geänderten Dateien.
- `pnpm check` **3× grün** (einmal während der letzten Doku-/Testkorrekturen, danach **2×
  hintereinander** auf dem Endstand): `tsc -b`, ESLint ohne Warnungen, Vitest 130 Dateien /
  2441 Tests (Vitest ≈ 120–143 s, gesamt 9,5–10,3 min unter Parallel-Last von WP-20b).
- `pnpm build` grün (Web + `dist/server.js`, 535 kB); `dist/server.js` mit `--backend=fake` über den
  Launcher gestartet (siehe Abnahme).
- `git diff --stat main...HEAD`: nur Besitz-Pfade. Keine Prozesse mit `wp-20a`/Temp-Home im
  Befehl übrig, Ports 4711/4712/4791/5173 frei, im Haupt-Checkout keine Änderung.

### Stolpersteine

- `process.stdout.isTTY` ist laut Typen `boolean`, zur Laufzeit an einer Pipe/Datei aber
  `undefined` – `initLogging({console: undefined})` hieße „Konsole an“; daher `tty.isatty(1)`.
- esbuild hebt externe statische Importe lazy initialisierter Module an den Bundle-Anfang (Lücke 1).
- pnpm 12 reicht `--` an das Script weiter (Lücke 2).
- PowerShell `& pnpm start 2>&1 | …` kehrt erst zurück, wenn der detached Server und Edge enden
  (Lücke 3).
