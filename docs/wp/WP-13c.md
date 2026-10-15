# WP-13c – SdkBackend

> Welle 1b, Teilpaket von WP-13 (Design: `docs/wp/WP-13.md` §2, §3.1, §3.2, §4, §5.3, §7).
> Worktree `.worktrees/wp-13c`, Branch `wp/13c`, Basis `main` = `c7122c9` + 13a-Basismodule
> (`1764e4d`, per `git merge`). Kein Live-`claude`: `query()` und Spawn sind in allen Tests gemockt.

## Auftrag (sinngemäß)

Port `AgentBackend` gegen das installierte `claude` über das Agent SDK 0.3.296:

- `backend/sdkBackend.ts` – `createSdkBackend`: `query()` im Streaming-Input-Modus über
  `AsyncQueue`, vollständige Options-Abbildung, `canUseTool` → `toPermissionRequest` →
  `req.canUseTool`, stderr immer gelesen und ins Log, Steuer-APIs mit Timeouts, Resume mit dem
  zuletzt tatsächlichen Modus, Event-Reihenfolge `spawned` … `exit` zuletzt, `close()` mit
  5-s-Fallback auf `killProcessTree`.
- `backend/sdkOptions.ts` – reine Abbildung `StartSessionRequest` → SDK-`Options`, tabellengetestet.
- `backend/spawn.ts` – `spawnClaudeCodeProcess`-Wrapper: PID + Startzeit, `windowsHide`, ohne
  Shell, nur absoluter `.exe`-Pfad, Signal → Baum-Kill statt Node-Abort.
- `backend/history/pool.ts`, `backend/history/workerSource.ts` – Verlauf in einem
  `worker_threads`-Worker je Config-Dir (Env-Isolation `CLAUDE_CONFIG_DIR`), Timeout-Neustart,
  Leerlauf-Ende, `dispose`; Eval-Worker, kein zweiter Bundle-Einstieg.

**Besitz-Pfade:** die fünf Dateien oben (+ `*.test.ts`) und dieses Dokument. Importiert werden die
13a-Basismodule `backend/lib/asyncQueue.ts`, `backend/permissionRequest.ts`,
`backend/history/parse.ts` (Commit `WP-13a: Basismodule`, gemergt, nicht verändert).

**Abnahme:** WP-13 §4 „Abnahme 13c“; `pnpm check` 2× und `pnpm build` grün; `git diff --stat
main...HEAD` nur Besitz-Pfade + gemergte Basismodule; keine übrig gebliebenen Worker/Prozesse.

---

## Ergebnis (Umsetzung)

**Status:** fertig.

### Module und Exporte

| Datei | Exporte |
|---|---|
| `backend/sdkBackend.ts` | `createSdkBackend(deps?)` → `AgentBackend & {kind:'sdk'}`; `SdkBackendDeps`, `SdkTimeouts`, `SDK_TIMEOUTS` (5000/5000/15000/60000/2000), `SdkQueryHandle`, `SdkQueryFn`, `PERMISSION_FAILURE_MESSAGE`, Helfer `toSdkUserMessage`, `stillQueuedOf`, `withTimeout` |
| `backend/sdkOptions.ts` | `buildQueryOptions(req, hooks)`, `QueryOptionHooks`, `flagSettingsAfterStart(launch)`, `optionIssues(req)`, `SETTING_SOURCES` |
| `backend/spawn.ts` | `createSpawner(opts)`, `SpawnerOptions`, `definedEnv(env)` |
| `backend/history/pool.ts` | `createHistoryPool(opts?)` → `HistoryPool & {size}`, `HistoryOp`, `HistoryPool`, `HistoryPoolOptions`, `historyWorkerKey(launch)`, `defaultSdkModuleUrl()`, `HISTORY_TIMEOUT_MS`, `HISTORY_IDLE_MS`, `DEFAULT_CONFIG_DIR_KEY` |
| `backend/history/workerSource.ts` | `HISTORY_WORKER_SOURCE` (schlichtes CommonJS-Eval-Skript, ~50 Zeilen) |

### Options-Abbildung (`buildQueryOptions`, Tabellentest `sdkOptions.test.ts`)

| Option | Wert | Beleg |
|---|---|---|
| `cwd` | `req.cwd` byte-genau | B „cwd exakt“, F.15 |
| `pathToClaudeCodeExecutable` | `launch.executablePath` | C.7 |
| `env` | `launch.env` inhaltlich unverändert, als **Kopie** (das SDK schreibt `CLAUDE_CODE_ENTRYPOINT`, löscht `NODE_OPTIONS`/`DEBUG` im übergebenen Objekt) | C.2, WP-11-Follow-up |
| `settingSources` | `['user','project','local']` | Plan „SessionManager“ |
| `systemPrompt` | `{type:'preset', preset:'claude_code'}`, `append` nur mit `sdkOptions.appendSystemPrompt` | C.12 |
| `includePartialMessages` | `true` | Plan |
| `thinking` | `{type:'adaptive', display:'summarized'}` | Plan, Recorder |
| `toolConfig` | `{askUserQuestion:{previewFormat:'markdown'}}` | F.5 |
| `promptSuggestions` | `req.promptSuggestions` (immer gesetzt) | B |
| `permissionMode` | `req.permissionMode`; `null` → **weggelassen**; `bypassPermissions` ohne `launch.allowDangerouslySkipPermissions` → weggelassen + Log-Warnung (zusätzliche Absicherung, der Manager filtert schon) | C.3, F.2 |
| `allowDangerouslySkipPermissions` | `true` nur mit Launch-Flag, sonst weggelassen | C.3 |
| `model` / `effort` / `resume` | aus dem Request, `null` → weggelassen (Resume + Modus kommen gemeinsam) | §3.5.3, F.14 |
| `additionalDirectories`, `allowedTools`, `disallowedTools`, `betas` | aus `launch.sdkOptions`, nur wenn nicht leer (Kopien) | C.12 |
| `plugins` | Pfade → `[{type:'local', path}]` | WP-11-Follow-up |
| `settings` | Pfad aus `sdkOptions.settings`; sonst `{autoCompactWindow}` bei `launch.autoCompactWindow ≠ null`; bei beidem Pfad hier und `autoCompactWindow` per `applyFlagSettings` nach Bereitschaft (`flagSettingsAfterStart`) | C.1 |
| `extraArgs` | Kopie von `launch.extraArgs` + `'mcp-config'` = erster `sdkOptions.mcpConfig`-Wert; nur wenn nicht leer; weitere Werte → Log-Warnung (`optionIssues`) | C.12, §7 |
| `canUseTool` | Wrapper (sdkBackend): `toPermissionRequest` → `req.canUseTool(request, options.signal)`; wirft der Handler → Log `error` + `{behavior:'deny', message:'Parallax could not process this request.'}` + Event `error{where:'control'}` | F.3 |
| `stderr` | → Event `stderr` + Log (mit eigenem Spawn ruft das SDK ihn nie, F.16) | |
| `spawnClaudeCodeProcess` | `createSpawner(...)` | C.8, F.16 |

Nie gesetzt: `enableFileCheckpointing`, `extraArgs['replay-user-messages']` (F.9),
`perTaskStopAffordance` (C.5), `sessionId`, `forkSession`, `maxTurns`, `abortController`; das
Modell bzw. der Modus des Profils (`sdkOptions.model/permissionMode`) entscheidet der Manager.

### Spawn-Wrapper (`spawn.ts`)

`spawnHidden(o.command, o.args, {cwd, env: definedEnv(o.env), stdio: pipes, onStderr})` –
`shell:false`/`windowsHide:true`/absoluter `.exe`-Pfad erzwingt `lib/process.ts`. Zusätzlich
vergleicht der Wrapper `o.command` case-insensitiv mit `launch.executablePath`
(`expectedCommand`): ein anderes Programm (z. B. `node.exe` bei einem `.js`-Pfad) → `TypeError`,
kein Spawn. `o.signal` geht nie an `spawn()`; ein Abort ruft `killProcessTree(pid)` (nicht nach dem
Exit). Startzeit = `now()` beim Spawn. Synchrone Fehler → `onError` + erneut geworfen (das SDK wirft
dann aus `query()`), asynchrone ohne PID (ENOENT) → `onError`, kein `exit` des Kindes.

### Sitzungsablauf (`sdkBackend.ts`)

- **Start (synchron):** Optionen bauen, `query({prompt: input, options})` – das SDK spawnt darin
  synchron, `spawned{pid, at}` ist damit immer das erste Event und `session.pid` sofort gesetzt.
  Synchrone Fehler → `error{where:'spawn'}` + `exit{code:null, expected:false}` (ein bereits
  gestarteter Prozess wird wie bei `close()` beendet). Pumpe `for await (m of q)` → `message`.
- **`exit` immer zuletzt:** erst wenn der Prozess beendet ist **und** die Pumpe endete, höchstens
  `iteratorAfterExitMs` (2 s) nach dem Prozessende; ohne Spawn zählt das Iterator-Ende. Danach
  `events.end()`, Input-Ende, `Query.close()` falls die Pumpe noch hängt; spätere Messages/stderr
  werden verworfen. `expected` = `close()`/`dispose()` wurde gerufen.
- **Iterator endet bei laufendem Prozess** (ohne `close()`): Ablauf wie `close()`, `expected:false`.
- **Fehlerbilder:** Crash → `error{iterator}` + `exit{code, expected:false}`; Spawn-Fehler →
  genau ein `error{spawn}` + `exit{code:null}` (der Folgefehler des Iterators wird nur geloggt);
  Iterator-Fehler während `close()` nur im Log (kein Crash-Signal); Fehler eines laufenden Kindes
  (z. B. `kill()` scheitert) nur Log.
- **`close()`:** `input.end()`, `Query.close()`, ≤ `closeGraceMs` (5 s) auf `exit`, sonst
  `killProcessTree(pid)` (nicht abgewartet) und ≤ `killWaitMs` (5 s), sonst
  `exit{code:null, signal:'SIGKILL', expected:true}` synthetisieren (Log `error`). Idempotent, löst
  nach `exit` auf; höchstens 10 s auch bei hängendem `taskkill`.
- **`send(p)`:** `SDKUserMessage {type:'user', message:{role:'user', content}, parent_tool_use_id:null,
  uuid, priority, origin:{kind:'human'}}`; genau ein Textblock → String, sonst Blöcke (`image`/
  `document` als base64-`source`). `uuid` muss eine UUID sein (`TypeError`), nach `exit` oder ab
  `close()` → `Error('session closed')`. Vor dem Lesen durch das SDK puffert die Input-Queue.
- **Steuer-APIs:** `interrupt` → `{stillQueued}` (zod; `undefined` der Alt-CLI → `[]`),
  `setModel(null → undefined)`, `setPermissionMode`, `applyFlagSettings`, `getContextUsage({detail})`
  roh, `supportedModels`/`supportedCommands`/`stopTask` durchgereicht. Timeout `controlMs` (15 s),
  `getContextUsage('full')` `contextFullMs` (60 s); Ablehnung = `Error` (`name: 'TimeoutError'` beim
  Timeout); nach `exit` und ab `close()` sofort `Error('session closed')`.
- **C.1 Settings-Datei + `autoCompactWindow`:** das Backend wartet selbst auf `supportedModels()`
  (= `initialize`-Handshake) und ruft dann `applyFlagSettings({autoCompactWindow})`; Fehler →
  `error{where:'control'}`.
- **stderr:** jede Zeile als Event und im Log (`info`, gekürzt auf 2000 Zeichen, Logger maskiert).
- **`dispose()`:** alle laufenden Sessions parallel `close()` (`expected:true`), dann
  `history.dispose()`; ein späteres `start()` endet mit `error{spawn,'backend disposed'}` + `exit`.

### Verlauf (`history/pool.ts`, `history/workerSource.ts`)

- Ein Worker je **effektivem** Config-Dir: Schlüssel = `windowsPathKey(CLAUDE_CONFIG_DIR aus
  launch.env)`, Rückfall `launch.configDir`, sonst `<default>`. `new Worker(HISTORY_WORKER_SOURCE,
  {eval:true, env:{...launch.env}, workerData:{sdkUrl}, execArgv:[]})` – der Hauptprozess setzt
  `process.env` nie um (F.15).
- `sdkUrl` = `pathToFileURL(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'))`
  (→ `sdk.mjs`); Tests übergeben eine `data:`-URL. Der Worker ruft `getSessionMessages(id)`,
  `listSubagents`, `getSubagentMessages`, `getSessionInfo` (`undefined` → `null`), `renameSession`
  ohne `dir` und antwortet `{id, ok, result | error:{name, message}}` (im Hauptthread mit zod geprüft).
- Timeout je Auftrag 30 s → Ablehnung, Worker beendet, der nächste Auftrag startet einen neuen;
  Leerlauf 60 s → `terminate()`; ein sterbender Worker lehnt seine Aufträge ab; leerlaufende Worker
  sind `unref()` (halten den Prozess nie am Leben); `dispose()` beendet alle, spätere `run` lehnen ab.
- `readHistory` = `messages` + `subagents` → je Agent `subagentMessages` → `mergeHistory` (13a);
  keine Liste von `listSubagents` → `[]` (Warnung); ein fehlgeschlagener Einzel-Lookup lehnt das
  Ganze ab (kein halber Import ins Log). `getSessionInfo` → `toSessionInfo`, `renameSession` → `rename`.

### Abweichungen vom Design (alle additiv/enger)

1. `SdkBackendDeps.query` hat den Typ `SdkQueryFn` (benutzte Teilmenge `SdkQueryHandle`) statt
   `typeof query` – das echte `query` ist zuweisbar (Default), Tests brauchen keine Casts.
2. `createSpawner` hat zusätzlich `expectedCommand` (nur das aufgelöste `claude.exe` startet).
3. `sdkOptions.ts` exportiert zusätzlich `flagSettingsAfterStart`, `optionIssues` (Logging bleibt im
   Backend, die Abbildung bleibt rein); `bypassPermissions` ohne Launch-Flag wird weggelassen.
4. **`applyFlagSettings({autoCompactWindow})` macht das Backend** (§5.3), nicht der Manager
   (§3.5.3 Nr. 6): `AgentSession.applyFlagSettings` kennt nur `effortLevel`/`fastMode`.
5. `createHistoryPool` liefert zusätzlich `size` (lebende Worker, für Tests); Schlüssel aus dem
   effektiven Env-Wert statt nur `configDir`.
6. Iterator-Fehler nach Spawn-Fehler bzw. während `close()` werden nicht als `error{iterator}`
   gemeldet; endet der Iterator bei laufendem Prozess, beendet das Backend ihn selbst.

Keine Contract-Änderung nötig.

### Tests (123 eigene, alle ohne echtes `claude`)

- `sdkOptions.test.ts` (45): jede Tabellenzeile, Weglass-Regeln, Kopien statt Aliasing,
  `flagSettingsAfterStart`, `optionIssues`.
- `spawn.test.ts` (13): Spawn-Argumente ohne Signal/Shell, PID + Startzeit, stderr, Exit,
  Abort → Baum-Kill (auch schon abgebrochen, nicht nach Exit, Kill-Fehler), synchroner/asynchroner
  Spawn-Fehler, `expectedCommand`, echtes `spawnHidden` lehnt `claude`/`.cmd`/relative Pfade vor
  jedem Spawn ab.
- `history/pool.test.ts` (11): echte `worker_threads` mit `data:`-URL-Fake-SDK (alle Ops,
  Env-Isolation je Config-Dir + gleiche Schreibweise → gleicher Worker + Haupt-Env unverändert,
  Fehlername/-text, Timeout-Neustart, Worker-Absturz, Leerlauf-Ende, beschäftigter Worker bleibt,
  `dispose`) und ein Import des **installierten** `sdk.mjs` im Eval-Worker gegen einen leeren
  Temp-Config-Ordner (prüft das Risiko aus §7, startet keinen Prozess).
- `sdkBackend.test.ts` (54): `vi.mock` des SDK und von `lib/process` (ein vergessener Seam wirft),
  Fake-`query` mit Fixture-Messages (`auth-probe`), Fake-`ChildProcess`: Reihenfolge `spawned` …
  `exit` zuletzt, Optionen/Spawn-Optionen, stderr, `close()` (Grace, Kill nach 5 s mit
  Fake-Timern, synthetischer Exit, Kill-Fehler, hängendes `taskkill`, eigene Timeouts, Abort),
  Crash, Exit ohne Iterator-Ende (2 s), Iterator-Ende bei laufendem Prozess, Spawn-Fehler
  (synchron, nach dem Spawn, ohne Spawn, ENOENT, falsches Programm, nach `dispose`), `send`-Format,
  `interrupt`-Abbildung, alle Steuer-Timeouts, `canUseTool`-Wrapper, C.1-Flag-Settings, Verlauf
  (Fake-Pool und echter Worker-Pool mit Merge), `dispose`, Default-`query`/-Spawn.
- Gegenprobe: zwei gezielte Fehler im Backend (Kill-Pfad, Iterator-Fehler nach Spawn-Fehler)
  lassen 5 Tests rot werden.

### Checks

- `pnpm check` 2× hintereinander grün: `tsc -b`, ESLint ohne Warnungen, Vitest 77 Dateien /
  1830 Tests (293 s / 338 s); `pnpm build` grün (Web + `dist/server.js`).
- Eigene Pfade gezielt: `pnpm exec vitest run src/server/backend` (9 Dateien / 211 Tests inkl.
  13a-Basismodule), `pnpm exec eslint src/server/backend`, Prettier auf alle eigenen Dateien.
- Danach keine `node.exe`/`claude.exe` des Worktrees mehr (CIM-Abfrage), alle Worker-Pools und
  Backends werden in `afterEach` entsorgt.

### Stolpersteine

- Ein PowerShell-`[IO.File]::ReadAllText` mit **relativem** Pfad las im .NET-Arbeitsverzeichnis
  (Haupt-Checkout) und legte dort beim Zurückschreiben eine leere `src/server/backend/sdkBackend.ts`
  an; sofort gelöscht, `git status` im Haupt-Checkout danach leer (gleiche Lehre wie WP-11: in
  Skripten nur absolute Pfade).
- `new ChildProcess()` lässt sich als Test-Double ableiten (`override` von Pipes/`pid`/`exitCode`),
  erfüllt so `SpawnedProcess` ohne Casts.
- `Promise.withResolvers<void>()` meldet `no-invalid-void-type` → `<undefined>`.

### Hinweise für 13b (SessionManager)

- `autoCompactWindow` bei Settings-Datei **nicht** selbst setzen (Backend macht es, Abweichung 4).
- `send()` verlangt eine UUID (`newUuid()`), wirft nach `exit` und ab `close()`; Steuer-Aufrufe
  lehnen dann sofort mit `'session closed'` ab, Timeouts mit `name: 'TimeoutError'`.
- `session.pid` ist direkt nach `start()` gesetzt (bei Spawn-Fehler `null`); `spawned` kommt zuerst.
- Spawn-Fehler: genau ein `error{spawn}` vor `exit{expected:false}`; `error{control}` bei
  geworfenem Permission-Handler oder gescheitertem C.1-Flag-Setting (nur loggen).
- stderr loggt das Backend schon auf `info` – im Manager reicht der Ringpuffer.
- `readHistory` lehnt bei Lookup-Fehlern ab (später erneut versuchen), `getSessionInfo` → `null`
  für unbekannte Sessions; `dispose()` entsorgt auch den Verlaufs-Pool.

### Hinweise für WP-20 (Verdrahtung)

- `--backend=sdk` → `createSdkBackend()` ohne Deps; beim Shutdown nach `manager.shutdown()`
  `backend.dispose()`. Der Verlaufs-Worker lädt `sdk.mjs` über `createRequire` relativ zu
  `dist/server.js` – `node_modules` muss vorhanden sein (ADR-004). `sdkBackend.ts` importiert das SDK
  statisch; für einen schlanken Fake-Start ggf. per `await import()` nur bei `--backend=sdk` laden.

### Hinweise für den Live-Smoke (WP-22)

- `spawnClaudeCodeProcess` bekommt `command` = `pathToClaudeCodeExecutable`? (sonst `TypeError`
  durch `expectedCommand`, im Log sichtbar) und `CLAUDE_CODE_ENTRYPOINT=sdk-ts` kommt an.
- `close()`: Exit < 5 s ohne `taskkill`, keine Waisen; stderr landet im Log.
- Bereitschaft über `supportedModels()`; `interrupt()`-Receipt; Settings-Datei +
  `autoCompactWindow` per `applyFlagSettings` (§7 unverifiziert); nur erstes `--mcp-config`.
- Verlaufs-Worker gegen den echten Config-Ordner (`getSessionMessages`, Subagents, Rename im
  Ruhezustand) und mit einem zweiten Profil-Config-Dir (Env-Isolation).
