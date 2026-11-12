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
| `dsl.ts` | Bausteine über WP-12 `synthetic/build.ts` (Turns, Blöcke, Entscheidungen, Subagents, Interrupt, `/clear`, `/rename`, Fehler, Crash); Phase 3: `inputChunks`, `subagentLaunch({runInBackground, outputFile})`, `taskProgress`, `backgroundTasksChanged`, `subagentEnd({outputFile, status, usage})` |
| `interactive.ts` | Dev-Szenario mit Schlüsselwörtern (`fake:bash` … `/clear`; Phase 2: `fake:image` = Read mit Bild-Ergebnis, `fake:ratelimit` mit Reset in 60 s; Prompt mit Bildern → „Fake: received N image(s)“; Phase 3 siehe unten) |
| `turn.ts` | Bausteine der interaktiven Turns: `Turn`, `contextFor`, `ask` (canUseTool wie das CLI), `answerTurn`, `abortedByDecision` |
| `plan.ts` | `fake:plan` (Plan-Modus, Plan-Datei echt) und der Start mit frischem Kontext („Fake: implementing plan (N lines)“) |
| `phase3.ts` | `fake:background`, `fake:todo`, `fake:files`, `fake:writes-lost`, `fake:context-high` (V4-05), Antworten auf Anhänge/Pastes |
| `files.ts` | `FakeFiles` (echte Dateien nur unter `<filesRoot>\<sessionId>\`, Pfade über `@shared/paths` geprüft), `defaultFakeFilesRoot()` = `%TEMP%\parallax-fake-files`, `patchHunks` |
| `defaults.ts` | Fake-Antworten: `getContextUsage` (Kategorien mit `id`; fester Füllstand bei `fake:context-high`), `supportedModels` (`FAKE_MODELS` = CLI 2.1.322, 14 Einträge), `supportedCommands` (inkl. Terminal-Befehle); `FAKE_CLAUDE_VERSION` = die CLI-Version, die das SDK erwartet (V4-05; Test gegen `claudeCodeVersion` des SDK), auch in `init.claude_code_version`; `FAKE_CONTEXT_HIGH_TOKENS` |
| `history.ts` | `FakeHistoryStore` (Rohformen wie das SDK, Import aus `history.jsonl`) |
| `integration.ts` | `createFakeClaudeIntegration({store?, consoleEnv?, launchEnv?})` (Port `ClaudeIntegration` ohne `claude`, `consoleLaunchFor` → Fake-Konsolen-Spec; `launchEnv` → Launch-Specs mit `FAKE_LAUNCH_ENV_KEYS` (PATH & Co.) für die Git-Branch-Suche, V3-11; der Fake-Server übergibt `process.env`) |
| `console.ts` | `FAKE_CONSOLE_PROMPT`, `fakeConsoleAnswer`, `consoleTurnMessages` – Turns einer simulierten externen Konsole (`FakeBackend.simulateConsoleTurn`, WP-34) |
| `image.ts` | `FAKE_SHOT_PNG_BASE64` (gültiges 24×16-PNG), `promptImageCount`, `receivedImagesText` |
| `testing.ts` | nur Tests: `loadFixtureScenario`, `fixtureDecisionResponder`, `recordedPrompts`, `driveFixtureSession` |
| `<name>.ts`, `synthetic.ts` | synthetische Engine-Szenarien (`export const events`), Index `FAKE_SCENARIOS` |

## Phase 3 im interaktiven Szenario (WP-52)

| Eingabe | Ablauf |
|---|---|
| `fake:plan` | Modus → `plan` (system/status), Plan-Datei per `Write` (Eingabe in 8 `input_json_delta`-Teilen) als **echte** Datei `<filesRoot>\<sessionId>\plans\fake-plan.md`, dann `ExitPlanMode` mit `planFilePath`; Ablehnen mit Feedback → v2 in dieselbe Datei (`type:'update'` mit `structuredPatch`); Freigabe → Modus, `IMPLEMENTED` (`hello.txt` nur im Transkript) |
| `fake:background` | Agent mit `run_in_background`, `task_started`, `task_progress` mit `summary`, `background_tasks_changed`, Ergebnis sofort; nach 30 s (× `speed`, nicht durch `maxDelayMs` gekappt) `task_notification completed` mit `output_file` (echte Datei `tasks\task_<id>.output`) und Folge-Turn; `idle` erst danach. `stopTask(taskId)` beendet ihn vorher (`stopped`) |
| `fake:todo` | `TodoWrite` mit drei Punkten, dann `in_progress`, dann `completed` |
| `fake:files` | `Read`/`Write`/`Edit` auf echten Dateien unter `files\`; Antwort mit `<pfad>:12`, relativem Pfad, Markdown-Link und UNC-Pfad (Negativfall, nur Text) |
| `fake:writes-lost` | Antwort; beim geordneten Ende `system/session_writes_lost` (`ENOSPC`, `transcript`) vor dem Exit |
| `fake:context-high` | Context ab jetzt dauerhaft 75 % (150 000 von 200 000): `getContextUsage` und die `usage` jeder gestreamten Nachricht (Schätzung während späterer Turns, z. B. der Plan-Entscheidung von `fake:plan` – Hervorhebung „Empfohlen“ ab 60 %); zurück auf Normal nach `/clear` oder einer Kompaktierung (V4-05, FIX-R5) |
| Prompt mit PDF / `Attached files:` / `inlinePastes` | „Fake: received N document(s), M file(s)“ bzw. „Fake: received K paste(s)“ (Bilder wie bisher; je Art eine Zeile) |
| erster Prompt ohne Resume `Implement the following approved plan.` | „Fake: implementing plan (N lines)“; `init.permissionMode` = Startmodus |

Echte Fake-Dateien liegen nur unter `FakeBackendOptions.filesRoot` (Standard
`%TEMP%\parallax-fake-files`), nie im Projekt; sie werden nicht automatisch gelöscht. Tests geben ein
eigenes Temp-Verzeichnis als `filesRoot` mit.

Regeln: synthetische Szenarien nur als `.ts` (R0-06, nie `.jsonl`); jedes Event besteht
`fixtureEventSchema` und den echten Normalizer (`synthetic.test.ts`, `dsl.test.ts`). Nullverzögerungen
nutzen das beim Import gesicherte echte `setImmediate` – Fake-Timer der Tests halten das Abspielen
nicht an.
