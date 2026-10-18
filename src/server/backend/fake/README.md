# backend/fake – FakeBackend-Bausteine (WP-13a)

Port `AgentBackend` ohne `claude` (Einstieg: `../fakeBackend.ts`, `createFakeBackend`). Ein
Abspieler für alles: aufgezeichnete Fixtures, synthetische Szenarien und das interaktive
Dev-Szenario laufen mit denselben Toren (input, canUseTool, control interrupt, close).
Design: `docs/wp/WP-13.md` §3.3, Ergebnis und Stolpersteine: `docs/wp/WP-13a.md`.

| Datei | Inhalt |
|---|---|
| `types.ts` | Szenario-, Handle-, Script-Kontext- und Diagnose-Typen (Re-Export über `fakeBackend.ts`) |
| `session.ts` | `FakeSession` (= `AgentSession` + `FakeSessionHandle`): Tore, UUID-Abbildung, Antworten, Exit |
| `player.ts` | `EventPlayer` für Fixture-Format v1 (Abspielregeln §3.3), `compareDecision` |
| `common.ts` | `SessionStopped`, `TurnInterrupted`, `mapUuids`, Prompt-Helfer (echtes `setImmediate`/`nextMacrotask` jetzt aus `lib/async.ts`, R2-10) |
| `dsl.ts` | Bausteine über WP-12 `synthetic/build.ts` (Turns, Blöcke, Entscheidungen, Subagents, Interrupt, `/clear`, `/rename`, Fehler, Crash) |
| `interactive.ts` | Dev-Szenario mit Schlüsselwörtern (`fake:bash` … `/clear`; Phase 2: `fake:image` = Read mit Bild-Ergebnis, `fake:ratelimit` mit Reset in 60 s; Prompt mit Bildern → „Fake: received N image(s)“) |
| `defaults.ts` | Fake-Antworten: `getContextUsage`, `supportedModels`, `supportedCommands` (inkl. Terminal-Befehle) |
| `history.ts` | `FakeHistoryStore` (Rohformen wie das SDK, Import aus `history.jsonl`) |
| `integration.ts` | `createFakeClaudeIntegration({store?, consoleEnv?, launchEnv?})` (Port `ClaudeIntegration` ohne `claude`, `consoleLaunchFor` → Fake-Konsolen-Spec; `launchEnv` → Launch-Specs mit `FAKE_LAUNCH_ENV_KEYS` (PATH & Co.) für die Git-Branch-Suche, V3-11; der Fake-Server übergibt `process.env`) |
| `console.ts` | `FAKE_CONSOLE_PROMPT`, `fakeConsoleAnswer`, `consoleTurnMessages` – Turns einer simulierten externen Konsole (`FakeBackend.simulateConsoleTurn`, WP-34) |
| `image.ts` | `FAKE_SHOT_PNG_BASE64` (gültiges 24×16-PNG), `promptImageCount`, `receivedImagesText` |
| `testing.ts` | nur Tests: `loadFixtureScenario`, `fixtureDecisionResponder`, `recordedPrompts`, `driveFixtureSession` |
| `<name>.ts`, `synthetic.ts` | synthetische Engine-Szenarien (`export const events`), Index `FAKE_SCENARIOS` |

Regeln: synthetische Szenarien nur als `.ts` (R0-06, nie `.jsonl`); jedes Event besteht
`fixtureEventSchema` und den echten Normalizer (`synthetic.test.ts`, `dsl.test.ts`). Nullverzögerungen
nutzen das beim Import gesicherte echte `setImmediate` – Fake-Timer der Tests halten das Abspielen
nicht an.
