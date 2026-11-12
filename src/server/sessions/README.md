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
| `manager.ts` | `createSessionManager(deps)` → `SessionManager` (= `SessionSource` + `attachPublisher`, `start`, `shutdown`, `publishHostState`, `onProfileChanged`, `inspect`, `orphansDone`, `externalChecksDone`), `SessionManagerDeps` (u. a. `proc?: Partial<ProcDeps>`), `DEFAULT_SESSION_MANAGER_OPTIONS`, `HOST_STATE_DEBOUNCE_MS`, `RECOVERY_TAIL_ITEMS`, `SHUTDOWN_INTERRUPT_MS`, `profileCacheKey`, `EngineEntryInfo` (u. a. `scheduledTurn`, ADR-121) | Port `SessionSource`, Serverstart (Recovery, Waisen und Konsolen-Prüfung im Hintergrund), Herzschlag-Schnappschuss der Prozessbäume (`processSnapshotMs` 30 s, WP22-06), Leerlauf-Schlaf (ADR-105; nie für einen Prozess mit geplantem Turn, ADR-121), geänderte Profile verwerfen Modell-Katalog und Launch-Env (`onProfileChanged`, ADR-102); beim Start nur persistierte Kataloge, deren `profileKey` zum Profil passt (CR2-05, ADR-132), Shutdown (C.8, ADR-090: je Session `close()` und bis `shutdownKillAfterMs` 5 s danach warten, dann `taskkill`; wartende Sessions ohne Queue erst `interrupt`, wartende mit Queue/Hintergrund-Task sofort `taskkill` + `PROMPT_NOT_DELIVERED` – `shutdownCanEndTurn`; ab Beginn parallel dazu höchstens `lifecycleShutdownWaitMs` 10 s auf laufende Lifecycle-Operationen wie `openExternal` warten, R4-03; `SHUTDOWN_SWEEP_GRACE_MS` für den Rahmen; Stores flushen, `backend.dispose()`), Host-State, Präsenz, native Toasts (`toasts?: NativeToasts`) |
| `entryState.ts` | `EntryState`, `SessionManagerOptions` (u. a. `lifecycleShutdownWaitMs`, `freshContextResultMs`), `EngineStores` (`EngineCoreStores.decisions` ist ein `PlanIndexedDecisionStore`, CR3-09), `ProcDeps` (`isProcessAlive`, `queryProcesses`, `listProcesses`, `killProcessTree`; R2-02/03, WP22-06), `NormalizerFns`, `SleepPolicy`, `NEVER_SLEEP`, `settingsSleepPolicy` (`settings.idleSleep`), `EngineCore`; Gates (WP-30 §4.12): `EntryCommand`/`EntryCommandName`, `ARCHIVED_ALLOWED`, `EXTERNAL_ALLOWED`, `isExternal`, `assertEntryGate` (beim Eingang **und** erneut im Lifecycle-Lock, R4-01), `assertWithoutWork` („ohne Arbeit“, im Lock) | Zustand je Eintrag; der eine Op-Pfad `emit` (publizieren → Log → Mirror → `lastOrder`), Fakten nur über `reduceStatus`, Summary/Persistenz je Mikrotask gebündelt |
| `runtime.ts` | `SessionRuntime` (`scheduled`, `markScheduled`, `nextTurnResult` – WP61-03), `startRuntime`, `closeRuntime`, `deliverPrompt`, `READY_ATTEMPTS`, `SCHEDULING_TOOLS`, `isLoopPrompt` | ein `claude`-Prozess: Event-Schleife, Normalizer, Signale, `/clear`, Prozessende, Auto-Retry, Bereitschaft (`supportedModels`, zwei Versuche, sonst `error` `CLAUDE_CONTROL_FAILED`; R2-04, ADR-053); geplante Turns (ADR-121): ein Tool-Call `ScheduleWakeup`/`CronCreate` (auch streamend/Subagent) oder ein gesendeter Prompt, der mit `/loop` beginnt (erst nach erfolgreichem `send()`, CR2-09/ADR-131), markiert den Prozess bis zu seinem Ende; `startRuntime` lehnt externe Einträge ab (`SESSION_EXTERNAL`, R4-01) |
| `commands.ts` | `handleCommand`, `CommandEngine` (`hostCommands`, `settingsChanged`) | alle Befehle (§3.5.6, architecture §5.2); Phase 2: Host-Routing, Archiv-/External-Gates (beim Eingang und erneut im Lock, R4-01; `sendPrompt` ändert Retry, Plan und Prompt-Titel erst nach den Prüfungen im Lock, CR2-04/ADR-131), `setPinned`/`setArchived`/`setFastMode`/`switchConversation` (WP-31; der Wechsel löscht ein geplantes Fortsetzen, R4-08), `openExternal`/`reclaim`/`consoleCommand`/`continueAfterLimit`, Anhänge in `session.create`/`sendPrompt` (WP-34) |
| `attachments.ts` | `resolveAttachments`, `promptContent`, `PromptAttachments`, `NO_ATTACHMENTS` | Bild-Anhänge (ADR-103): Blob-Prüfung (`BLOB_NOT_FOUND`, `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`), Summe der Rohbytes ≤ `LIMITS.attachmentsTotalBytes` (ADR-125, `PAYLOAD_TOO_LARGE {bytes, max}` ohne `blobId`, vor dem base64), Prompt-Inhalt mit Bildern zuerst |
| `external.ts` | `openExternal`, `watchExternal`, `restoreExternal`, `returnFromExternal`, `consoleCommand`, `consoleState`, `consoleProcessOf`, `scrubConsoleReason`, `HANDOFF_IMPORT_SLACK_MS`, `CONSOLE_REASON_CHARS` | externe Konsole (ADR-104): im Lock Gate erneut prüfen (ein zweites `openExternal` → `SESSION_EXTERNAL`, R4-01), `checkCwd` und Konsolen-Spec vor dem Schließen (R4-09, CR2-02), Query schließen, nach Shutdown-Beginn nichts öffnen (R4-03), `claude --resume` über den `ConsoleLauncher`; geplantes Weiter und Auto-Retry erst nach geöffneter Konsole verwerfen (ADR-130), Überwachung, Rückkehr mit Import der Konsolen-Turns, Serverstart; Secrets der Konsolen-Env nie im Log |
| `continuePlan.ts` | `planContinue`, `cancelContinue`, `restoreContinue`, `CONTINUE_PROMPT`, `MAX_TIMER_DELAY_MS` | Fortsetzen nach Rate-Limit (ADR-112): `continueAt` + Status-Event `wakeup`, Gnadenfrist `continueGraceMs` beim Serverstart |
| `catalogStore.ts` | `openCatalogStore`, `createMemoryCatalogStore`, `CatalogStore` (`removeModels`, `removeLimit`), Schemas | Modell-Kataloge (je Katalog `profileKey`, CR2-05/ADR-132) und Abo-Limits je Profil (ADR-114): `model-catalogs.json`, `account-limits.json`; neuere Version → `StoreVersionTooNewError` |
| `commandCatalog.ts` | `toSlashCommands`, `createCommandCatalogStore`, `createMemoryCommandCatalogStore` | Slash-Befehle je Eintrag (ADR-108): `entries/<id>/commands.json`, tolerant gelesen |
| `broker.ts` | `createBroker(deps)` → `Broker`, `BrokerDeps`, `RespondResult`, `DEFAULT_RECORDS_KEEP` (200) | PermissionBroker (WP-13a): mehrere offene Entscheidungen je Session, Records/Pläne, Neustart → `expired` |
| `brokerRules.ts` | `buildOffer`, `validateResponse`, `buildResult`, `rememberUpdates`, `cancelResult`, `approveModes`, `decisionKindFor`, `parseQuestions`, `parsePlan`, `BROKER_MESSAGES` | Regeln architecture §5.2, rein |
| `promptQueue.ts` | `PromptQueue` | Queue mit `uuid`/`priority`, Übernahme über Lifecycle bzw. `user_message_uuids` |
| `summary.ts` | `summaryOf`, Titelregeln, `/rename`-Parser, Unterhaltungs-Helfer, `neutralizeAtMentions` (U+200B vor den `@`, die die CLI expandiert; WP61-01, ADR-155) | rein |
| `mirror.ts` | `baseView`, `applyToMirror`, `readMirrorItems`, `emptyDetail`, `findToolCallIn` | Mirror-View, Log-Tail + Verlaufs-Fallback (A.3) |
| `recovery.ts` | `registryFacts`, `wasActive`, `interruptedToolCalls`, `cleanupOrphans`, `splitOrphanRecords`, `keepsOrphanRecord`, `OrphanDeps`, `OrphanResult` (`killed`/`gone`/`not_ours`/`unknown`/`failed`), `ORPHAN_START_TOLERANCE_MS` (5 s) | Serverstart, Waisen (C.8): Lebend-Vorfilter, eine gebündelte Abfrage, `unknown`/`failed` behalten den Record (R2-02, ADR-051); beendet werden der verifizierte `claude.exe`-Wurzelprozess (dann nichts weiter) bzw. exakt passende Prozesse (PID + Image + Startzeit) des letzten Herzschlag-Schnappschusses, jeder nach frischer Prüfung unmittelbar vor seinem Kill (WP22-06, ADR-081, ADR-093) |
| `processStore.ts` | `openProcessStore`, `createMemoryProcessStore`, `ProcessStore` (`add`, `remove`, `heartbeat`, `flush`), `processRecordSchema`/`ProcessRecord`/`ProcessRecordInput`, `processChildSchema`, `processesFileSchema`, `PROCESSES_FILE`, `PROCESSES_SCHEMA_VERSION`, `MAX_RECORDED_CHILDREN` | `processes.json` (`entryId`, PID, Image, Startzeit, `aliveAt`, `children`; `add` mit `flush`, `remove`/`heartbeat` entprellt) |
| `notifier.ts` | `chooseChannel(clients, entryId, nativeAvailable?, rules?)`, `ChannelRules`/`DEFAULT_CHANNEL_RULES` (`focusedElsewhere`, `focusedDoneMinMs`), `NotificationChannel`, `planNotification`, `PlannedNotification`, `decisionsCleared`, `isViewedByVisibleClient`, `isWatchedByFocusedClient` (fokussiertes, sichtbares Fenster zeigt den Eintrag → kein Leerlauf-Schlaf, ADR-105); `chooseChannelWithReason` (`ChannelChoice`, `ChannelReason`, `TieBreak`), `routeNotification` (`NotificationRoute`, `NotificationFilter`), `routeChannel` (`RouteChannel`), `presenceSummary` (`ClientPresenceSummary`) – Grund, Gleichstands-Stufe und Präsenz für die `debug`-Zeile `notification route` der Engine (WP41-04); Ziel bei Gleichstand: Web Notifications → sichtbar → zuletzt verbunden (ADR-129) | Benachrichtigungskanal (A.9), rein; mit nativen Toasts: kein Fenster bzw. Fenster ohne Web Notifications → nativer Toast (WP22-03) |
| `nativeToasts.ts` | `createNativeToasts`, `NativeToasts`, `DISABLED_NATIVE_TOASTS`, `TOAST_TEXTS`, `toastText`, `TOAST_FAILURE_THRESHOLD`, `TOAST_BACKOFF_MS`, `TOAST_BACKOFF_MAX_MS`, `toastShowOptions`, `ToastShowOptions` | native Windows-Toasts der Engine (Texte en/de nach `settings.language`, nacheinander; ein deterministischer Fehler schaltet ab → Host-State `nativeNotifications: false`, andere zählen, ab dem dritten in Folge Pause mit Backoff, ADR-091); Phase 2: `toastShowOptions(entryId, kind, settings, system, windowNotified?)` → Klick-URI `parallax:` und `silent` nach den Einstellungen (ADR-109, WP-34), außerdem stumm, wenn ein Fenster dieselbe Meldung bekommt und selbst klingt (ADR-122) |
| `retry.ts` | `decideRetry`, `afterSuccessfulTurn`, `DEFAULT_AUTO_RETRY` | Auto-Retry nur nach Absturz im Leerlauf (ADR-025), rein |
| `models.ts` | `toModelCatalog`, `currentModelOption` | `supportedModels()` → `ModelOption[]` (tolerant) |
| `lib/` | `createSerial`, `Timers`/`createManualTimers`, `readGitBranch` (Rückfall `git branch --show-current` im Repo ohne Commit, V3-11) | siehe `lib/README.md` |
| `testing/harness.ts` | `createEngineHarness`, `answerFromFixture`, `HARNESS_*` | Manager + FakeBackend + Doubles + virtuelle Uhr (Tests, WP-20); `proc` mit `info` (lebende Prozesse) und `queries`; Phase 2: Kataloge, Schlaf-Policy, Host-Befehle, `consoleLauncher`, `profileStore`, `toastLaunchUri` |
| `testing/consoleLauncher.ts` | `createTestConsoleLauncher({now, onOpen?})`, `TestConsoleLauncher`, `ConsoleHold`, `TEST_CONSOLE_FIRST_PID` | Test-Double des `ConsoleLauncher` (PIDs ab 60 000, `setState`, `failNext`, `unknownNext`, `holdNext()` hält das nächste `open()` an, bis der Test es freigibt – langsame PowerShell, R4-01/R4-03) |
| `testing/memoryStores.ts`, `testing/memoryPublisher.ts` | `createMemoryStores`, `createMemoryPublisher` | Test-Doubles der Store-Ports und des `SessionPublisher` (WP-13a) |

Integrationstests: `fixtures.integration.test.ts` (alle aufgezeichneten Fixtures), `engine.integration.test.ts`
(Crash, Retry, Neustart, Rennen, Präsenz, Waisen, Shutdown), `commands.integration.test.ts` (Befehlstabelle),
`ws.integration.test.ts` (echter Hub über WebSocket), `phase2.integration.test.ts` (WP-31: Schlaf inkl. geplanter
Turns ADR-121, Archiv/Pin, Fast-Modus, Unterhaltungswechsel, Git, Kataloge, Settings-Wirkung, HostState),
`phase2b.integration.test.ts` (WP-34: Anhänge inkl. Summengrenze, Fortsetzen nach Rate-Limit, Toast-Felder,
Profil-Caches inkl. Profil-Schlüssel nach Neustart, CR2-05), `external.integration.test.ts` (WP-34: externe
Konsole, Rückkehr, Neustart, Secrets; Fix-Runde R4: Gate im Lock, Shutdown während `open()`, `checkCwd`; Fix-Runde
CR2: Plan/Retry bei gescheitertem Öffnen, abgewiesener Prompt im Lock).

Phase 2: Lebenszyklus, Archiv und Unterhaltungen `docs/wp/WP-31.md`; Konsole, Fortsetzen, Anhänge
und Toast-Klick `docs/wp/WP-34.md` (jeweils §2 inkl. Verdrahtung für WP-40).

## Phase 3 – Engine (WP-51)

Ergebnis, Abbildung der `todos` und Verdrahtung für WP-60: `docs/wp/WP-51.md` §2. Die Zeile
`attachments.ts` oben gilt in dieser Fassung.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `attachments.ts` | `checkAttachments`, `materializeAttachments`, `promptContent`, `sentText`, `checkPastes`, `resolveAttachments` (Kompatibilität, `files` erlaubt), `PromptAttachments`, `NO_ATTACHMENTS`, `ATTACHED_FILES_HEADER`, `PDF_MEDIA_TYPE`, `FILE_MEDIA_TYPE` | Anhänge (ADR-103, ADR-146): Bild → `image`, PDF → `document` (≤ `pdfBytes`), `application/octet-stream` → `AttachmentFileStore.materialize` (≤ `fileAttachmentBytes`; ohne Store `UNSUPPORTED_MEDIA_TYPE`) und Block `Attached files:` am Ende des **gesendeten** Texts; Bild + PDF ≤ `attachmentsTotalBytes`; Pastes müssen im Text stehen (`VALIDATION_FAILED {reason 'paste_not_in_text', index}`) |
| `detailTracker.ts` | `DetailTracker`, `DetailContext`, `TODO_TEXT_CHARS`, `PLAN_FILE_CANDIDATES` | `todos` (ADR-149: `TodoWrite` bzw. `TaskCreate`/`TaskUpdate`/`TaskList`) und `planFile` (ADR-148, Regeln a/b) aus fertigen Haupt-Tool-Calls; `EntryState` füttert ihn im Op-Pfad und sät ihn beim Aufbau des Mirrors |
| `freshContext.ts` | `approveFreshContext`, `FreshContextRequest` | „Mit frischem Kontext umsetzen“ (ADR-147, ADR-155): Prüfungen; Retry-Abbruch erst nach Annahme im Lock (CR3-08), deny + interrupt, höchstens `freshContextResultMs` auf das `result` des Planungs-Turns warten (WP61-03), Unterhaltung endet mit `fresh_session`, neue ohne Resume, erster Prompt `freshContextPrompt` (`summary.ts`, `@` neutralisiert, WP61-01) |
| `planIndex.ts` | `withPlanIndex`, `PlanIndexedDecisionStore` | bekannte Planversionen je Serverlauf (gespeichert oder gelesen); `planStored` ohne erneutes Lesen, unbekannte einmal (CR3-09, ADR-155); der Manager umhüllt `stores.decisions` |

## Nutzer-Feedback 1 (WP-63)

- **`session.remove {entryId}`** (`commands.ts` `removeSession`): Retry abbrechen, im Lifecycle-Lock
  geplantes Fortsetzen löschen, laufenden Prozess wie `session.close` beenden (`closeRuntime(…,
  'remove')` – offene Entscheidungen verfallen als `cancelled`/`process_exit`), dann
  `CommandEngine.removeEntry` → Manager: `EntryState.removed = true` (kein `emit`/`flush`, kein Start
  mehr – `startRuntime` und `assertEntryGate` antworten `ENTRY_NOT_FOUND`), Timer weg, aus Speicher
  und Registry (`sessions.json`), Benachrichtigungen und Engine-Warnung weg, `summary.remove` an alle
  (der Hub schickt Abonnenten `session.unavailable`), Host-State (`entryCount`). Erlaubt auch für
  archivierte und externe Einträge.
- **Auf der Platte bleibt alles:** das claude-Transkript (`<configDir>\projects\…\<sessionId>.jsonl`
  des Profils), `PARALLAX_HOME\entries\<entryId>\` (Transkript-Log `*.transcript.jsonl`,
  `decisions.json`, `plans\v<n>.md`, `attachments\`, Datei-Index, `commands.json`) und die Blobs
  (`PARALLAX_HOME\blobs\`). Kein Aufräumlauf beim Start löscht sie (geprüft: gelöscht werden nur der
  Web-Schnappschuss, Lock-Datei und `.bak` der Auth; die Waisen-Bereinigung betrifft Prozesse).
  „Wiederherstellen“ gibt es nicht; `claude --resume <sessionId>` funktioniert weiter.
- **Context:** `ContextGauge.autoCompactThreshold`/`isAutoCompactEnabled` aus `getContextUsage`; die
  Schätzung während eines Turns übernimmt den letzten bekannten Wert (`runtime.ts`).
- **Rate-Limit:** nur `rejected` wird ein Transkript-Item; `allowed`/`allowed_warning` speisen nur die
  Limit-Leiste (Signal → `setAccountLimit`).
- Integrationstest: `wp63.integration.test.ts`.

## Remote Control (WP-64)

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `remoteControl.ts` | `RemoteState`, `REMOTE_OFF`, `nextRemoteState`, `onBridgeState`, `bridgeOf`, `enableRemote`, `remoteControlAfterReady`, `setRemoteControl`, `endRemoteBeforeClose`, `remoteProcessEnded` | Wunsch `Entry.remoteControlWanted` (persistiert) und Live-Zustand `EntryState.remote` (nur mit Prozess: `bridge_state` ready → `connecting`, connected → `connected`, failed nicht-terminal → `reconnecting`, terminal → `failed` `REMOTE_CONTROL_FAILED`, policy_disabled → `failed` `REMOTE_CONTROL_POLICY_DISABLED`); Einschalten sofort bei laufendem, bereitem Prozess, sonst nach der nächsten Bereitschaft mit `reattachSessionId` der aktuellen Unterhaltung (gleicher Link); ein gescheitertes Reattach einmal ohne; Generationen verwerfen veraltete Antworten; Fehler beim Einschalten → `failed` mit Fehler (der Befehl gelingt) |

- **Neue Einträge:** `settings.remoteControl.newSessions` – `on`/`off` sofort, `follow_claude` startet mit
  dem zuletzt gelesenen `remoteControlAtStartup` des Profils und übernimmt nach der ersten Bereitschaft
  den frisch gelesenen Wert (`EntryState.followClaudeDefault`; eine eigene Wahl vorher gewinnt). Jede
  Bereitschaft liest den Wert (`readRemoteControlDefault`) → Host-State `remoteControlDefault`
  (Standardprofil, sofort veröffentlicht).
- **Bridge je Unterhaltung:** `Conversation.bridgeSessionId`/`sessionUrl`; `/clear` und frischer Kontext
  erben die Bridge (`bridgeOf`, gleicher Link); Ausschalten, Archivieren und Entfernen vergessen sie
  (`endRemoteBeforeClose` schaltet vorher im laufenden Prozess ab). Schließen, Absturz und Serverneustart
  behalten Wunsch und Link (`keepSessionOnExit`), die Summary zeigt den gespeicherten Link.
- **Kein Leerlauf-Schlaf** bei `connecting`/`connected`/`reconnecting` (`sleepEligible`, ADR-105 erweitert;
  `EntryState.setRemote` plant den Schlaf neu, wenn die Bridge kommt oder geht).
- **Turns aus der Claude-App:** der Normalizer liefert das `user`-Item mit `source: 'remote'`; Status über
  `session_state`/`command_lifecycle` wie sonst, die Queue ignoriert fremde uuids, Kosten über `result`.
- **„In der Claude-App beantwortet“:** `BrokerDeps.answeredElsewhere` – bricht die CLI eine Anfrage ab,
  während die Bridge `connected`/`reconnecting` ist, wird das Ergebnis `answered_elsewhere` statt
  `cancelled` (Heuristik; ein Interrupt beendet Entscheidungen vorher selbst).
- Befehl `session.setRemoteControl` (nicht für archivierte/externe Einträge). Harness-Option
  `remoteControl` (`FakeBackendOptions.remoteControl`). Integrationstest:
  `remoteControl.integration.test.ts`.

Außerdem: `EngineStores.attachments?` (`entryState.ts`, fehlt → `null`), `attachmentsDir` bei jedem
`startRuntime` (Fehler → Warnung, `null`), `session.stopTask`/`plan.list` (über `planStored` des Plan-Index, CR3-09)/`plan.read` in `commands.ts`,
Broker `check`/`latestPlanVersion`/`latestPlanFilePath`/`planRecords`/`loadLastPlan` und Ergebnis
`fresh-context`, `deliverPrompt` setzt ein abgelehntes `/rename X` zurück (CR2). Harness-Option
`attachments: false` (Engine ohne Anhang-Store). Integrationstest: `phase3.integration.test.ts`.
