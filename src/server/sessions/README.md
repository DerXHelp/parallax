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
| `manager.ts` | `createSessionManager(deps)` → `SessionManager` (= `SessionSource` + `attachPublisher`, `start`, `shutdown`, `publishHostState`, `inspect`, `orphansDone`), `SessionManagerDeps` (u. a. `proc?: Partial<ProcDeps>`), `DEFAULT_SESSION_MANAGER_OPTIONS`, `HOST_STATE_DEBOUNCE_MS`, `RECOVERY_TAIL_ITEMS`, `EngineEntryInfo` | Port `SessionSource`, Serverstart (Recovery, Waisen im Hintergrund), Herzschlag-Schnappschuss der Prozessbäume (`processSnapshotMs` 30 s, WP22-06), Shutdown (C.8, ADR-090: je Session `close()` und bis `shutdownKillAfterMs` 5 s danach warten, dann `taskkill`; wartende Sessions ohne Queue erst `interrupt`, wartende mit Queue/Hintergrund-Task sofort `taskkill` + `PROMPT_NOT_DELIVERED` – `shutdownCanEndTurn`; `SHUTDOWN_SWEEP_GRACE_MS` für den Rahmen; Stores flushen, `backend.dispose()`), Host-State, Präsenz, native Toasts (`toasts?: NativeToasts`) |
| `entryState.ts` | `EntryState`, `SessionManagerOptions`, `EngineStores`, `ProcDeps` (`isProcessAlive`, `queryProcesses`, `listProcesses`, `killProcessTree`; R2-02/03, WP22-06), `NormalizerFns`, `SleepPolicy`, `NEVER_SLEEP`, `EngineCore` | Zustand je Eintrag; der eine Op-Pfad `emit` (publizieren → Log → Mirror → `lastOrder`), Fakten nur über `reduceStatus`, Summary/Persistenz je Mikrotask gebündelt |
| `runtime.ts` | `SessionRuntime`, `startRuntime`, `closeRuntime`, `deliverPrompt`, `READY_ATTEMPTS` | ein `claude`-Prozess: Event-Schleife, Normalizer, Signale, `/clear`, Prozessende, Auto-Retry, Bereitschaft (`supportedModels`, zwei Versuche, sonst `error` `CLAUDE_CONTROL_FAILED`; R2-04, ADR-053) |
| `commands.ts` | `handleCommand`, `CommandEngine` (`hostCommands`, `settingsChanged`) | alle Befehle (§3.5.6, architecture §5.2); Phase 2: Host-Routing, Archiv-/External-Gates, `setPinned`/`setArchived`/`setFastMode`/`switchConversation` (WP-31), `openExternal`/`reclaim`/`consoleCommand`/`continueAfterLimit`, Anhänge in `session.create`/`sendPrompt` (WP-34) |
| `attachments.ts` | `resolveAttachments`, `promptContent`, `PromptAttachments`, `NO_ATTACHMENTS` | Bild-Anhänge (ADR-103): Blob-Prüfung (`BLOB_NOT_FOUND`, `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`), Prompt-Inhalt mit Bildern zuerst |
| `external.ts` | `openExternal`, `watchExternal`, `restoreExternal`, `returnFromExternal`, `consoleCommand`, `consoleState`, `consoleProcessOf`, `scrubConsoleReason`, `HANDOFF_IMPORT_SLACK_MS`, `CONSOLE_REASON_CHARS` | externe Konsole (ADR-104): Query schließen, `claude --resume` über den `ConsoleLauncher`, Überwachung, Rückkehr mit Import der Konsolen-Turns, Serverstart; Secrets der Konsolen-Env nie im Log |
| `continuePlan.ts` | `planContinue`, `cancelContinue`, `restoreContinue`, `CONTINUE_PROMPT`, `MAX_TIMER_DELAY_MS` | Fortsetzen nach Rate-Limit (ADR-112): `continueAt` + Status-Event `wakeup`, Gnadenfrist `continueGraceMs` beim Serverstart |
| `catalogStore.ts` | `openCatalogStore`, `createMemoryCatalogStore`, `CatalogStore` (`removeModels`, `removeLimit`), Schemas | Modell-Kataloge und Abo-Limits je Profil (ADR-114): `model-catalogs.json`, `account-limits.json`; neuere Version → `StoreVersionTooNewError` |
| `commandCatalog.ts` | `toSlashCommands`, `createCommandCatalogStore`, `createMemoryCommandCatalogStore` | Slash-Befehle je Eintrag (ADR-108): `entries/<id>/commands.json`, tolerant gelesen |
| `broker.ts` | `createBroker(deps)` → `Broker`, `BrokerDeps`, `RespondResult`, `DEFAULT_RECORDS_KEEP` (200) | PermissionBroker (WP-13a): mehrere offene Entscheidungen je Session, Records/Pläne, Neustart → `expired` |
| `brokerRules.ts` | `buildOffer`, `validateResponse`, `buildResult`, `rememberUpdates`, `cancelResult`, `approveModes`, `decisionKindFor`, `parseQuestions`, `parsePlan`, `BROKER_MESSAGES` | Regeln architecture §5.2, rein |
| `promptQueue.ts` | `PromptQueue` | Queue mit `uuid`/`priority`, Übernahme über Lifecycle bzw. `user_message_uuids` |
| `summary.ts` | `summaryOf`, Titelregeln, `/rename`-Parser, Unterhaltungs-Helfer | rein |
| `mirror.ts` | `baseView`, `applyToMirror`, `readMirrorItems`, `emptyDetail`, `findToolCallIn` | Mirror-View, Log-Tail + Verlaufs-Fallback (A.3) |
| `recovery.ts` | `registryFacts`, `wasActive`, `interruptedToolCalls`, `cleanupOrphans`, `splitOrphanRecords`, `keepsOrphanRecord`, `OrphanDeps`, `OrphanResult` (`killed`/`gone`/`not_ours`/`unknown`/`failed`), `ORPHAN_START_TOLERANCE_MS` (5 s) | Serverstart, Waisen (C.8): Lebend-Vorfilter, eine gebündelte Abfrage, `unknown`/`failed` behalten den Record (R2-02, ADR-051); beendet werden der verifizierte `claude.exe`-Wurzelprozess (dann nichts weiter) bzw. exakt passende Prozesse (PID + Image + Startzeit) des letzten Herzschlag-Schnappschusses, jeder nach frischer Prüfung unmittelbar vor seinem Kill (WP22-06, ADR-081, ADR-093) |
| `processStore.ts` | `openProcessStore`, `createMemoryProcessStore`, `ProcessStore` (`add`, `remove`, `heartbeat`, `flush`), `processRecordSchema`/`ProcessRecord`/`ProcessRecordInput`, `processChildSchema`, `processesFileSchema`, `PROCESSES_FILE`, `PROCESSES_SCHEMA_VERSION`, `MAX_RECORDED_CHILDREN` | `processes.json` (`entryId`, PID, Image, Startzeit, `aliveAt`, `children`; `add` mit `flush`, `remove`/`heartbeat` entprellt) |
| `notifier.ts` | `chooseChannel`, `planNotification`, `decisionsCleared`, `isViewedByVisibleClient` | Benachrichtigungskanal (A.9), rein; mit nativen Toasts: kein Fenster bzw. Fenster ohne Web Notifications → nativer Toast (WP22-03) |
| `nativeToasts.ts` | `createNativeToasts`, `NativeToasts`, `DISABLED_NATIVE_TOASTS`, `TOAST_TEXTS`, `toastText`, `TOAST_FAILURE_THRESHOLD`, `TOAST_BACKOFF_MS`, `TOAST_BACKOFF_MAX_MS` | native Windows-Toasts der Engine (Texte en/de nach `settings.language`, nacheinander; ein deterministischer Fehler schaltet ab → Host-State `nativeNotifications: false`, andere zählen, ab dem dritten in Folge Pause mit Backoff, ADR-091); Phase 2: `toastShowOptions` → Klick-URI `parallax:` und `silent` nach den Einstellungen (ADR-109, WP-34) |
| `retry.ts` | `decideRetry`, `afterSuccessfulTurn`, `DEFAULT_AUTO_RETRY` | Auto-Retry nur nach Absturz im Leerlauf (ADR-025), rein |
| `models.ts` | `toModelCatalog`, `currentModelOption` | `supportedModels()` → `ModelOption[]` (tolerant) |
| `lib/` | `createSerial`, `Timers`/`createManualTimers`, `readGitBranch` | siehe `lib/README.md` |
| `testing/harness.ts` | `createEngineHarness`, `answerFromFixture`, `HARNESS_*` | Manager + FakeBackend + Doubles + virtuelle Uhr (Tests, WP-20); `proc` mit `info` (lebende Prozesse) und `queries`; Phase 2: Kataloge, Schlaf-Policy, Host-Befehle, `consoleLauncher`, `profileStore`, `toastLaunchUri` |
| `testing/consoleLauncher.ts` | `createTestConsoleLauncher({now, onOpen?})` | Test-Double des `ConsoleLauncher` (PIDs ab 60 000, `setState`, `failNext`, `unknownNext`) |
| `testing/memoryStores.ts`, `testing/memoryPublisher.ts` | `createMemoryStores`, `createMemoryPublisher` | Test-Doubles der Store-Ports und des `SessionPublisher` (WP-13a) |

Integrationstests: `fixtures.integration.test.ts` (alle aufgezeichneten Fixtures), `engine.integration.test.ts`
(Crash, Retry, Neustart, Rennen, Präsenz, Waisen, Shutdown), `commands.integration.test.ts` (Befehlstabelle),
`ws.integration.test.ts` (echter Hub über WebSocket), `phase2.integration.test.ts` (WP-31: Schlaf, Archiv/Pin,
Fast-Modus, Unterhaltungswechsel, Git, Kataloge, Settings-Wirkung, HostState), `phase2b.integration.test.ts`
(WP-34: Anhänge, Fortsetzen nach Rate-Limit, Toast-Felder, Profil-Caches), `external.integration.test.ts`
(WP-34: externe Konsole, Rückkehr, Neustart, Secrets).

Phase 2: Lebenszyklus, Archiv und Unterhaltungen `docs/wp/WP-31.md`; Konsole, Fortsetzen, Anhänge
und Toast-Klick `docs/wp/WP-34.md` (jeweils §2 inkl. Verdrahtung für WP-40).
