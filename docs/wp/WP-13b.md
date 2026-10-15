# WP-13b – SessionManager

> Welle 1b, Teilpaket von WP-13 (verbindliches Design: `docs/wp/WP-13.md` §2, §3.5, §3.6, §4, §5.2,
> §7), kritischer Pfad 13 → 20 → 22. Worktree `.worktrees/wp-13b`, Branch `wp/13b`, Basis `main` =
> `7380153` (13a, 13c, WP-10/11/12/14/15/16 gemergt). Kein Live-`claude`: alle Tests über das
> FakeBackend, Memory-Doubles und die echten WP-10/12-Module.

## Auftrag (sinngemäß)

- `SessionManager` (Port `SessionSource`) exakt nach WP-13 §3.5: Lebenszyklus je Eintrag (ruhend
  beim Serverstart, Resume bei Interaktion, Bereitschaft nach `supportedModels()`), alle
  Phase-1-Befehle (Tabelle §3.5.6), Prompt-Queue (`uuid` + `priority`, Übernahme über
  `user_message_uuids`), Interrupt (vorher deny+interrupt), Modell/Mode/Effort, `/clear` im selben
  Eintrag, `/rename` (laufend über die Session, ruhend über `renameSession`), Titel/KI-Titel,
  Context nach jedem Turn + Schätzung, Normalizer + `reduceStatus`, Mirror-View mit einem Op-Pfad,
  Summaries, Persistenz über die Stores, Crash → `error` + „Neu starten“, Auto-Retry nur nach
  Absturz im Leerlauf, Wiederherstellung nach Neustart (`expired`/`needs-resume`, A.10), Shutdown,
  Waisen-Bereinigung über `processes.json`, Git-Branch am Turn-Ende (nur `resolveExecutable`),
  Schlaf-Hook (Vorbereitung), Benachrichtigungen. Test-Harness `sessions/testing/harness.ts` für
  WP-20.
- **Besitz-Pfade:** WP-13 §4 Zeile 13b (+ `*.test.ts`, `sessions/*.integration.test.ts`), dieses
  Dokument, Abschnitt „Manager“ in `src/server/sessions/README.md`.
- **Abnahme:** Integrationssuite §5.2 vollständig grün (inkl. Restart- und WS-Test), Befehlstabelle
  als Tabellentest, jede Op/Summary besteht die Hub-Validierung; `pnpm check` 2× und `pnpm build`
  grün; Tests ohne Wanduhr-Abhängigkeit; `git diff --stat main...HEAD` nur Besitz-Pfade; keine
  übrig gebliebenen Prozesse.

---

## Ergebnis (Umsetzung)

**Status:** fertig. Keine Contract-Änderung nötig (die R1-Freigaben `PROMPT_NOT_DELIVERED`,
`context_estimate.contextWindow`, `BackendSessionInfo.firstPrompt`, `DecisionStore.flush()`,
Re-Export `capText`/`capInput`, `childProcesses()` werden direkt genutzt).

### Module und Exporte

| Datei | Exporte |
| --- | --- |
| `sessions/manager.ts` | `createSessionManager(deps)` → `SessionManager` (`SessionSource` + `attachPublisher`, `start`, `shutdown`, `publishHostState`, `inspect`, `orphansDone`), `SessionManagerDeps`, `SessionManagerOptions`, `SleepPolicy`, `EngineEntryInfo`, `DEFAULT_SESSION_MANAGER_OPTIONS`, `HOST_STATE_DEBOUNCE_MS`, `RECOVERY_TAIL_ITEMS` |
| `sessions/entryState.ts` | `EntryState`, `EngineCore`, `EngineStores`, `NormalizerFns`, `ProcDeps`, `NEVER_SLEEP`, `gaugeOf`, `errorPayloadOf`, `errorMessage`, `commandError` |
| `sessions/runtime.ts` | `SessionRuntime`, `startRuntime`, `closeRuntime`, `deliverPrompt`, `StartOptions` |
| `sessions/commands.ts` | `handleCommand(engine, cmd, ctx)`, `CommandEngine` |
| `sessions/promptQueue.ts` | `PromptQueue` (`add`, `remove`, `onLifecycle`, `onTurnResult`, `drain`, `list`, `count`) |
| `sessions/summary.ts` | `summaryOf`, `titleFromPrompt`, `PROMPT_TITLE_CHARS`, `parseRenameCommand`, `titleChangeDecision`, `acceptsAiTitle`, `isPromptFallback`, `aiTitleFrom`, `endReasonFor`, `newConversation`, `withCurrentConversation`, `cwdLabel`, `implementPlanPrompt`, `capTitle` |
| `sessions/mirror.ts` | `emptyDetail`, `baseView`, `applyToMirror`, `readMirrorItems`, `findToolCallIn`, `sortDecisions` |
| `sessions/recovery.ts` | `registryFacts`, `wasActive`, `interruptedToolCalls`, `cleanupOrphan`, `ORPHAN_START_TOLERANCE_MS`, `OrphanDeps`, `OrphanResult` |
| `sessions/processStore.ts` | `openProcessStore`, `createMemoryProcessStore`, `processRecordSchema`, `processesFileSchema`, `PROCESSES_FILE`, `PROCESSES_SCHEMA_VERSION`, Typen `ProcessRecord`, `ProcessStore`, `MemoryProcessStore` |
| `sessions/notifier.ts` | `chooseChannel`, `planNotification`, `decisionsCleared`, `isViewedByVisibleClient` |
| `sessions/retry.ts` | `decideRetry`, `afterSuccessfulTurn`, `DEFAULT_AUTO_RETRY`, `INITIAL_RETRY_STATE` |
| `sessions/models.ts` | `toModelCatalog`, `currentModelOption`, `ModelCatalog` |
| `sessions/lib/serial.ts` | `createSerial` (Lifecycle-Lock) |
| `sessions/lib/timers.ts` | `Timers`, `TimerHandle`, `realTimers`, `createManualTimers` |
| `sessions/lib/gitBranch.ts` | `readGitBranch`, `GIT_BRANCH_TIMEOUT_MS` |
| `sessions/testing/harness.ts` | `createEngineHarness(opts)` → `EngineHarness` (`cmd`, `cmdError`, `create`, `summary`, `facts`, `status`, `decisions`, `session(s)`, `waitFor`, `settle`, `drive`, `restart`, `close`, `timers`, `proc`, `errors`), `answerFromFixture`, `HARNESS_CLIENT_ID`, `HARNESS_CWD`, `HARNESS_HOST` |

### Verhalten (Kurzfassung, ergänzt §3.5)

- **Ein Op-Pfad:** `EntryState.emit(ops)` → `publisher.publishOps` → Log (nicht-streamende
  Upserts/Removes der laufenden Unterhaltung) → Mirror bzw. Lade-Puffer → `lastOrder`.
  Engine-Items (`px:<cv>:<order>`, `order = lastOrder + 1`) nur ohne lebenden Normalizer
  (Startfehler, Prozessende). Registry-Write und Summary werden je Mikrotask gebündelt (eine
  Registry-Zeile je Normalizer-Ausgabe), Summaries nur bei geändertem Inhalt, `urgent` bei
  Fakten-Änderung.
- **Start (§3.5.3, im Lifecycle-Lock):** Waisen-Bereinigung abwarten → `launchSpecFor` + `checkCwd`
  (Fehler: `process_starting` + `process_exit{error}` → `error`, `px`-Item, `lastError`, Befehl
  scheitert; `session.create` liefert dann `messageUuid: null`) → Mirror sicherstellen (der Broker
  findet Tool-Calls/Requester im Mirror) → Modus `override ?? entry ?? Profil ?? sdkOptions`,
  `bypassPermissions` nur mit `allowsBypass` → `closeExpired` → Normalizer mit `nextOrder =
  lastOrder + 1` → `backend.start` → `process_starting`. Bereitschaft: `supportedModels()` →
  `detail.models` + Cache je Profil; ohne `session_state` und ohne gesendeten Prompt synthetisches
  `idle`. Gleichzeitige `sendPrompt` laufen durch denselben Lock (ein Start, Test).
- **Prompt:** `/rename X` → `pendingRename`; `now` bricht offene Haupt-Entscheidungen ab;
  `registerPrompt` vor `send()`; Queue `sending` → `queued` → weg (Lifecycle oder
  `user_message_uuids`); `send()`-Fehler → Prompt aus der Queue, `SESSION_NOT_RUNNING`.
- **Signale:** genau §3.5.5. `context_estimate` nutzt das Signalfeld `contextWindow` (R1-07, keine
  Roh-`result`-Messages). `session_state idle` (Alt-CLI: `turn_result`) = Turn-Ende: Context-Abfrage
  (entprellt `contextRefreshDelayMs`) und – nach einem nicht-synthetischen Turn – KI-Titel-Abfrage
  (entprellt `aiTitleDelayMs`); Git-Branch bei jedem nicht-synthetischen `turn_result`.
- **`/clear`:** genau §3.5.9 (alte Unterhaltung `endedAt`/`endReason`/Titel, neue `cv_` mit
  `resetCorrelationId`, Titel `custom` bleibt sonst `''`/`none`, Gauge zurück, `conversation.reset`
  + `detail.patch`, danach `startConversation(id, 1)`; Session-ID aus `session_id`/`init`).
- **Prozessende (§3.5.12):** Shutdown → nur `processes.remove`. Sonst synchron `broker.cancel('all',
  'process_exit')` → `finalizeOpen('process_exit')` → nie gestartete Prompts als
  `PROMPT_NOT_DELIVERED` (`messageUuid`, `preview`) → bei `expected:false` `CLAUDE_SPAWN_FAILED`
  bzw. `CLAUDE_PROCESS_CRASHED {exitCode, signal}` (stderr-/Iterator-Detail nur im englischen
  `message`), außer ein Startfehler des Turns steht schon (dessen Item/`lastError` bleiben) →
  `process_exit` → Auto-Retry-Entscheidung.
- **Auto-Retry (ADR-025):** nur `CLAUDE_PROCESS_CRASHED` mit vorher `idle`, leerer Queue, ohne offene
  Entscheidung; 2 s / 10 s / 30 s, max. 3; Zähler zurück nach erfolgreichem Turn oder wenn der
  Prozess ≥ `stableMs` lief (beim Exit gemessen); `sendPrompt`/`resume`/`close`/Plan-Freigabe brechen
  den Timer ab; Retry = Start ohne Prompt (`byClientId: null`).
- **Serverstart (§3.5.13):** je Eintrag `decisions.load` → `broker.restore` → Fakten aus der
  Registry → `server_restart` → `decisions_changed`; war der Eintrag `starting|working` oder hat
  offene Records: Log-Tail (500) → offene Tool-Calls `interrupted` (+ Outcome `expired`) per `emit`.
  Waisen im Hintergrund (Start des Eintrags wartet): `processInfo` → Name (case-insensitiv) +
  Startzeit ± 5 s → `killProcessTree`; ist der Prozess weg, werden direkte Kinder beendet, die nach
  ihm und vor diesem Server starteten (`childProcesses`, R1-Hinweis); Record immer entfernen.
- **Shutdown (§3.5.14):** `shuttingDown` (Befehle → `SERVER_SHUTTING_DOWN`, Fakten eingefroren),
  Timer weg, `broker.freeze()`, alle `close()` parallel bis `shutdownTimeoutMs` (15 s), danach
  `killProcessTree` der übrigen, Registry/Transkripte/Decisions/Processes flushen,
  `backend.dispose()`. `server.shutdown` zählt `sessionsStopped` vorher und ruft
  `onShutdownRequested` per `setImmediate` nach dem Ack.
- **Präsenz/Benachrichtigungen (§3.5.15):** Kanalwahl rein (`notifier.ts`), `notify` mit Titel oder
  Pfad-Ende, `clearNotification` bei „keine offene Entscheidung mehr“ und „gesehen“ (`viewed`).
- **Host-State:** alle Felder explizit, Engine-Warnungen `mcp:<entryId>` (`MCP_SERVER_NOT_APPROVED
  {servers}`), `accountLimits` je Profil (Veröffentlichung 1 s entprellt).
- **Schlaf-Hook (Phase 2, §3.5.17):** `SleepPolicy.schedule(entryId, facts, now)` (Default nie);
  liefert sie eine Verzögerung und gilt `canSleep`, schließt der Manager mit `closeRuntime('sleep')`
  (erwartet → `sleeping`, `unread` bleibt). Wakeup-/`/loop`-Erkennung fehlt bewusst (R0-27).

### Abweichungen vom Design (additiv/präzisiert)

1. `SessionManagerDeps` zusätzlich: `timers` (Timer-Seam, Tests ohne Wanduhr), `gitBranch`,
   `sleepPolicy`, `logger`, `onInternalError` (Tests sammeln unerwartete Fehler), `proc.childProcesses`;
   `normalizer` als `Partial`. `SessionManager.orphansDone()` (Tests/Diagnose).
2. `SessionManagerOptions.aiTitleDelayMs` (Default 2000): die KI-Titel-Abfrage läuft am Turn-Ende
   (`idle`) entprellt statt direkt beim `turn_result` – die CLI (und das Fake) schreiben den
   KI-Titel erst nach dem Result; die Regel „höchstens eine Abfrage gleichzeitig“ bleibt.
3. `firstPrompt` (R1) ersetzt die Heuristik, wo vorhanden: `summary` = `firstPrompt` (oder dessen
   mit „…“ gekürzter Anfang) gilt als Prompt-Fallback; ohne `firstPrompt` die Heuristik §3.5.8.
4. `applyFlagSettings({autoCompactWindow})` bei Settings-Datei macht das SdkBackend (13c,
   Abweichung 4), nicht der Manager. stderr loggt das Backend; der Manager hält nur den Ringpuffer.
5. Der Mirror wird nach dem Prozessende verworfen, wenn kein Abonnent mehr da ist (B
   „Cache-Verdrängung“; der Hub hält seinen View in der 60-s-Gnadenfrist selbst, ein späteres
   `loadView` baut aus dem Log neu).
6. Git-Branch wird nicht persistiert (`Entry` hat kein Feld; Summary-Feld ist Phase 2): nach einem
   Neustart `null` bis zum nächsten Turn-Ende. Detached HEAD → `null`.
7. `session.interrupt` bei laufendem Prozess im Leerlauf ruft `interrupt()` trotzdem (die CLI
   antwortet `still_queued: []`, Fixture `interrupt#173`); ohne Prozess No-op `{stillQueued: []}`.
8. Bekannte, gewollte `decision-mismatch`-Diagnosen mit `answerFromFixture` (ADR-012, Regeln **und**
   Verzeichnisse an dasselbe Ziel): `permissions#46`, `permissions#282` und zusätzlich
   `permissions-rules#371` (Aufzeichnung nur `addRules → localSettings`, das Angebot enthält auch das
   Verzeichnis).
9. Ende einer Unterhaltung mit leerem Titel speichert `title: null` (statt `''`).

Keine Contract-Wünsche offen. Optional (Phase 2): `Entry.gitBranch` persistieren.

### Verdrahtung für WP-20 (`main.ts`)

```ts
const warnings = createStoreWarnings();
// StoreVersionTooNewError (auch processes.json) → stderr + Log, process.exitCode = STORE_VERSION_TOO_NEW_EXIT_CODE
const processes = await openProcessStore({ home: config.home, warnings });
const backend = config.backend === 'fake' ? createFakeBackend({ speed: 1 }) : createSdkBackend();
const claude = config.backend === 'fake' ? createFakeClaudeIntegration() : createClaudeIntegration({ appVersion });
const manager = createSessionManager({
  backend, claude,
  stores: { registry, transcripts, decisions, blobs, settings, warnings, processes },
  host: { serverVersion, sdkVersion, sdkClaudeCodeVersion, platform: process.platform,
          dataDirLabel: config.dataDirLabel, dev: config.dev },
  onShutdownRequested: () => void stop(),
});
const hub = createSyncHub({ source: manager, instance, validation: config.dev ? 'log' : 'off' });
manager.attachPublisher(hub);                      // vor start()
warnings.onChange(() => manager.publishHostState());
await manager.start();                             // vor listen(); Waisen laufen im Hintergrund
void claude.checkProfile(claude.profiles.getDefault().id).then(() => manager.publishHostState());
// stop(): await manager.shutdown();               // close ≤ 15 s → taskkill, Stores flushen, backend.dispose()
//         await app.close();                      // Sockets 4503
//         await Promise.all([registry.close(), settings.close(), decisions.close(), blobs.close(),
//                            transcripts.close(), processes.close()]);
```

- `manager.shutdown()` ist idempotent und die eine Shutdown-Funktion für `server.shutdown`,
  `SIGINT`/`SIGTERM` und WP-21 („Server beenden“).
- Tests von WP-20: `createEngineHarness({ scenario, seed, presence, options })` (virtuelle Uhr,
  `timers.advance`, `drive(entryId, fixture)` bedient die Tore wie der Recorder,
  `answerFromFixture`). Für echte WS-Tests zeigt `sessions/ws.integration.test.ts` den Aufbau mit
  `createApp` + `createSyncHub` + Manager.

### Tests

| Datei | Inhalt |
| --- | --- |
| `fixtures.integration.test.ts` | `auth-probe` (Statusfolge, Modell, `apiKeySource`, Context, Log nur final, `lastOrder`, Close), `permissions` (alle Outcomes, deny+interrupt ohne `error`/`unread`, Tool-Status `awaiting_decision → running → done`, Modus `acceptEdits`), `permissions-rules` (neue Entscheidung je Abfrage), `ask-user-question` (keine Diagnose), `plan-mode` (v1 revise → v2 mit `previousVersionPlan`, approve + edited, Pläne, `needs-review → working`), `clear-rename` (Rename-Prompt, Echo, Reset-Reihenfolge, Session-ID aus `init`, Reset-Turn-Titel ignoriert), `queue-priority` (Queue-Zustände, Reihenfolge, `now`, Hintergrund, `done` zuletzt), `interrupt`/`interrupt-requesting`, `subagent`, `resume` (Session-ID/Modus, Bypass C.3), Verlauf als Quelle (einmaliger Import) |
| `engine.integration.test.ts` | Crash mitten im Turn / mit Entscheidung / nicht zugestellter Prompt, Startfehler (`SESSION_HELD_ELSEWHERE`, `CLAUDE_AUTH_FAILED`, `CLAUDE_NOT_FOUND`), Auto-Retry (2/10/30 s, max. 3, Reset nach Turn bzw. `stableMs`, Abbruch durch `resume`, `autoRetry:false`), parallele/abgebrochene Entscheidungen, erster Klick gewinnt, `now`/Interrupt mit offener Entscheidung, Neustart mit offener Plan-Entscheidung (expired, `DECISION_EXPIRED`, Freigabe mit Modus + Prompt), `session.resume` schließt Karten, Neustart-Fakten, `loadView`-Rennen, Präsenz/Kanäle, Waisen (Treffer/fremd/weg, Kinder, Start wartet), Shutdown (Zählung, Hook nach Ack, Fakten unverändert, Flushes, hängendes `close()` → taskkill nach 15 s), KI-Titel, Git-Branch, MCP-Warnung, Rate-Limit → `accountLimits`, Schlaf-Hook, Host-State |
| `commands.integration.test.ts` | Befehlstabelle: jede Fehlerzeile (`ENTRY_NOT_FOUND` für alle Eintragsbefehle, `SERVER_SHUTTING_DOWN` für alle Befehle, `SESSION_EXTERNAL`, `INTERNAL_ERROR`, `PROFILE_NOT_FOUND`, `MODE_NOT_ALLOWED` für create/Profil-Default/setPermissionMode/Plan, `NOT_IMPLEMENTED`, `PATH_REJECTED`/`CWD_NOT_FOUND`/`CWD_NOT_DIRECTORY` mit echtem `checkCwd`, `SESSION_NOT_RUNNING`, `CONVERSATION_NOT_FOUND`, `DECISION_NOT_FOUND`, `DECISION_OPTION_UNAVAILABLE`, `CLAUDE_CONTROL_FAILED`) und die Wirkung jedes Befehls ruhend/laufend |
| `ws.integration.test.ts` | echter Hub + App (Port 0, Temp-Home): Handshake, `cmd`/`ack`, Snapshot, Live-Ops mit fortlaufender Seq, Reconnect mit `sinceSeq` (Replay ohne Snapshot), Fehler-Ack |
| Unit | `promptQueue`, `retry`, `notifier` (Kanaltabelle), `summary` (Titelregeln, `title_changed`-Tabelle, KI-Titel), `models`, `processStore` (Datei + Speicher, neuere Version), `recovery`, `mirror`, `lib/{serial,timers,gitBranch}` |

Alle Ops/Summaries/Host-States/Notifications laufen durch die Hub-gleiche Validierung des
Memory-Publishers bzw. des echten Hubs (`validation: 'throw'`); Registry, Transkript- und
Decision-Store prüfen jede Zeile. Keine Wanduhr: virtuelle Uhr + manuelle Timer (`advance`), das
FakeBackend mit `speed: 0`; `waitFor` hat nur eine großzügige Sicherheitsgrenze (20 s).

### Checks

- Eigene Tests: 15 Dateien / 176 Tests (`pnpm exec vitest run src/server/sessions` gesamt: 27 Dateien
  / 496 Tests inkl. 13a/WP-12), `pnpm exec eslint src/server/sessions` ohne Befund, Prettier auf alle
  eigenen Dateien.
- `pnpm check` **3× grün** (einmal vor, zweimal nach der letzten Änderung): `tsc -b`, ESLint ohne
  Warnungen, Vitest 116 Dateien / 2328 Tests (Laufzeit gesamt 414–511 s, Vitest ≈ 86–102 s).
- `pnpm build` grün (Web + `dist/server.js`); zusätzlich `sessions/manager.ts` probeweise mit esbuild
  gebündelt (`--packages=external`, im Scratch-Ordner, danach gelöscht).
- Kein Live-`claude`, kein echter Spawn in den Tests (Git-Branch, Waisen, `processInfo` gestubbt);
  danach keine Prozesse des Worktrees.
- Integrationstests mit `vi.setConfig({ testTimeout: 60_000 })` als großzügige Obergrenze unter
  Parallel-Last; die Logik selbst hängt an keiner Wanduhr.

### Stolpersteine

- `onExit` darf den Retry-Timer nicht mit den Prozess-Timern abräumen (`cancelProcessTimers` vs.
  `cancelTimers`) – sonst plant der Manager den Retry und löscht ihn sofort wieder.
- Der KI-Titel steht im Fake (wie in der CLI) erst nach dem Turn-Ende in `getSessionInfo` – eine
  Abfrage direkt beim `turn_result` sieht nur den Prompt-Fallback (daher Abweichung 2).
- PowerShell: `Set-Content -Encoding utf8` schreibt ein BOM; Dateien nur mit dem Write-Tool bzw.
  Node schreiben. Mehrere Dateien an `pnpm exec eslint` aus PowerShell übergeben fasst sie zu einem
  Argument zusammen (Ordner übergeben oder Bash nutzen).

### Hinweise für den Live-Smoke (WP-22)

- Bereitschaft: Resume ohne Prompt mit echtem `claude` → `supportedModels()` antwortet nach dem
  `initialize`-Handshake → `idle` (sonst bliebe `starting`).
- Interrupt mit offener Entscheidung (deny+interrupt vor `interrupt()`) und `now` mit offener
  Haupt-Entscheidung (§7) – hängt der Turn nicht in `requires_action`?
- KI-Titel: Steht der Titel nach `aiTitleDelayMs` (2 s nach `idle`) in `getSessionInfo().summary`,
  und unterscheidet `firstPrompt` ihn sicher vom Prompt-Fallback? Sonst kommt er erst nach dem
  nächsten Turn.
- Git-Branch über `resolveExecutable('git', launch.env)` mit dem echten PATH aus `buildEnv`.
- `processes.json` beim Spawn geschrieben, beim Exit entfernt; Waisen-Bereinigung nach hartem
  Abbruch (Task-Manager) mit echtem `processInfo`/`childProcesses` (PowerShell 1–3 s, der Start
  des Eintrags wartet darauf).
- Shutdown: alle Sessions < 5 s beendet, keine Waisen; offene Plan-Entscheidung nach Neustart als
  `needs-resume`, „Fortsetzen & Plan freigeben“ setzt den Modus und sendet den Plan-Prompt.
- Context: `getContextUsage('summary')` nach `idle`, Schätzung im Turn mit `contextWindow`.
