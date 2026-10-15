# WP-13a – FakeBackend, PermissionBroker, Basismodule, Test-Doubles

> Welle 1b, Teilpaket von WP-13 (verbindliches Design: `docs/wp/WP-13.md`), kritischer Pfad
> 12 → **13** → 20 → 22. Worktree `.worktrees/wp-13a`, Branch `wp/13a`, Basis `main` = `c7122c9`.
> Kein Live-`claude`, nur Fixtures und synthetische Szenarien.

## Auftrag (sinngemäß)

- **Zuerst** die drei Basismodule aus WP-13 §3.1 (`backend/lib/asyncQueue.ts`,
  `backend/permissionRequest.ts`, `backend/history/parse.ts`) samt Tests als eigener erster Commit
  `WP-13a: Basismodule` – 13c (SdkBackend) baut darauf auf.
- **FakeBackend** (`backend/fakeBackend.ts`, `backend/fake/**`): Abspieler für Fixture-Format v1 mit
  den Toren input / canUseTool / control interrupt / close, Crash und Abort, Zeitraffer,
  UUID-Abbildung; DSL auf den WP-12-Frame-Fabriken; interaktives Dev-Szenario mit
  Schlüsselwörtern; Fake-Antworten, `FakeHistoryStore`, `createFakeClaudeIntegration`,
  synthetische Engine-Szenarien, Testhilfen.
- **PermissionBroker** (`sessions/brokerRules.ts`, `sessions/broker.ts`): Regeltabellen §3.4
  vollständig (Angebot, `PermissionResult` aus Absichten mit vier Zielen, `setMode` stets
  `destination:'session'`, Prüfungen, Abbruch), Queue mehrerer Entscheidungen mit Fragesteller,
  erster Klick gewinnt synchron, `signal`-Abbruch, Persistenz/Restore/Freeze/`expired`,
  AskUserQuestion- und ExitPlanMode-Formate laut Findings, deny+interrupt vor dem Interrupt.
- **Test-Doubles** `sessions/testing/{memoryStores,memoryPublisher}.ts` für 13b und WP-20.
- **Abnahme:** alle 12 Fixtures laufen mit `fixtureDecisionResponder` durch das FakeBackend und
  liefern exakt die aufgezeichnete `message`-Folge (nach UUID-Abbildung) ohne Diagnosen; Tore,
  Crash/Abort getestet; DSL-Bausteine und `backend/fake/*.ts` bestehen `fixtureEventSchema` und den
  echten Normalizer; Broker-Regeltabellen vollständig; Persistenz/Restore/Freeze getestet;
  `pnpm check` (2×) und `pnpm build` grün; `git diff --stat main...HEAD` nur in Besitz-Pfaden.

**Besitz-Pfade:** WP-13 §4 Zeile 13a (+ jeweils `*.test.ts`) und diese Datei. Tabu: alles andere
(13b-/13c-Dateien, `src/shared/**`, alle `ports.ts`, `backend/{types,fixture}.ts`, WP-10/11/12-Code,
`package.json`, Lockfile, Root-Configs, `docs/progress.md`, `CLAUDE.md`).

---

## Ergebnis (Umsetzung)

### Commits

| Commit | Inhalt |
|---|---|
| `1764e4d` `WP-13a: Basismodule` | `AsyncQueue`, `toPermissionRequest`, `history/parse` + Tests (13c holt genau diesen Commit) |
| `dc6266e` `WP-13a: PermissionBroker und Test-Doubles` | `brokerRules`, `broker`, `memoryStores`, `memoryPublisher` + Tests |
| letzter Commit `WP-13a: FakeBackend und PermissionBroker` | FakeBackend, `backend/fake/**`, dieses Dokument |

### Module und Exporte

| Datei | Exporte |
|---|---|
| `backend/lib/asyncQueue.ts` | `AsyncQueue<T>` (`push`, `end(error?)`, `ended`, `size`, ein Konsument; `break` verwirft den Puffer, spätere `push` werden ignoriert) |
| `backend/permissionRequest.ts` | `toPermissionRequest(toolName, input, options)`, `permissionUpdateSchema` (zod-Sicht auf SDK `PermissionUpdate`) |
| `backend/history/parse.ts` | `toHistoryMessages(raw)` (füllt `origin`), `mergeHistory(main, subagents)`, `toSessionInfo(raw)` (füllt `firstPrompt`) |
| `backend/fakeBackend.ts` | `createFakeBackend`, `eventsScenario`, `fixtureScenario`, `interactiveScenario`, `createFakeHistoryStore`, `sequentialIds`, `randomIds`, `SessionStopped`, `TurnInterrupted`, `DEFAULT_FAKE_PID_BASE`, `DEFAULT_FAKE_MAX_DELAY_MS`; Typen `FakeBackend`, `FakeBackendOptions`, `FakeScenario`, `FakeEventsOptions`, `FakeSessionHandle`, `FakeSessionState`, `FakeDiagnostic(Kind)`, `FakeScriptContext`, `FakeScriptState`, `FakeIds`, `FakeHistoryStore` |
| `backend/fake/session.ts` | `FakeSession` (intern; Handle und `AgentSession` in einem) |
| `backend/fake/player.ts` | `EventPlayer`, `compareDecision` |
| `backend/fake/common.ts` | `SessionStopped`, `TurnInterrupted`, `realSetImmediate`, `nextMacrotask`, `mapUuids`, `promptText`, `promptContent`, `HANDLER_ERROR_RESULT` |
| `backend/fake/dsl.ts` | Kontext `dslContext`, `sequentialIds`, `randomIds`, `events`, `toEvents`, `frame`, `patch`; Bausteine `input`, `turnOpen`, `turnClose`, `textTurn`, `assistantMessage`, `streamedText`, `thinkingBlock`, `toolUseBlock`, `toolResultMessage`, `permissionStep`, `expectDecision`, `questionStep`, `planStep`, `subagentLaunch`, `subagentEnd`, `subagentRun`, `interruptEpilogue`, `clearCommand`, `renameCommand`, `startupFailure`, `assistantErrorTurn`, `crash`, `closeGate`; Blöcke `textBlock`, `thinkingContent`, `toolUseContent` |
| `backend/fake/interactive.ts` | `interactiveScenario()` |
| `backend/fake/defaults.ts` | `fakeContextUsage(turns, model?)`, `FAKE_MODELS`, `FAKE_COMMANDS`, `FAKE_CONTEXT_WINDOW`, `resolveFakeModel` |
| `backend/fake/history.ts` | `createFakeHistoryStore()`, Typ `FakeHistoryStore` |
| `backend/fake/integration.ts` | `createFakeClaudeIntegration({profiles?, allowsBypass?, now?})` → `FakeClaudeIntegration` (+ `launches`, `setLaunchError`), `FAKE_CLAUDE_PATH`, `FAKE_CLAUDE_VERSION` |
| `backend/fake/testing.ts` | `loadFixtureScenario`, `fixtureDecisionResponder`, `recordedResult`, `recordedPrompts`, `driveFixtureSession` |
| `backend/fake/synthetic.ts` | `FAKE_SCENARIOS` (8 Szenarien, je Datei `export const events`) |
| `sessions/brokerRules.ts` | `decisionKindFor`, `parseQuestions`, `parsePlan`, `buildOffer`, `approveModes`, `validateResponse`, `buildResult`, `rememberUpdates`, `cancelResult`, `BROKER_MESSAGES`, Typen `CancelReason`, `ValidationTarget`, `BuiltResult` |
| `sessions/broker.ts` | `createBroker(deps)`, `DEFAULT_RECORDS_KEEP`, Typen `Broker`, `BrokerDeps`, `RespondResult`, `CancelReason` (genau nach §3.4) |
| `sessions/testing/memoryStores.ts` | `createMemoryStores(seed?, {readDelayMs?, now?})` → `{registry, transcripts, decisions, blobs, settings, warnings}` mit Inspektion (`lines`, `items`, `records`, `plan`, Zähler) |
| `sessions/testing/memoryPublisher.ts` | `createMemoryPublisher({validate?})` → Protokolle (`ops`, `allOps`, `summaries`, `hostStates`, `notifications`, `cleared`, `closedWith`), `opsOf`, `summaryOf`, `setPresence`, `setViewBase`/`view`, `waitFor` |

### FakeBackend – Verhalten (ergänzt §3.3)

- **Ein Spieler** (`EventPlayer`) für Fixtures, synthetische Szenarien, DSL-Folgen im Script-Modus
  und Echo-Turns. Der Hauptspieler eines Events-Szenarios wird schon im Konstruktor registriert:
  ein `interrupt()` direkt nach `start()` findet ein kommendes Interrupt-Tor.
- **Tore:** `input` (nächstes `send()`, vorher gesendete werden gepuffert; `priority:'now'` überholt
  wartende `'next'`), `canUseTool` (bis zur Antwort; `payload.fake.parallel` → Join am `decision`),
  `control interrupt` (bis `interrupt()`; ein `interrupt()` **vor** dem Tor, ohne blockierendes Event
  dazwischen, gibt es im Voraus frei und löst auf, sobald der Spieler es erreicht), Exit mit
  `msSinceClose` (bis `close()`, dann der aufgezeichnete Code mit `expected:true` –
  `interrupt-requesting` endet so mit Code 1).
- **UUID-Abbildung:** jede Fixture-UUID eines `input` → gesendete UUID, tief in allen späteren
  Messages (`command_uuid`, `user_message_uuid(s)`, Replay-`uuid`) und in `still_queued`.
- **Vergleich am `decision`:** `behavior`, `message` (deny), `interrupt` (deny), `updatedPermissions`
  als Menge, `updatedInput` tief (Schlüsselreihenfolge egal); `decisionClassification` wird bewusst
  **nicht** verglichen (die Aufzeichnung `permissions#46` hat `user_permanent` bei Ziel `session`,
  ADR-012/§3.4 verlangen `user_temporary`).
- **Antworten:** `call`s → letzter abgespielter, sonst erster der Datei, sonst `defaults.ts`;
  andere `control`s (setModel …) → Antwort für den nächsten passenden Aufruf (`error` → Ablehnung).
- **Exit:** immer das letzte Event, danach endet die Queue; `send()`/Steuer-Aufrufe danach werfen
  `Error('session closed')`. Offene `canUseTool`-Signale werden **eine Makrotask nach** dem Exit
  abgebrochen – so bricht die Engine sie zuerst mit `process_exit` ab (§3.5.12 Schritt 2), wie
  bei einem Prozess, der schon weg ist.
- **Zeit:** `speed` Default **0** (Tests; WP-20 übergibt `speed: 1`), Verzögerung
  `min(Δt × speed, maxDelayMs)`, neu ab jedem Tor. Nullverzögerungen und `settle()` nutzen das beim
  Import gesicherte echte `setImmediate` → Vitest-Fake-Timer (Auto-Retry-Tests in 13b) halten das
  Abspielen nicht an; nur `sleep` (speed > 0) ist der Test-Seam.
- **`settle()`:** löst auf, wenn keine Session `running` ist – zweimal geprüft (eine Makrotask
  Abstand), damit ein Tor, das die Engine sofort beantwortet, nicht als Ruhepunkt zählt.
- **PID:** aus dem `spawn`-Event, sonst `pidBase + n` (Default 40000).
- **Verlauf:** jede gespielte user/assistant-Message (ohne Replays; Subagent-Messages getrennt je
  `agent_id`) und jeder gesendete Prompt landen im `FakeHistoryStore` in SDK-Rohform;
  `readHistory`/`getSessionInfo` laufen über `history/parse.ts` wie im SdkBackend.
  `seedFromHistoryFixture` importiert je Session-ID das erste Array- bzw. Info-Ergebnis.
- **Diagnosen** (`handle.diagnostics`): `input-mismatch`, `decision-mismatch`, `unexpected-input`,
  `unexpected-interrupt`, `handler-error`, `rename-running`, `invalid-event`, `scenario-error`.
  Wirft der Handler, antwortet der Fake wie das SdkBackend (`deny` „Parallax could not process this
  request.“ + Event `error{where:'control'}`).

**Script-Modus:** `ctx.emit`/`ctx.play` werfen `TurnInterrupted(reason)` bei `interrupt()`
(`interrupt`) bzw. einem Prompt mit `priority:'now'` (`now`); danach ist das Turn-Signal frisch,
damit der Epilog desselben Turns abgespielt werden kann. Ein `'next'`-Prompt während des Turns
erzeugt sofort `command_lifecycle queued` (F.9). `setModel`/`setPermissionMode`/`applyFlagSettings`
ändern `ctx.state` auch vor dem ersten Turn; `setPermissionMode` im Turn sendet `system/status`
(F.2), im Leerlauf erst das nächste `init`.

### Interaktives Dev-Szenario

| Prompt (erstes Wort, case-insensitiv) | Ablauf |
|---|---|
| beliebiger Text | Thinking + gestreamte Antwort „Echo: …“ (≈ 1 s bei `speed 1`), `result success` |
| `fake:bash` / `fake:permission` | Bash mit Suggestions wie `permissions.jsonl` (addRules localSettings, addDirectories cwd, setMode); allow → Tool-Result + Text; deny → Fehler-Tool-Result + „Okay, I did not run the command.“; deny+interrupt → abgebrochener Turn (`aborted_tools`) |
| `fake:edit` | Write mit Suggestion nur `setMode acceptEdits` |
| `fake:question` | AskUserQuestion (Red/Blue mit Markdown-Previews) → „You chose: …“ |
| `fake:plan` | Plan-Datei per Write ohne Karte, ExitPlanMode; revise → nächste Version (max. 5); approve → `system/status` mit gewähltem Modus, Umsetzung, „IMPLEMENTED“ |
| `fake:subagent` | Agent im Hintergrund, erstes `result` ohne idle, Task-Ende, zweiter Turn, dann idle (F.11) |
| `fake:parallel` | zwei Hintergrund-Agents fragen gleichzeitig je eine Bash-Permission (`agentID` = Task-ID) |
| `fake:slow` | 100 Deltas à 200 ms (≈ 20 s, Stop-Test) |
| `fake:compact` / `/compact` | `compacting` an/aus + `compact_boundary` |
| `fake:ratelimit` | `rate_limit_event allowed_warning`, danach `rejected` |
| `fake:error` | `assistant.error authentication_failed` |
| `fake:crash` | Teil-Stream, dann Exit Code 1 |
| `fake:held` | Startfehler `session_held_by_background`, dann Exit Code 1 |
| `/rename X` | wie F.8, setzt den Custom-Titel im `FakeHistoryStore` |
| `/clear` | wie F.7: neue Session-ID im nächsten `init`, Custom-Titel wird übernommen |

Nach dem ersten Turn (kein Slash-Befehl) setzt der Fake den KI-Titel „Fake: <erste Wörter>“.

### Synthetische Engine-Szenarien (`backend/fake/<name>.ts`, `FAKE_SCENARIOS`)

| Name | Inhalt |
|---|---|
| `crash-mid-turn` | Teil-Stream ohne finale Message, Exit Code 1 |
| `crash-awaiting-decision` | Bash-Permission offen (`fake.parallel`), Exit Code 1 |
| `idle-crash` | fertiger Turn (idle), dann Exit Code 3 (Auto-Retry-Fall) |
| `startup-held-elsewhere` | Startfehler `session_held_by_background`, Exit Code 1 |
| `setup-auth-error` | `assistant.error authentication_failed`, Exit-Tor |
| `parallel-decisions` | zwei Subagents, zwei gleichzeitige Permissions mit `agentID`, Joins in beliebiger Reihenfolge |
| `abort-decision` | CLI bricht `canUseTool` per `abort`-Event ab, Turn endet normal |
| `queued-then-crash` | zweiter Prompt `queued`, Prozessende vor `started` |

Die WP-12-Streams (`SYNTHETIC_STREAMS`) laufen unverändert durch das FakeBackend (Test).

### PermissionBroker

- `buildOffer`: nur `addRules` mit `behavior:'allow'` (flach, dedupliziert), `addDirectories`,
  alle vier Ziele nur mit etwas zu merken und ohne `suppressAlwaysAllowRule`; `acceptEdits` nur bei
  Vorschlag und Modus ∉ {acceptEdits, auto, bypassPermissions} (`null` = unbekannt → angeboten).
- `buildResult` je Tabellenzeile §3.4; `updatedPermissions` nur aus dem Angebot (Regeln **und**
  Verzeichnisse an dasselbe Ziel, `setMode` immer `session`); Klassifikation `user_permanent` nur bei
  Ziel ≠ `session`. Frage: `answers[q]` = Labels + Freitext mit „, “, `annotations[q]` nur mit Inhalt,
  `preview` nur bei genau einer gewählten Option – reproduziert `ask-user-question#45` exakt (Test).
- `validateResponse`: Reihenfolge nicht gefunden → schon aufgelöst → abgelaufen (nur Plan-approve) →
  Art → Optionen; zusätzlich zu §3.4: ein Label doppelt gewählt → `DECISION_OPTION_UNAVAILABLE`.
- `createBroker`: Promise wird vor `decision.upsert` angelegt (eine synchrone Antwort im Emit kann
  nicht verloren gehen). Signal-Abbruch → `cancelled{signal_aborted}`; den Fall „`interrupted`, wenn
  der Manager gerade unterbricht“ braucht es nicht, weil der Manager vor `interrupt()` mit
  `deny-interrupt` abbricht (dann ist die Entscheidung schon aufgelöst). Nach `freeze()` gibt ein
  Abbruch nur das SDK frei (Antwort `Cancelled.`), der Record bleibt offen. Aufgelöste Records ohne
  Snapshot bleiben im Speicher (für `DECISION_ALREADY_RESOLVED`), bis `recordsKeep` sie verdrängt
  (dann `DECISION_NOT_FOUND`). `restore` setzt die Plan-Version bei `max(planVersion, Snapshot-Version)
  + 1` fort und nimmt den Text der neuesten Plan-Karte als `previousVersionPlan`-Basis.

### Test-Doubles

- `createMemoryStores`: Registry mit `entrySchema.parse` (Kopien), Transkript faltet nach ID,
  verwirft streamende Items (`droppedStreaming`), prüft jede Zeile wie der Datei-Store unter Vitest
  (`throw`), `readDelayMs` für `loadView`-Rennen; Decisions prüfen „übersteht `parse` unverändert“
  (deckt fehlende Defaults der Engine auf), Pläne, `flush()`; Blobs SHA-256 synchron; Settings wie
  `openSettingsStore`; Warnings mit `add`/`onChange` wie `createStoreWarnings`.
- `createMemoryPublisher`: Hub-gleiche Validierung (Op, Summary, HostState, Notification);
  `waitFor` misst mit `process.hrtime` und pollt per echtem `setImmediate` (Fake-Timer-fest).

### Abweichungen vom Design (alle additiv bzw. Präzisierung)

1. `FakeSessionHandle.sessionId` (zusätzlich, lesend): aktuelle Claude-Session-ID – für
   `renameSession`-Diagnose und Tests.
2. `FakeScriptContext` zusätzlich `history` (KI-Titel, `/rename`) und `now()`.
3. `FakeBackendOptions.ids` (zusätzlich): Id-Fabrik des Script-Modus (Default zufällig).
4. DSL-Bausteine nehmen einen `DslContext` (Session-ID, Ids, Modell, Zeit) als ersten Parameter und
   Objekt-Optionen, z. B. `startupFailure(c, {reason})`, `assistantErrorTurn(c, {prompt, error})`;
   `crash(code)`/`closeGate(code)` ohne Kontext. Grund: eindeutige Frame-UUIDs je Szenario/Turn.
5. Zusätzliche Bausteine `turnOpen`, `turnClose`, `assistantMessage`, `toolResultMessage`,
   `expectDecision`, `subagentLaunch`, `subagentEnd`, `closeGate`, `input`.
6. Zusätzliche Module `fake/session.ts`, `fake/common.ts`, `fake/types.ts`, `fake/README.md`
   (alles in `backend/fake/**`).
7. `speed`-Default 0 (Design nennt keinen Default; WP-20 übergibt `speed: 1`).

### Hinweise für 13b (SessionManager)

- `createFakeBackend({scenario: () => fixtureScenario(await loadFixtureScenario(name))})` +
  Broker-Handler; die Tore über `backend.settle()` + `handle.state` bedienen
  (`driveFixtureSession` zeigt das Muster für einen Prozess). `handle.diagnostics` nach jedem Test
  prüfen.
- Bekannte, gewollte `decision-mismatch`-Diagnosen mit dem Broker statt der Aufzeichnung:
  `permissions#46` (Aufzeichnung nur `addRules`, Broker bei `remember:'session'` zusätzlich
  `addDirectories`) und `permissions#282` (Aufzeichnung = alle Suggestions inkl. `localSettings`
  und `setMode`) – ADR-012.
- Bei Prozessende (`close`, `crash`, Exit-Event) bricht der Fake offene Signale erst eine Makrotask
  später ab: `onExit` muss `broker.cancel('all', 'process_exit', 'deny')` synchron am Anfang aufrufen
  (sonst `signal_aborted`).
- `broker.cancel('all', 'interrupted', 'deny-interrupt')` **vor** `agent.interrupt()`; Prompt
  `'now'` → `broker.cancel('main', 'interrupted', 'deny')`.
- `BrokerDeps.capInput` ist Pflicht: `capInput` aus `sessions/normalizer/index.ts` mit
  `blobs.put` als Sink und `toolName` des Requests.
- `createFakeClaudeIntegration().setLaunchError(makeError('CLAUDE_NOT_FOUND'))` für Startfehler,
  `allowsBypass: true` für die `MODE_NOT_ALLOWED`-Tabelle.
- Memory-Stores werfen bei ungültigen Transkript-Zeilen und Decision-Records, die sich unter
  `parse` ändern – schema-treue Engine-Objekte sind damit schon in den Unit-Tests erzwungen.
- `memoryStores` hat keinen `ProcessStore` (gehört 13b, `createMemoryProcessStore`).

### Wünsche an den Koordinator (READMEs mit mehreren Ownern)

- `src/server/backend/README.md`: Unterordner `lib/` (`asyncQueue`), `history/` (`parse` 13a,
  `pool`/`workerSource` 13c), `fake/` (eigene README) und `fakeBackend.ts` nennen.
- `src/server/sessions/README.md`: `brokerRules.ts`/`broker.ts` und `testing/` (Doubles 13a,
  `harness.ts` 13b) nennen.
- READMEs für `backend/lib/`, `backend/history/`, `sessions/testing/` (Ordner mit mehreren Ownern
  bzw. ohne eigene README-Freigabe) – CLAUDE.md „Jeder Ordner hat eine README.md“.

### Tests

| Datei | Inhalt |
|---|---|
| `backend/lib/asyncQueue.test.ts` | Reihenfolge, wartendes `next`, `undefined`-Werte, `end(error)`, ein Konsument, `break` |
| `backend/permissionRequest.test.ts` | alle aufgezeichneten `canUseTool`-Payloads (Feld für Feld, `raw` ohne `signal`), ungültige Suggestions, Toleranz |
| `backend/history/parse.test.ts` | alle `getSessionMessages`/`getSubagentMessages`/`getSessionInfo`-Ergebnisse aus `history.jsonl`, `origin`, Merge stabil/ohne Timestamp, gleich WP-12 `mergeByTime` |
| `backend/fakeBackend.test.ts` | **alle 12 Fixtures** exakt (Messages, keine Diagnosen, spawned zuerst, exit zuletzt, Interrupt-Tore), alle Tore, Mismatch-Diagnosen, Handler-Fehler, Parallel-Join, Interrupt-Vorabfreigabe, `close`/`crash`/`crashAfterSeq`/Exit-Event, Abort, Antworten, `settle`, Zeitraffer, Verlauf/Info/Rename |
| `backend/fake/dsl.test.ts` | jeder Baustein: Format v1 + echter Normalizer, Item-Arten ⊆ entsprechendes Fixture, Status/Outcomes |
| `backend/fake/synthetic.test.ts` | jedes Engine-Szenario: Format v1, schema-treue Ops, Verhalten im FakeBackend; alle WP-12-Streams unverändert abspielbar |
| `backend/fake/interactive.test.ts` | jedes Schlüsselwort über den echten Normalizer, Entscheidungen, Interrupt, `now`/`next`, Steuer-Aufrufe |
| `backend/fake/{history,integration,testing}.test.ts` | Store, Import, Fake-Integration, Testhilfen, Defaults |
| `sessions/brokerRules.test.ts` | jede Zeile der Tabellen §3.4 (Angebot mit realen Suggestions, Ergebnisse, Prüfungen, Abbruch) |
| `sessions/broker.test.ts` | Erzeugung, Fragesteller, Kappung, erster Klick, Signal-Abbruch, Queue, `cancel` je Grund, Plan-Versionen, Persistenz/Trimmen, `restore`, `closeExpired`, `resume-and-approve`, `freeze` + Neustart |
| `sessions/testing/*.test.ts` | Doubles |

### Checks

- `pnpm exec vitest run src/server/backend src/server/sessions/broker.test.ts
  src/server/sessions/brokerRules.test.ts src/server/sessions/testing`: 16 Dateien / 269 Tests grün.
- `pnpm check` **2× hintereinander grün** (`tsc -b`, ESLint ohne Warnungen, Vitest 84 Dateien /
  1888 Tests; 401 s / 369 s). Vorher scheiterten zwei Läufe an
  `src/server/lib/process.test.ts` › „treats an already finished process as success“ (WP-11, echter
  Spawn + `taskkill` mit dem Default-Timeout 5 s; die Datei braucht unter Last – parallele Worktrees,
  Virenscanner – 77 s, allein 28 s). Nicht 13a-Code; Follow-up für WP-11: Timeout wie bei den
  Nachbartests (30 s).
- `pnpm build` grün. Zusätzlich `backend/fakeBackend.ts` probeweise mit esbuild gebündelt
  (`--packages=external`, wie `scripts/build-server.ts`) und das interaktive Szenario im Bundle
  angestoßen (Echo + `fake:bash`, spawned zuerst, exit zuletzt) – Bündel danach gelöscht.
- `git diff --stat main...HEAD`: nur Besitz-Pfade (die Basismodule sind über 13c schon in `main`).
- Kein Live-`claude`, keine übrig gebliebenen Prozesse.
