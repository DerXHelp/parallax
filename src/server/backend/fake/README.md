# backend/fake – FakeBackend-Bausteine (WP-13a)

Port `AgentBackend` ohne `claude` (Einstieg: `../fakeBackend.ts`, `createFakeBackend`). Ein
Abspieler für alles: aufgezeichnete Fixtures, synthetische Szenarien und das interaktive
Dev-Szenario laufen mit denselben Toren (input, canUseTool, control interrupt, close).
Design: `docs/wp/WP-13.md` §3.3, Ergebnis und Stolpersteine: `docs/wp/WP-13a.md`.

| Datei | Inhalt |
|---|---|
| `types.ts` | Szenario-, Handle-, Script-Kontext- und Diagnose-Typen (Re-Export über `fakeBackend.ts`); Phase 3: `FakeBackgroundTask`, `FakeTaskControl`, `filesRoot` |
| `session.ts` | `FakeSession` (= `AgentSession` + `FakeSessionHandle`): Tore, UUID-Abbildung, Antworten, Exit; Phase 3: Hintergrund-Tasks des Script-Modus (`stopTask` mit den CLI-Fehlertexten, `idle` zurückgehalten solange ein Task läuft, Folge-Turn nach der Notification), Nachrichten beim geordneten Ende (`onClose`) |
| `player.ts` | `EventPlayer` für Fixture-Format v1 (Abspielregeln §3.3), `compareDecision` |
| `common.ts` | `SessionStopped`, `TurnInterrupted`, `TaskStopped`, `mapUuids`, Prompt-Helfer (echtes `setImmediate`/`nextMacrotask` jetzt aus `lib/async.ts`, R2-10) |
| `dsl.ts` | Bausteine über WP-12 `synthetic/build.ts` (Turns, Blöcke, Entscheidungen, Subagents, Interrupt, `/clear`, `/rename`, Fehler, Crash); Phase 3: `inputChunks`, `subagentLaunch({runInBackground, outputFile})`, `taskProgress` (mit `activity` → `description` wie die CLI, WP61-07), `backgroundTasksChanged`, `subagentEnd({outputFile, status, usage})` |
| `interactive.ts` | Dev-Szenario mit Schlüsselwörtern (`fake:bash` … `/clear`; Phase 2: `fake:image` = Read mit Bild-Ergebnis, `fake:ratelimit` mit Reset in 60 s; Prompt mit Bildern → „Fake: received N image(s)“; Phase 3 siehe unten) |
| `turn.ts` | Bausteine der interaktiven Turns: `Turn`, `contextFor`, `ask` (canUseTool wie das CLI), `answerTurn`, `abortedByDecision` |
| `plan.ts` | `fake:plan` (Plan-Modus, Plan-Datei echt) und der Start mit frischem Kontext („Fake: implementing plan (N lines)“) |
| `phase3.ts` | `fake:background` (sendet Tätigkeiten „Running …“), `fake:todo`, `fake:files`, `fake:writes-lost`, `fake:context-high` (V4-05), Antworten auf Anhänge/Pastes |
| `feedback.ts` | WP-63: `fake:steps` (6 Bash-Schritte mit Thinking, einer schlägt fehl, ein Satz an den Nutzer, 3 weitere Schritte, Antwort – zwei Gruppen im kompakten Transkript), `fake:images` (4× `Read` mit je einem PNG – Galerie), `fake:limit-warning` (`allowed_warning` für das Wochenfenster mit `unifiedWindows` – nur die Limit-Leiste, kein Transkript-Hinweis) |
| `overview.ts` | WP-65: `FakeUsage` (Planfenster des Fake-Kontos, Standard 5 h 8 %, Woche 23 %; jedes gespielte `rate_limit_event` aktualisiert sie; `readUsage` antwortet in der Rohform des SDK), `fakeTitle` (wie die CLI: mit `persist` gewinnt ein vorhandener Titel, sonst `Fake: <erste Wörter>`; ohne `persist` `Fake (new): …`), `fake:long-bash`, `fake:summary` (Hebel `FakeBackendOptions.overview`: `titles`/`usage`/`backgroundTasks`) |
| `sideQuestion.ts` | WP-66: `fakeSideMode`, `fakeSideAnswer` („Fake side answer (follow-up n): “Frage” – Claude is idle / working on a turn.“), `controlProgressMessage` (wie die CLI ein `started` je Seitenfrage, bei `retry` ein `api_retry`); Hebel `FakeBackendOptions.sideQuestions` (`mode`, `withdraw`) und Schlüsselwörter (siehe unten) |
| `sessionInfo.ts` | WP-67: `FakeSessionInfo` (Zustand je Session: Rohantworten aller sieben Reiter in CLI-Form, laufen durch denselben Parser wie das SdkBackend; ohne Kontodaten), MCP-Zustand `fake-docs` connected / `fake-search` failed / `fake-auth` needs-auth / `fake-off` disabled, `reloadSkills` ergänzt `fresh-skill` (`FAKE_FRESH_SKILL`), Export aus dem Fake-Verlauf mit CLI-Dateinamen; Hebel `FakeBackendOptions.sessionInfo` (`unavailable`, `actions`, `long`) und Schlüsselwörter (siehe unten) |
| `remote.ts` | WP-64 Remote Control: `fakeBridgeInfo` (`cse_fake<id>` ↔ `https://claude.ai/code/session_fake<id>`), `fakeEnableFailure`, `bridgeStateMessage`, `remotePromptTurn` (Turn eines Prompts aus der Claude-App: `command_lifecycle` mit fremder uuid, `init`, `user`-Replay mit `origin:{kind:'human'}`, Antwort); Hebel `fake:remote-prompt [text]`, `fake:remote-permission`, `fake:remote-fail`, `fake:remote-flaky` (siehe unten) |
| `files.ts` | `FakeFiles` (echte Dateien nur unter `<filesRoot>\<sessionId>\`, Pfade über `@shared/paths` geprüft), `defaultFakeFilesRoot()` = `%TEMP%\parallax-fake-files`, `patchHunks` |
| `defaults.ts` | Fake-Antworten: `getContextUsage` (Kategorien mit `id`; fester Füllstand bei `fake:context-high`), `supportedModels` (`FAKE_MODELS` = CLI 2.1.322, 14 Einträge), `supportedCommands` (inkl. Terminal-Befehle); `FAKE_CLAUDE_VERSION` = die CLI-Version, die das SDK erwartet (V4-05; Test gegen `claudeCodeVersion` des SDK), auch in `init.claude_code_version`; `FAKE_CONTEXT_HIGH_TOKENS` |
| `history.ts` | `FakeHistoryStore` (Rohformen wie das SDK, Import aus `history.jsonl`); WP-69: `recordSubagent(sessionId, agentId, messages)` hängt Nachrichten an den Verlauf eines Subagenten (`agent-<id>.jsonl` des SDK), `task_started` ordnet gespielte Subagent-Nachrichten (`parent_tool_use_id`) der Agent-ID zu, `subagentMessages` liest sie (das FakeBackend schneidet in `readSubagentHistory` ab `from` wie die Worker-Op `subagentSlice`) |
| `wp69.ts` | WP-69: Subagent-Verläufe (`FAKE_SUBAGENT_STEPS`, `FAKE_BACKGROUND_STEPS`, `subagentPromptMessage`, `subagentStepMessages`, `recordSubagent` – Prompt, je Schritt Thinking + Werkzeug + Ergebnis, nur im Verlauf, der Stream bleibt wie vorher) und `fake:hooks` (`hookRun`: je Lauf `hook_started` + `hook_response` wie CLI 2.1.323; `FAKE_HOOK_BLOCK_OUTPUT`, `FAKE_HOOK_BLOCK_COMMAND`, `FAKE_HOOKS_ANSWER`) |
| `integration.ts` | `createFakeClaudeIntegration({store?, consoleEnv?, launchEnv?})` (Port `ClaudeIntegration` ohne `claude`, `consoleLaunchFor` → Fake-Konsolen-Spec; `launchEnv` → Launch-Specs mit `FAKE_LAUNCH_ENV_KEYS` (PATH & Co.) für die Git-Branch-Suche, V3-11; der Fake-Server übergibt `process.env`); `testedVersion` = `FAKE_CLAUDE_VERSION` – kein Hinweis „neuer als geprüft“ (WP-62) |
| `console.ts` | `FAKE_CONSOLE_PROMPT`, `fakeConsoleAnswer`, `consoleTurnMessages` – Turns einer simulierten externen Konsole (`FakeBackend.simulateConsoleTurn`, WP-34) |
| `image.ts` | `FAKE_SHOT_PNG_BASE64` (gültiges 24×16-PNG), `promptImageCount`, `receivedImagesText` |
| `testing.ts` | nur Tests: `loadFixtureScenario`, `fixtureDecisionResponder`, `recordedPrompts`, `driveFixtureSession` |
| `<name>.ts`, `synthetic.ts` | synthetische Engine-Szenarien (`export const events`), Index `FAKE_SCENARIOS` |

## Phase 3 im interaktiven Szenario (WP-52)

| Eingabe | Ablauf |
|---|---|
| `fake:plan` | Modus → `plan` (system/status), Plan-Datei per `Write` (Eingabe in 8 `input_json_delta`-Teilen) als **echte** Datei `<filesRoot>\<sessionId>\plans\fake-plan.md`, dann `ExitPlanMode` mit `planFilePath`; Ablehnen mit Feedback → v2 in dieselbe Datei (`type:'update'` mit `structuredPatch`); Freigabe → Modus, `IMPLEMENTED` (`hello.txt` nur im Transkript) |
| `fake:background` | Agent mit `run_in_background`, `task_started`, `task_progress` mit `summary`, `background_tasks_changed`, Ergebnis sofort; nach 30 s (× `speed`, nicht durch `maxDelayMs` gekappt) `task_notification completed` mit `output_file` (echte Datei `tasks\task_<id>.output`) und Folge-Turn; `idle` erst danach. `stopTask(taskId)` beendet ihn vorher (`stopped`). WP-69: sein Verlauf wächst beim Start, zur Hälfte und vor dem Ende (`FAKE_BACKGROUND_STEPS`) |
| `fake:todo` | `TodoWrite` mit drei Punkten, dann `in_progress`, dann `completed` |
| `fake:files` | `Read`/`Write`/`Edit` auf echten Dateien unter `files\`; Antwort mit `<pfad>:12`, relativem Pfad, Markdown-Link und UNC-Pfad (Negativfall, nur Text) |
| `fake:writes-lost` | Antwort; beim geordneten Ende `system/session_writes_lost` (`ENOSPC`, `transcript`) vor dem Exit |
| `fake:context-high` | Context ab jetzt dauerhaft 75 % (150 000 von 200 000): `getContextUsage` und die `usage` jeder gestreamten Nachricht (Schätzung während späterer Turns, z. B. der Plan-Entscheidung von `fake:plan` – Hervorhebung „Empfohlen“ ab 60 %); zurück auf Normal nach `/clear` oder einer Kompaktierung (V4-05, FIX-R5) |
| Prompt mit PDF / `Attached files:` / `inlinePastes` | „Fake: received N document(s), M file(s)“ bzw. „Fake: received K paste(s)“ (Bilder wie bisher; je Art eine Zeile) |
| erster Prompt ohne Resume `Implement the following approved plan.` | „Fake: implementing plan (N lines)“; `init.permissionMode` = Startmodus |

## Remote Control (WP-64)

`FakeSession.setRemoteControl(true, {name, reattachSessionId})` sendet sofort `bridge_state ready`, nach
`FAKE_REMOTE_CONNECT_MS` (300 ms × `speed`) `connected`; Antwort `{bridgeSessionId: 'cse_fake<id>', sessionUrl:
'https://claude.ai/code/session_fake<id>'}`, mit `reattachSessionId` (oder schon verbunden) dieselbe Bridge.
`readRemoteControlDefault()` = `FakeBackendOptions.remoteControl.atStartup` (Standard `false`, damit neue
Sessions im Dev-Server/E2E nicht automatisch verbinden); `remoteControl.enable` = `unavailable` / `auth` /
`policy` / `failed` für die Fehlerfälle. Test-Handle: `remoteControl`, `bridgeState(state, fields)`,
`remotePrompt(text, {answer?, totalCostUsd?})` (Turn zwischen den Turns, nicht unterbrechbar).

| Eingabe (nur mit verbundener Fake-Bridge, sonst Hinweis-Antwort) | Ablauf |
|---|---|
| `fake:remote-prompt [text]` | lokaler Turn mit eigenem Echo (Replay gleiche uuid – der Normalizer verwirft es), danach ein Turn „aus der Claude-App“ mit `text` (Standard „Hello from the phone“), Antwort „From the app: …“; ein Interrupt im zweiten Teil bricht den fremden Prompt ab |
| `fake:remote-permission` | `Write` `handy.txt` mit Freigabe; nach `FAKE_REMOTE_ANSWER_MS` (1,5 s × `speed`) bricht die „App“ `canUseTool` ab, das Werkzeug läuft („approved in the Claude app“); vorher lokal beantwortet wie `fake:edit` |
| `fake:remote-fail` | `bridge_state failed` (terminal) – Bridge weg |
| `fake:remote-flaky` | `bridge_state failed` (`failure_kind: transient`), nach `FAKE_REMOTE_RECONNECT_MS` `connected` mit `recovered` |

Echte Fake-Dateien liegen nur unter `FakeBackendOptions.filesRoot` (Standard
`%TEMP%\parallax-fake-files`), nie im Projekt; sie werden nicht automatisch gelöscht. Tests geben ein
eigenes Temp-Verzeichnis als `filesRoot` mit.

Regeln: synthetische Szenarien nur als `.ts` (R0-06, nie `.jsonl`); jedes Event besteht
`fixtureEventSchema` und den echten Normalizer (`synthetic.test.ts`, `dsl.test.ts`). Nullverzögerungen
nutzen das beim Import gesicherte echte `setImmediate` – Fake-Timer der Tests halten das Abspielen
nicht an.

## Seitenfragen und Zurückholen (WP-66)

Die Seitenfrage (`askSideQuestion`) antwortet nach `FAKE_SIDE_ANSWER_MS` (600 ms × `speed`) mit einem
`control_request_progress started` davor; Schlüsselwörter in der Frage gewinnen über
`FakeBackendOptions.sideQuestions.mode`. Im Events-Modus (Fixtures) immer `unavailable`.

| Eingabe | Ablauf |
|---|---|
| `fake:busy` | `side_question_busy` → Item `failed` mit `SESSION_BUSY` |
| `fake:unavailable` | Methode fehlt → `CLAUDE_CONTROL_FAILED` |
| `fake:fail` | Anfrage scheitert → `CLAUDE_CONTROL_FAILED` |
| `fake:none` | CLI hat keine Antwort (`null`) → wie synthetisch ohne Text |
| `fake:synthetic` | synthetische Antwort („No response available …“) |
| `fake:fallback` | Antwort eines anderen Modells (`refusalFallback`, `FAKE_FALLBACK_MODEL`) |
| `fake:retry` | nach `FAKE_SIDE_RETRY_MS` ein `api_retry` (1/10), dann die Antwort |
| `fake:slow` | antwortet erst nach `FAKE_SIDE_SLOW_MS` (30 s × `speed`, bei `speed` 0 nie) – zum Abbrechen |
| `fake:taken` (in einer wartenden Nachricht) | `withdrawQueued` antwortet `false` („schon übernommen“); sonst verlässt eine noch nicht übernommene Nachricht den Puffer (`command_lifecycle cancelled`, `true`) |

## Session-Info (WP-67)

`readInfo(section)` antwortet aus `FakeSessionInfo` (eine je Session, wie die MCP-Verbindungen eines
CLI-Prozesses). Im Events-Modus: nicht verfügbar (`null`), Aktionen lehnen ab; nach dem Ende → reject.

| Eingabe | Ablauf |
|---|---|
| `fake:info-unavailable [section …]` | die genannten Reiter (`status`, `memory`, `skills`, `hooks`, `permissions`, `mcp`, `export`; ohne Angabe alle) → „nicht verfügbar mit dieser claude-Version“ |
| `fake:info-fail` | MCP-Aktionen und Neuladen scheitern (`FAKE_INFO_ACTION_ERROR`) → `CLAUDE_CONTROL_FAILED` |
| `fake:info-long` | lange Listen: 1200 zusätzliche Skills (über der Listengrenze → `truncated`), 240 Regeln, 60 MCP-Server, 120 Hooks, 20 000 Export-Zeilen |
| `fake:info-reset` | zurück auf `FakeBackendOptions.sessionInfo` (MCP-Zustand und Skills frisch) |

MCP: „Neu verbinden“ verbindet einen fehlgeschlagenen Server (`connected`), ein deaktivierter lehnt ab
(„MCP server "…" is disabled“), `needs-auth` bleibt; Aus/An schaltet um; unbekannter Name → Fehler.

## Übersicht (WP-65)

| Eingabe | Ablauf |
|---|---|
| `fake:long-bash` | Vordergrund-`Bash` „Run the test suite“ (`pnpm test --watch`) mit `tool_progress`; läuft `FAKE_LONG_BASH_MS` (60 s × `speed`, bei `speed` 0 endlos), bis `backgroundTasks()` sie verschiebt: dann `task_started` (`local_bash`, `is_backgrounded`), Tool-Ergebnis mit `backgroundTaskId`, Antwort, Turn-Ende; nach `FAKE_LONG_BASH_BACKGROUND_MS` (20 s × `speed`) `task_notification` und ein eigener Turn mit dem Bericht. Kein `background_tasks_changed` (ob die CLI eine verschobene Shell dort zählt, ist eine Live-Frage) |
| `fake:summary` | `Read` von `notes.md`, Pausen von `FAKE_SUMMARY_STEP_MS` (2,5 s × `speed`), Antwort; mit verbundener Fake-Bridge vor jedem Schritt `task_summary` (CLI-Satz) und vor dem `result` `post_turn_summary` des letzten Assistenten-Beitrags; ohne Bridge keins von beiden (Rückfall der Engine) |

## Subagent-Verlauf und Hooks (WP-69)

| Eingabe | Ablauf |
|---|---|
| `fake:subagent` | wie bisher (erstes Ergebnis, während der Agent läuft; Antwort `SUBAGENT SAID PONG`); dazu wächst der Verlauf des Agenten: Prompt beim Start, dann je `FAKE_SUBAGENT_STEP_MS` (1,5 s × `speed`, ≤ `maxDelayMs`) ein Schritt (Glob, Read, Grep mit Thinking), am Ende Thinking + `PONG` aus dem Stream – 9 Einträge |
| `fake:background` | siehe Phase 3; Verlauf mit zwei Schritten (Bash, Write) |
| `fake:hooks` | Hook-Läufe wie mit `includeHookEvents`: UserPromptSubmit, PreToolUse/PostToolUse eines `Read` (alle `success`), ein blockierender PreToolUse eines `Write` (`outcome: 'error'`, `exit_code: 2`, Ausgabe `FAKE_HOOK_BLOCK_OUTPUT`; das `Write` endet `is_error`), Antwort, Stop |
