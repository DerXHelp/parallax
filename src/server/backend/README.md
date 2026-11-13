# src/server/backend – AgentBackend-Implementierungen (WP-13)

Port-Interface `AgentBackend` (Contract aus WP-02) mit `SdkBackend` (echtes
`@anthropic-ai/claude-agent-sdk`, installiertes `claude`) und `FakeBackend` (Szenario-DSL,
spielt Fixtures ab, wartet auf Entscheidungen, simuliert Crashes). `pnpm dev` nutzt das
FakeBackend (`--backend=fake`), `pnpm dev:live` das SdkBackend.

- **Ports (eingefroren seit WP-02, Änderung nur per Contract-Änderung):** `types.ts` –
  `AgentBackend`, `AgentSession`, `BackendEvent`, `PermissionRequest`, `OutgoingPrompt`,
  Verlaufstypen; `fixture.ts` – Fixture-Format v1 (einzige Quelle, `scripts/record/format.ts`
  re-exportiert), `parseFixture`, `loadFixture`, Payload-Views. Beide samt Tests gehören nicht WP-13.
- Alle übrigen Dateien hier gehören WP-13. FakeBackend-Szenarien ohne aufgezeichnetes Fixture als
  `.ts`-Module in `fake/` (Fixture-Format v1, mit `fixtureEventSchema` geprüft), nie `.jsonl` (R0-06).
- Spawn über `lib/process.ts`, Prozessbaum-Kill über `killProcessTree` (C.8); der Spawn-Wrapper liest
  stderr selbst (F.16).
- R2-Fixes: SdkBackend-Bereitschaft (`supportedModels`, auch vor den C.1-Flag-Settings) mit eigenem
  Timeout `readyMs` 60 s (R2-04, ADR-053); Betas nur mit gültigem Header-Namen (R2-11); FakeBackend
  behält höchstens `keepSessions` (50) beendete Sessions/Starts (R2-12). Kleine Helfer aus
  `lib/async.ts` (ADR-055).
- Phase 2 (WP-31/WP-34, Ergebnisse `docs/wp/WP-31.md` §2.1, `docs/wp/WP-34.md`): Fast-Modus je
  Eintrag (`StartSessionRequest.fastMode`) als Flag-Setting neben `autoCompactWindow` –
  `startFlagSettings(req)` inline in `settings`, mit Settings-Datei des Profils per
  `flagSettingsAfterStart(req)` → `applyFlagSettings` nach der Bereitschaft. FakeBackend: Terminal-
  Befehle im `init` (`FAKE_TERMINAL_COMMANDS`), `fastMode` im Script-Zustand, simulierte externe
  Konsole (`simulateConsoleTurn`), Bild-Anhänge und Rate-Limit im Dev-Szenario – Details in
  `fake/README.md`. Fake-Integration (`fake/integration.ts`, `createFakeClaudeIntegration`): Option
  `launchEnv` → Launch-Specs nur mit den Suchvariablen `FAKE_LAUNCH_ENV_KEYS` (PATH, PATHEXT,
  SystemRoot …; keine Secrets, keine Session-Marker), damit der Fake-Server den Git-Branch findet
  (V3-11; `app/compose.ts` übergibt `process.env`, Tests/Harness nichts).

Design: `docs/wp/WP-13.md` §3.1–3.3; Ergebnisse: `docs/wp/WP-13a.md` (Fake), `docs/wp/WP-13c.md` (SDK).

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `sdkBackend.ts` | `createSdkBackend(deps?)` → `AgentBackend & {kind: 'sdk'}`, `SdkBackendDeps` (inkl. `logger?`), `SdkTimeouts`/`SDK_TIMEOUTS` (`closeGraceMs` 5 s, `killWaitMs` 5 s, `controlMs` 15 s, `contextFullMs` 60 s, `readyMs` 60 s, `iteratorAfterExitMs` 2 s, `titleMs` 60 s, `sideQuestionMs` 120 s, `infoMs` 30 s, `infoActionMs` 60 s), `SdkQueryHandle`/`SdkQueryFn` (Test-Naht), `withTimeout`, `toSdkUserMessage`, `stillQueuedOf`, `PERMISSION_FAILURE_MESSAGE` | Port gegen das installierte `claude` über das Agent SDK; nur Typ-Importe des SDK, `loadAgentSdk()` lädt es per `import()` – `app/compose.ts` ruft das nur bei `--backend=sdk` auf (seit WP-20c auch im esbuild-Bundle lazy, `app/bundle.test.ts`); `debug`-Zeile `credentialExpiresAt` beim ersten `result` je Prozess (WP61-04, ADR-156) |
| `sdkOptions.ts` | `buildQueryOptions`, `startFlagSettings`, `flagSettingsAfterStart`, `optionIssues`, `QueryOptionHooks`, `SETTING_SOURCES` | reine Abbildung `StartSessionRequest` → SDK-`Options` (Tabelle in `WP-13c.md`); Flag-Settings (C.1: `autoCompactWindow`, Phase 2: `fastMode`; kein `todoFeatureEnabled`, WP61-02/ADR-156) inline, mit Settings-Datei erst nach der Bereitschaft; ohne Wert keine `settings`-Option; WP-69: immer `includeHookEvents: true` (jeder Hook-Lauf als `hook_started`/`hook_response`, wirkt ab dem nächsten Prozessstart) |
| `overview.ts` | `titleOf`, `titleAnswerSchema`, `usageLimitsOf`, `usageAnswerSchema`, `KNOWN_USAGE_WINDOWS` | WP-65: SDK-Grenze von `generateSessionTitle` (intern in 0.3.322) und der experimentellen Nutzungsabfrage (`usage_EXPERIMENTAL…`): tolerant (zod), `utilization` 0–100 → Anteil 0–1, `extra_usage` → Fenster `overage`, null-Fenster bekannter Namen als `cleared`; `rate_limits_available: false` → null. `AgentSession.generateTitle`/`backgroundTasks`/`readUsage` (SdkBackend und FakeBackend) |
| `sideQuestion.ts` | `sideAnswerOf`, `sideAnswerSchema`, `sideQuestionFailure`, `controlRetryOf`, `controlProgressSchema`, `withdrawnOf`, `SIDE_QUESTION_BUSY`, `SIDE_ANSWER_CHARS` | WP-66: SDK-Grenze von `askSideQuestion` und `cancelAsyncMessage` (beide intern in 0.3.322): Antwort `{response, synthetic, refusalFallback?}` tolerant (zod; `null` = keine Antwort möglich, unbekannte Form → `unavailable`), `errorCode`/Meldung `side_question_busy` → `busy`, eigener Abbruch → `cancelled`; `system/control_request_progress api_retry` → Zähler. SdkBackend: Zeitlimit `sideQuestionMs` (120 s, danach Abbruch = `control_cancel_request`), `api_retry` geht nur an die einzige offene Seitenfrage, wenn keine Titel-Anfrage läuft (die request_id kennt der Aufrufer nicht). `AgentSession.askSideQuestion`/`withdrawQueued` (SdkBackend und FakeBackend) |
| `sessionInfo.ts` | `sessionInfoOf`, `sessionInfoFailure`, `exportFileName`, `clip`, `ParsedSessionInfo` | WP-67: SDK-Grenze der Session-Info – `getStatus`, `getMemoryDialog`, `getSkillsDialog`, `getHooksListing`, `listPermissionRules`, `exportConversation` (intern in 0.3.322) und `mcpServerStatus` (typisiert); Rohformen der CLI 2.1.323 → Anzeigeformen aus `@shared/model` 5.15, tolerant (zod): eine Zeile, die nicht passt, fällt weg (gezählt), unbekannte Felder nur als Schlüssel gemeldet (nie Werte – Status-Zeilen enthalten Kontodaten), unbekannte skalare Top-Level-Felder werden „label: value“-Zeilen (`extra`), Listen ≤ 1000, Texte ≤ 8000, Export ≤ 2 Mio. Zeichen (`truncated`, `totalChars`), Dateiname Windows-sicher mit `.txt`; „unsupported subtype“/„is not available in this build|on this connection|in a cloud-hosted session“ → `unavailable`. SdkBackend: `readInfo` (fehlende Methode/Ablehnung/unbekannte Form → null, je Grund einmal `info` geloggt, danach `debug`; sonst reject), `mcpAction` (`reconnectMcpServer`/`toggleMcpServer`), `reload` (`reloadSkills`/`reloadPlugins`). Hook-`editable` und MCP-`config` (außer `type`) werden nie weitergegeben |
| `remoteControl.ts` | `remoteControlAnswerSchema`, `toRemoteControlInfo`, `remoteControlDefaultOf`, `remoteControlErrorOf` | WP-64: SDK-Grenze von Remote Control – Antwort von `enableRemoteControl` und `getSettings().effective.remoteControlAtStartup` tolerant per zod, Link nur `https://claude.ai`, Control-Fehler (`errorCode`) → `REMOTE_CONTROL_AUTH`/`POLICY_DISABLED`/`FAILED {reason}`, „unsupported subtype“ → `UNAVAILABLE`; SdkBackend prüft die internen Methoden zur Laufzeit (fehlen → `UNAVAILABLE`), immer `keepSessionOnExit` |
| `login.ts` | `createLoginSession`, `loginStartOf`, `loginResultOf`, `loginErrorOf`, `hasLoginMethods`, `LOGIN_METHODS`, `LoginMethodMissing`, `LoginProcess`, `LoginTimeouts`, `LoginQueryMethods` | WP-70: SDK-Grenze der Anmeldung – interne Methoden `claudeAuthenticate`/`claudeOAuthCallback`/`claudeOAuthWaitForCompletion` (Laufzeitprüfung, fehlen → `LOGIN_UNAVAILABLE`), Links nur https, Abschluss-Antwort per zod nur `subscriptionType` (ADR-190), CLI-Fehlertexte → `LOGIN_BLOCKED`/`LOGIN_FAILED {reason}` (nie geloggt). SdkBackend: `startLogin` startet einen Prozess im Anmelde-Modus (neutrales `cwd`, `settingSources: []`, stderr nur als Länge im Log, ADR-188); FakeBackend: `fake/login.ts` |
| `outputStyle.ts` | `outputStylesOf`, `OUTPUT_STYLE_CHARS`, `OUTPUT_STYLES_MAX` | WP-70: Stil und Liste aus `initializationResult` tolerant (zod); `AgentSession.readOutputStyles`/`setOutputStyle` (`updateSettings('localSettings', {outputStyle})`, nur dieser Schlüssel, ADR-191); FakeBackend: `fake/outputStyle.ts` |
| `spawn.ts` | `createSpawner(opts)`, `SpawnerOptions`, `definedEnv` | Spawn-Wrapper über `spawnHidden` (PID + Startzeit, stderr immer gelesen, Baum-Kill) |
| `permissionRequest.ts` | `toPermissionRequest`, `permissionUpdateSchema` | `canUseTool(toolName, input, options)` → Port `PermissionRequest` (tolerant, wirft nie; SdkBackend und FakeBackend) |
| `history/parse.ts` | `toHistoryMessages`, `mergeHistory`, `toSessionInfo` | Verlauf/Session-Infos des SDK → Port-Typen (tolerant) |
| `history/pool.ts`, `history/workerSource.ts` | `createHistoryPool`, `HistoryPool`, `historyWorkerKey`, `HISTORY_TIMEOUT_MS` (30 s), `HISTORY_IDLE_MS` (60 s); `HISTORY_WORKER_SOURCE` | Verlaufs-Worker je Config-Ordner (`CLAUDE_CONFIG_DIR` isoliert); WP-69: Op `subagentSlice` – `getSubagentMessages` im Worker, nur die Nachrichten ab einem Index plus uuid davor/zuletzt kreuzen den Thread (`toSubagentSlice` in `history/parse.ts`). Port `AgentBackend.readSubagentHistory` (SdkBackend über den Pool, FakeBackend aus dem Fake-Verlauf) |
| `lib/asyncQueue.ts` | `AsyncQueue<T>` | ein Produzent, ein Konsument (`AgentSession.events`, Streaming-Input) |
| `fakeBackend.ts` | `createFakeBackend(options?)`, `eventsScenario`, `fixtureScenario`, `DEFAULT_FAKE_PID_BASE`, `DEFAULT_FAKE_MAX_DELAY_MS`, `DEFAULT_FAKE_KEEP_SESSIONS` (50); Re-Exporte aus `fake/` (`interactiveScenario`, `createFakeHistoryStore`, `SessionStopped`, `TurnInterrupted`, `randomIds`, `sequentialIds`, `FAKE_CONSOLE_PROMPT`, `fakeConsoleAnswer`, `FAKE_FRESH_SKILL`, `FAKE_INFO_ACTION_ERROR`, Typen) | Port ohne `claude`; Phase 2 `simulateConsoleTurn(sessionId, at, text?)` (WP-34); Bausteine in `fake/` (eigene `fake/README.md`) |
