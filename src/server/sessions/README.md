# src/server/sessions – Normalizer, Status, SessionManager

- **Port (eingefroren seit WP-02, Änderung nur per Contract-Änderung):** `ports.ts` –
  `NormalizerContext`, `LiveNormalizer`, `StatusSignal`/`StatusEvent`, `ReduceStatus`
  (+ `ReduceStatusContext`) mit den Pflichtregeln aus WP-02 §9.4 und R0 (Kommentar im Port,
  `docs/architecture.md` §6/§7).
- WP-12 besitzt `normalizer/**` und `status/**`: Normalizer mit zwei Eingangsadaptern (live und
  Verlauf) → identische UI-Items, Statusmaschine; Snapshot-Tests gegen `test/fixtures/sdk/*.jsonl`,
  synthetische Streams als `.ts` in `normalizer/synthetic/` (nie `.jsonl`, R0-06).
- WP-13 besitzt alle übrigen Dateien hier: SessionManager (Queue, Interrupt, Modell/Mode,
  Crash/interrupted) und PermissionBroker (mehrere offene Entscheidungen pro Session, Regeln
  `docs/architecture.md` §5.2).

Diese README pflegt der Koordinator (zwei Owner). Details: `docs/plan.md`, „Server-Bausteine“ und
Review A.3–A.6.

## Manager (WP-13b)

Design: `docs/wp/WP-13.md` §3.5, Ergebnis und Verdrahtung für WP-20: `docs/wp/WP-13b.md`.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `manager.ts` | `createSessionManager(deps)` → `SessionManager` (= `SessionSource` + `attachPublisher`, `start`, `shutdown`, `publishHostState`, `inspect`, `orphansDone`), `SessionManagerDeps`, `DEFAULT_SESSION_MANAGER_OPTIONS`, `EngineEntryInfo` | Port `SessionSource`, Serverstart (Recovery, Waisen), Shutdown, Host-State, Präsenz |
| `entryState.ts` | `EntryState`, `SessionManagerOptions`, `SleepPolicy`, `NEVER_SLEEP`, `EngineCore` | Zustand je Eintrag; der eine Op-Pfad `emit` (publizieren → Log → Mirror → `lastOrder`), Fakten nur über `reduceStatus`, Summary/Persistenz je Mikrotask gebündelt |
| `runtime.ts` | `SessionRuntime`, `startRuntime`, `closeRuntime`, `deliverPrompt` | ein `claude`-Prozess: Event-Schleife, Normalizer, Signale, `/clear`, Prozessende, Auto-Retry, Bereitschaft (`supportedModels`) |
| `commands.ts` | `handleCommand`, `CommandEngine` | alle Phase-1-Befehle (§3.5.6, architecture §5.2) |
| `promptQueue.ts` | `PromptQueue` | Queue mit `uuid`/`priority`, Übernahme über Lifecycle bzw. `user_message_uuids` |
| `summary.ts` | `summaryOf`, Titelregeln, `/rename`-Parser, Unterhaltungs-Helfer | rein |
| `mirror.ts` | `baseView`, `applyToMirror`, `readMirrorItems`, `emptyDetail`, `findToolCallIn` | Mirror-View, Log-Tail + Verlaufs-Fallback (A.3) |
| `recovery.ts` | `registryFacts`, `interruptedToolCalls`, `cleanupOrphan`, `ORPHAN_START_TOLERANCE_MS` | Serverstart, Waisen (C.8) |
| `processStore.ts` | `openProcessStore`, `createMemoryProcessStore`, `processRecordSchema`, `PROCESSES_FILE` | `processes.json` (PID + Startzeit) |
| `notifier.ts` | `chooseChannel`, `planNotification`, `decisionsCleared`, `isViewedByVisibleClient` | Benachrichtigungskanal (A.9), rein |
| `retry.ts` | `decideRetry`, `afterSuccessfulTurn`, `DEFAULT_AUTO_RETRY` | Auto-Retry nur nach Absturz im Leerlauf (ADR-025), rein |
| `models.ts` | `toModelCatalog`, `currentModelOption` | `supportedModels()` → `ModelOption[]` (tolerant) |
| `lib/` | `createSerial`, `Timers`/`createManualTimers`, `readGitBranch` | siehe `lib/README.md` |
| `testing/harness.ts` | `createEngineHarness`, `answerFromFixture`, `HARNESS_*` | Manager + FakeBackend + Doubles + virtuelle Uhr (Tests, WP-20) |

Integrationstests: `fixtures.integration.test.ts` (alle aufgezeichneten Fixtures), `engine.integration.test.ts`
(Crash, Retry, Neustart, Rennen, Präsenz, Waisen, Shutdown), `commands.integration.test.ts` (Befehlstabelle),
`ws.integration.test.ts` (echter Hub über WebSocket).
