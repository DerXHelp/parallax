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
| `manager.ts` | `createSessionManager(deps)` → `SessionManager` (= `SessionSource` + `attachPublisher`, `start`, `shutdown`, `publishHostState`, `inspect`, `orphansDone`), `SessionManagerDeps` (u. a. `proc?: Partial<ProcDeps>`), `DEFAULT_SESSION_MANAGER_OPTIONS`, `HOST_STATE_DEBOUNCE_MS`, `RECOVERY_TAIL_ITEMS`, `EngineEntryInfo` | Port `SessionSource`, Serverstart (Recovery, Waisen im Hintergrund), Herzschlag-Schnappschuss der Prozessbäume (`processSnapshotMs` 30 s, WP22-06), Shutdown (Sessions mit offener Entscheidung erst `interrupt`, dann `close()`; nach `shutdownKillAfterMs` 2,5 s hängende Bäume parallel per `taskkill`, WP22-05; Stores flushen, `backend.dispose()`), Host-State, Präsenz, native Toasts (`toasts?: NativeToasts`) |
| `entryState.ts` | `EntryState`, `SessionManagerOptions`, `EngineStores`, `ProcDeps` (`isProcessAlive`, `queryProcesses`, `listProcesses`, `killProcessTree`; R2-02/03, WP22-06), `NormalizerFns`, `SleepPolicy`, `NEVER_SLEEP`, `EngineCore` | Zustand je Eintrag; der eine Op-Pfad `emit` (publizieren → Log → Mirror → `lastOrder`), Fakten nur über `reduceStatus`, Summary/Persistenz je Mikrotask gebündelt |
| `runtime.ts` | `SessionRuntime`, `startRuntime`, `closeRuntime`, `deliverPrompt`, `READY_ATTEMPTS` | ein `claude`-Prozess: Event-Schleife, Normalizer, Signale, `/clear`, Prozessende, Auto-Retry, Bereitschaft (`supportedModels`, zwei Versuche, sonst `error` `CLAUDE_CONTROL_FAILED`; R2-04, ADR-053) |
| `commands.ts` | `handleCommand`, `CommandEngine` | alle Phase-1-Befehle (§3.5.6, architecture §5.2) |
| `broker.ts` | `createBroker(deps)` → `Broker`, `BrokerDeps`, `RespondResult`, `DEFAULT_RECORDS_KEEP` (200) | PermissionBroker (WP-13a): mehrere offene Entscheidungen je Session, Records/Pläne, Neustart → `expired` |
| `brokerRules.ts` | `buildOffer`, `validateResponse`, `buildResult`, `rememberUpdates`, `cancelResult`, `approveModes`, `decisionKindFor`, `parseQuestions`, `parsePlan`, `BROKER_MESSAGES` | Regeln architecture §5.2, rein |
| `promptQueue.ts` | `PromptQueue` | Queue mit `uuid`/`priority`, Übernahme über Lifecycle bzw. `user_message_uuids` |
| `summary.ts` | `summaryOf`, Titelregeln, `/rename`-Parser, Unterhaltungs-Helfer | rein |
| `mirror.ts` | `baseView`, `applyToMirror`, `readMirrorItems`, `emptyDetail`, `findToolCallIn` | Mirror-View, Log-Tail + Verlaufs-Fallback (A.3) |
| `recovery.ts` | `registryFacts`, `wasActive`, `interruptedToolCalls`, `cleanupOrphans`, `splitOrphanRecords`, `keepsOrphanRecord`, `OrphanDeps`, `OrphanResult` (`killed`/`gone`/`not_ours`/`unknown`/`failed`), `ORPHAN_START_TOLERANCE_MS` (5 s) | Serverstart, Waisen (C.8): Lebend-Vorfilter, eine gebündelte Abfrage, `unknown`/`failed` behalten den Record (R2-02, ADR-051); beendet werden der verifizierte `claude.exe`-Wurzelprozess und exakt passende Prozesse (PID + Image + Startzeit) des letzten Herzschlag-Schnappschusses (WP22-06, ADR-081) |
| `processStore.ts` | `openProcessStore`, `createMemoryProcessStore`, `ProcessStore` (`add`, `remove`, `heartbeat`, `flush`), `processRecordSchema`/`ProcessRecord`/`ProcessRecordInput`, `processChildSchema`, `processesFileSchema`, `PROCESSES_FILE`, `PROCESSES_SCHEMA_VERSION`, `MAX_RECORDED_CHILDREN` | `processes.json` (`entryId`, PID, Image, Startzeit, `aliveAt`, `children`; `add` mit `flush`, `remove`/`heartbeat` entprellt) |
| `notifier.ts` | `chooseChannel`, `planNotification`, `decisionsCleared`, `isViewedByVisibleClient` | Benachrichtigungskanal (A.9), rein; mit nativen Toasts: kein Fenster bzw. Fenster ohne Web Notifications → nativer Toast (WP22-03) |
| `nativeToasts.ts` | `createNativeToasts`, `NativeToasts`, `DISABLED_NATIVE_TOASTS`, `TOAST_TEXTS`, `toastText` | native Windows-Toasts der Engine (Texte en/de nach `settings.language`, nacheinander, erster Fehler schaltet ab → Host-State `nativeNotifications: false`; Klick schließt nur, Phase 1) |
| `retry.ts` | `decideRetry`, `afterSuccessfulTurn`, `DEFAULT_AUTO_RETRY` | Auto-Retry nur nach Absturz im Leerlauf (ADR-025), rein |
| `models.ts` | `toModelCatalog`, `currentModelOption` | `supportedModels()` → `ModelOption[]` (tolerant) |
| `lib/` | `createSerial`, `Timers`/`createManualTimers`, `readGitBranch` | siehe `lib/README.md` |
| `testing/harness.ts` | `createEngineHarness`, `answerFromFixture`, `HARNESS_*` | Manager + FakeBackend + Doubles + virtuelle Uhr (Tests, WP-20); `proc` mit `info` (lebende Prozesse) und `queries` |
| `testing/memoryStores.ts`, `testing/memoryPublisher.ts` | `createMemoryStores`, `createMemoryPublisher` | Test-Doubles der Store-Ports und des `SessionPublisher` (WP-13a) |

Integrationstests: `fixtures.integration.test.ts` (alle aufgezeichneten Fixtures), `engine.integration.test.ts`
(Crash, Retry, Neustart, Rennen, Präsenz, Waisen, Shutdown), `commands.integration.test.ts` (Befehlstabelle),
`ws.integration.test.ts` (echter Hub über WebSocket).
