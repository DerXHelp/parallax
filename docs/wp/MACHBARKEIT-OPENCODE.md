# Machbarkeit: OpenCode als zweites Agent-Backend (Ausblick)

> Erstfassung Koordinator, 11.11.2026 (Parallax `7ae00c0`, SDK 0.3.322, CLI 2.1.322; OpenCode 2.2.7). Anlass (Nutzer):
> Parallax soll auch auf der Arbeit laufen; dort wird voraussichtlich früher oder später komplett auf OpenCode
> umgestellt. Nutzer-Entscheidung 11.11.2026: **nicht jetzt umsetzen**, ganz ans Ende des Ausblicks (`docs/plan.md`
> „Backlog“), später gemeinsam ansehen. Das Phase-3-Design (WP-50) bekam keine Vorgabe zur Backend-Neutralität.
>
> **Neu geprüft 24.11.2026** (Auftrag des Nutzers): Parallax `main` = `79f84ce` (Release 2.1.0, SDK 0.3.322,
> CLI-Profil 2.1.323), OpenCode 2.4.1 (23.11.2026). Code-Analyse read-only; OpenCode gegen Code und Doku-Quellen am
> Tag `v2.4.1`, npm und Release-Notizen. Nutzer-Entscheidung 24.11.2026: **nachtragen, noch nichts umsetzen.**
> Vor einer Umsetzung beide Teile erneut prüfen (OpenCode ändert sich schnell).

## Kurzfazit (24.11.2026)

- **Machbar, aber eine eigene Ausbaustufe:** etwa **10–13 Pakete** (11.11.: 6–8), ungefähr so groß wie Ausbau 1.
  Grund: Parallax hat seit dem 11.11. viel Claude-gebundenen Komfort bekommen (WP-63…73, WP-95, Plan-Komfort,
  Abo-Limits, Session-Info, Remote Control).
- **Anteile:** Server zu etwa zwei Dritteln backend-unabhängig (Claude-spezifisch ~30–33 %, ≈27k Zeilen inkl. Fake;
  11.11.: ~45 %), Shared ~18–22 % Claude-spezifisch (11.11.: ~35 %), Web 15–18 % Claude-spezifisch und 60–65 %
  unverändert nutzbar. Fast alles Neue seit 11.11. (mehrere Rechner, Update, Terminal, Linux, Git, Suche) ist neutral.
- **OpenCode ist an den entscheidenden Stellen stabil geblieben:** OpenAPI-Diff 2.2.7 → 2.4.1 – Session-,
  Permission-, Form- und Event-Routen unverändert, Schemas nur ergänzt. Frühere Hürden sind weg: Umgebung je Session
  (`PUT …/environment`), Rechte-Regeln je Session, mehrere Clients an einer Session, `CLAUDE.md` als Fallback.
- **Bleibende Hürden:** (1) API weiter „experimental“, mehrere Releases pro Woche, Plugins aktualisieren sich selbst.
  (2) Keine Plan-Freigabe (nur Agent `plan`). (3) Keine festen Permission-Modi, Effort-Stufen oder Abo-Limits.
  (4) Claude-Abo über OpenCode nur über den Provider „Claude Agent“, rechtlich unklar (B.12).
- Umsetzungsweg, Aufwand, Nachteile und offene Entscheidungen: Teil C.

## Teil A – Kopplung von Parallax an Claude Code (Stand `79f84ce`)

### A.1 Umfang

Seit `7ae00c0` (Zeilen ohne Tests): Server 33,0k → 82,9k, Shared 4,4k → 9,9k, `backend` 6,0k → 12,8k, `sessions`
13,0k → 19,9k, Normalizer 4,4k → 5,8k. Web ~90k (davon 7,7k Fake, Demo, Playground), Web-Tests 45,7k in 249 Dateien.

### A.2 Server nach Modulen

| Modul | Zeilen | Art | Kopplung an Claude |
|---|---|---|---|
| `backend/` (Fake 8,4k) | 12,8k | Claude | SDK-Typen in `types.ts`; `sdkOptions.ts` (`settingSources`, `pathToClaudeCodeExecutable`, `canUseTool`, `onElicitation`); `login.ts` (OAuth); `history/pool.ts` (ein SDK-Worker je `CLAUDE_CONFIG_DIR`) |
| `claude/` | 3,4k | Claude | `resolveClaude`, Preflight, `authStatus`, `profileArgs` (Allowlist der Claude-Flags), `cliProfile`. Neutrale Helfer liegen hier falsch (`env.ts`: `setEnvVar`, `envPathDelimiter`; genutzt von `terminal`, `git`, `lib/process.ts`, `host/login.ts`) |
| `sessions/normalizer/` | 5,8k | Claude | `live.ts` verzweigt nach SDK-/Anthropic-Stream-Typen |
| `sessions/`, nur Claude | ~1,6k | Claude | remoteControl, sideQuestions, titles, usagePoll, sessionInfo, outputStyle, claudeSettings, models, freshContext, subagentTranscript, promptQueue |
| `sessions/`, gemischt (manager, entryState, runtime, commands, broker, brokerRules, external) | ~7,3k | gemischt | `brokerRules.ts` baut das SDK-`PermissionResult` selbst und erkennt Frage/Plan an `AskUserQuestion`/`ExitPlanMode`; „bereit“ = `supportedModels()` (`runtime.ts`); `NormalizerFns` einmal je Manager (`entryState.ts`, `manager.ts`) |
| `sessions/`, neutral (notifier, unread, nativeToasts, summary, mirror, attachments, worktrees, review, planIndex, status) | ~3,6k | neutral | `overview.ts` und `detailTracker.ts` hängen an Claude-Werkzeugnamen; Fallback-Codes `CLAUDE_STARTUP_FAILED`/`CLAUDE_PROCESS_CRASHED` (`status/machine.ts`, `recovery.ts`) |
| `recovery`, `processStore` | 0,5k | neutral, Claude-Prozessmodell | ein `claude.exe` je Session (PID + Startzeit, Kindbaum, Schlafen = Prozess schließen) |
| `terminal/` | 3,7k | neutral | `openClaude`/`claudeState` (`ports.ts`, `service.ts`); `TERMINAL_COMMANDS` enthält `claude` (`shared/terminal.ts`) |
| `git/` | 2,1k | neutral | nur Konventionen: `WORKTREES_DIR` = `.claude/worktrees`, `.worktreeinclude` (`repo.ts`) |
| `search/` | 0,7k | neutral | liest nur Parallax-Transkripte und Pläne (`service.ts`) |
| `store/`, `install/`, `update/` | 9,1k | neutral | `store/schemas.ts` importiert `PROFILES_FILE` aus `claude/`; `install/sdk.ts` ist generisch, `launcher/release.ts` erwartet aber genau ein SDK `@anthropic-ai/claude-agent-sdk` in `release.json` |
| `host/` | 0,9k | gemischt | `login.ts` = Claude-OAuth; fs-/link-Befehle neutral |
| `hosts/`, `remote/`, `secure/`, `multihost/` | 9,7k | neutral | Vermittler ohne Claude-Bezug; `remote/peerTerminal.ts` reicht `openClaude` durch |
| `sync/`, `http/`, `files/`, `system/`, `lib/`, `app/` | ~18k | neutral bis auf | `files/sessionIndex.ts` (`FILE_WRITE_TOOLS` = Claude-Werkzeuge, `%TEMP%\claude\…\tasks`); `system/console.ts`/`linuxConsole.ts` nehmen `ConsoleLaunchSpec` aus `claude/ports`; `app/compose.ts` verdrahtet sdk/fake fest mit `ClaudeIntegration` |

### A.3 Ports und Naht

- **`AgentBackend` (`backend/types.ts`) ist SDK-förmig:** `PermissionHandler` liefert das SDK-`PermissionResult`;
  `PermissionRequest` ist `canUseTool` 1:1 (inkl. `suggestions: PermissionUpdate[]`); `StartSessionRequest` trägt
  SDK-`PermissionMode`/`EffortLevel`, `fastMode` und `LaunchSpec` (`claude/ports.ts`: configDir, sdkOptions,
  extraArgs, autoCompactWindow); `HistoryMessage.type` ist das Trio user/assistant/system; `AgentSession` hat ~20
  Claude-Steuermethoden (Remote Control, Seitenfragen, readUsage, readInfo, mcpAction, reload, Output-Styles,
  generateTitle, backgroundTasks, withdrawQueued, stopTask, readClaudeSettings); `startLogin` = Claude-OAuth.
  `kind: 'sdk'|'fake'` (auch `@shared/http`) ist der Echt/Fake-Schalter, keine Agent-Art.
- **Schon abstrakt:** `BackendEvent.message: unknown`, `NormalizerOutput {ops, signals}`, `SessionOp`/`TranscriptItem`,
  `StatusEvent`/`deriveDisplayStatus`, `DecisionResponse` (Clients senden Absichten allow/remember/deny/interrupt, nie
  `updatedPermissions`). Die meisten Claude-Methoden degradieren schon heute zur Laufzeit (`unavailable`, `null`,
  `TitleResult.unavailable`) – eine OpenCode-Session kann so antworten, ohne neue Zweige in der Engine.
- **`StatusSignal` (`sessions/ports.ts`):** neutral sind session_state, turn_result, context_estimate, compacting,
  retry, prompt_lifecycle, title_changed, background_tasks; nur Claude: init.apiKeySource/capabilities,
  permission_mode, bridge_state, task_summary, turn_summary, rate_limit, mcp_servers, vcs_changed,
  elicitation_complete.
- **Schnitt:** je Eintrag ein Treiber-Bündel der Backend-Art (Backend, Live- und Verlaufs-Normalizer, Angebots- und
  Ergebnisbau der Entscheidungen, Integration für Auflösen/Anmeldung/Konsole, Fähigkeiten). Konkret:
  1. Bau des `PermissionResult` aus `brokerRules.ts` ins Claude-Backend; der Broker gibt eine neutrale Auflösung weiter.
  2. `PermissionRequest` neutral; das `PermissionOffer` baut der Treiber.
  3. `AgentSession` in einen Kern (Events, send, interrupt, setModel, close, context) und optionale Fähigkeitsgruppen
     teilen.
  4. `LaunchSpec`/`ConsoleLaunchSpec` verallgemeinern (exe/args/env/cwd ist schon generisch).
  5. `NormalizerFns` je Eintrag statt je Manager.

### A.4 Claude-Spezifisches in `src/shared`

- `common.ts`: `PERMISSION_MODES` (Eintrag, `session.create`, setPermissionMode, Plan-`approveModes`,
  Profil-Defaults), `EFFORT_LEVELS` (geschlossene Liste; OpenCode-Varianten sind Strings je Modell),
  `RULE_DESTINATIONS` (session/local/project/user settings; OpenCode `always` ist nur projektweit),
  `claudeSessionIdSchema`.
- Profil (`model.ts`): `configDir` (= `CLAUDE_CONFIG_DIR`), `args`/`passRawArgs` (Allowlist, `PROFILE_ARG_*`),
  `contextWindow`, Zustandsmaschine `ProfileLogin`; `ProfileSummary.claude: ClaudeInstallStatus`;
  `HostState.sdkVersion`/`sdkClaudeCodeVersion`.
- Limits und Remote Control: `RateLimitInfo`, `accountLimits` (five_hour/seven_day), `continueAt`/Wecken,
  `remoteControlSettings`, `bridgeSessionId`/`sessionUrl`, `remoteControlWanted`.
- Eintrag: `claudeModel`, `permissionMode`, `effort`, `fastMode`, `apiKeySource`, `cliVersion`.
- Entscheidungen: `permissionOfferSchema` (rules, directories, ruleDestinations, acceptEdits); Frage im
  AskUserQuestion-Format; Plan = ExitPlanMode (`approveModes`, `approve_fresh_context`, Versionen, Anmerkungen);
  Elicitation = MCP form/url mit JSON-Schema-Feldern (neutral).
- Detail und Session-Info: `sessionInitInfo` (Slash- und Terminal-Befehle, Skills, Plugins, outputStyle,
  fastModeState), `modelOption` (supportsEffort/Fast/Auto), Info-Tabs (memory = `CLAUDE.md`-Arten, Skills, Hooks,
  Rechte), System-Items (compact_boundary, hook, memory_recall, permission_denied, model_fallback, peer_message_hold,
  local_command_output), `user_message.slashCommand`/`originKind`/`source`, `assistant_text.localCommand`.
- Fehler (`errors.ts`): `CLAUDE_*` ×12, `REMOTE_CONTROL_*` ×4, `LOGIN_*` ×3, `RATE_LIMIT_REJECTED`, Start- und
  Assistant-Fehlerzuordnung.
- Protokoll-Befehle mit Claude-Semantik: setPermissionMode, setEffort, setFastMode, setRemoteControl,
  askSideQuestion/cancel/delete, backgroundTasks, withdrawQueued, info, mcpAction, reload, setOutputStyle,
  regenerateTitle, continueAfterLimit, consoleCommand, refreshModels, `profile.login*`.
- `samples.ts` (1,6k) ist Claude-förmig.

### A.5 Web nach Bereichen

| Bereich | Zeilen | Art | Kopplung an Claude |
|---|---|---|---|
| `features/transcript` | 10,7k | gemischt (~25 % Claude) | Renderer nach Claude-Werkzeugnamen (`renderers/index.ts`; unbekannte → generisch); `lib/tool-input.ts` mit Claude-Schlüsseln (`file_path`, `old_string`, `subagent_type`, `structuredPatch`); `lib/grouping.ts`, `lib/since.ts`, `ToolCallRow.tsx` („in den Hintergrund“); `SystemRow.tsx` (Claude-Systemereignisse); `SideQuestionCard` (`/btw`) |
| `features/decisions` | 8,8k | gemischt | Plan-Cluster ~3,4k (PlanCard, PlanPanel, PlanAnnotator, Plan-Versionen, `lib/plan*.ts`) hängt an ExitPlanMode; `PermissionCard.tsx` arbeitet schon auf Absichten, Claude-spezifisch sind die Ziel-Texte (`.claude/settings*.json`) und acceptEdits; `QuestionCard` im AskUserQuestion-Format; Elicitation (~1,1k) neutral |
| `features/composer` | 7,3k | gemischt | Kern (Entwürfe, Anhänge, Paste-Chips, @-Picker, Warteschlange) neutral; `ModePicker`/`lib/modes.ts`; `ModelPicker` (Effort, Fast); `lib/models.ts` (`opusplan`, Alias `/claude-/`); `lib/slash.ts`, `lib/native.ts`; `ContextGauge.tsx` sendet `/compact` als Prompt; `RateLimitBanner`; `BackgroundAll.tsx` |
| `features/{tasks,changes,worktrees,search,files,terminal,updates}` | 14,4k | neutral | nur Texte („Send to Claude“), `files/lib/file-tools.ts` (Claude-Werkzeugnamen → Pfadschlüssel), Terminal `command: 'claude'` |
| `features/profiles` | 3,1k | Claude | `ProfileEditor.tsx`: configDir, contextWindow, args mit Bypass-Erkennung, Modi, Effort-Defaults |
| `features/preferences` | 7,0k | meist neutral | Prompt-Vorschläge, Remote Control, Schlafen des Claude-Prozesses |
| `shell/` | 19k | gemischt | nur Claude: Session-Info-Dialog (1,7k), `AccountLimits`, Remote Control, QuickAsk, Output-Style, Anmeldung, `ShellBanners.tsx` (`ClaudeInstallStatus`), HostFacts, Effort-/Modus-Badges (`SessionHeader.tsx`, `SessionRow.tsx`), Einträge im Session-Menü (`session-actions.tsx`), Profil-Defaults (`NewSessionForm.tsx`) |
| `state/`, `lib/` | 9,3k | neutral | Fakes Claude-förmig (`fake-host.ts`, `fake-session-info.ts`); `lib/effort.ts`, `lib/account-limits.ts`, `lib/model-name.ts` |
| i18n | – | Claude-lastig | 156× „Claude“ in 3,7k Zeilen englischer Wörterbücher (Deutsch ebenso), 25× in `errors.en.ts` |

- **Schon datengetrieben (der Server entscheidet):** `SessionDetail.models` (mit Effort-/Fast-/Auto-Flags),
  `SessionDetail.commands`, `init.agents/tools`, `PermissionOffer.ruleDestinations`, `PlanDecision.approveModes`,
  Frage- und Elicitation-Felder, Kontextzahlen, `costUsdTurn`, Todos und Tasks, `availableOutputStyles` (leer blendet
  den Picker aus), Konsolen-Befehlstext. Kopfzeile und Sidebar blenden Modus und Effort bei `null` aus.
- **Fest verdrahtet:** Werkzeugnamen (~10 Stellen), Modusliste, Slash-Listen (von Parallax behandelt / nur Terminal),
  Kontext-Kategorien, Limit-Fenster, Info-Tabs, Session-Aktionen, `effortLevelSchema`.
- **Träger für die Backend-Art:** `HostState.capabilities`/`features` gelten je Rechner; die Art gehört an Profil und
  Session (ein Rechner kann beide Arten). Günstig: `ProfileSummary` (die UI schlägt das Profil der Session schon nach,
  `SessionHeader.tsx`, `sidebar-groups.tsx`) plus ein Selektor neben `selectSessionFeature` (`state/hosts.ts`).

### A.6 Neue Funktionen seit 11.11. und ihre Bindung

- **Konsole und Terminal:** `claude --resume <id>` (`sessions/external.ts`, `terminal/service.ts`); der Rest ist
  generisch (eigenen Writer schließen, Spec öffnen, Prozess beobachten, Verlauf ab `since − 5 s` importieren).
- **Worktrees und Review:** reines git (`git worktree add`, Hooks des Repos über `git/runner.ts`), keine Claude-Hooks;
  Review-Kommentare im eigenen Store. `PARALLAX_ENTRY_ID`/`PARALLAX_WORKTREE_PORT` kommen über die Prozess-Umgebung
  je Session (`buildEnv`, `app/compose.ts`) – bei OpenCode ginge das über `PUT …/environment` (B.4).
- **Volltextsuche:** nur eigene `entries/*/*.transcript.jsonl` und `plans/`, nie `~/.claude/projects`.
- **Elicitation:** SDK-Hook `onElicitation` und `system/elicitation_complete`; die Umsetzung JSON-Schema → Felder
  (`normalizer/elicitation.ts`) folgt MCP und ist wiederverwendbar.
- **CLI-Profil und Kurz-Check:** `cliProfile.ts`, `cli-profile.json`, `scripts/cli-check` (2,9k), Skill
  `/claude-update`, `testedVersion` – nur Claude.
- **Install und Update:** `install/sdk.ts` lädt nur das Agent SDK (fest in `release.json`).
- **Anmeldung:** `claude auth status --json` und OAuth-Steuerung; OpenCode verbindet stattdessen Provider (API-Keys,
  Device-OAuth) – ein anderer Ablauf.
- **Mehrere Rechner:** Vermittler agnostisch; Contract-Änderungen müssen auf alle Rechner zugleich (gleiche App- und
  Protokollversion, `hosts/link.ts`).

### A.7 Tests und Fakes

- FakeBackend 8,4k + 8,0k Tests, erzeugt SDK-Messages durch den echten Normalizer; Normalizer 1,3k synthetisch +
  2,9k Tests; Session-Tests 10,7k Integration + 5,7k Unit (die Engine-Logik bleibt gültig, läuft aber über die
  Claude-Szenario-DSL); Fixture-Format v1 (`backend/fixture.ts`: canUseTool, decision, control, spawn) SDK-förmig;
  `scripts/record` (3,1k) nur SDK.
- E2E: 45 Specs / 6,6k Zeilen, 28 davon mit `fake:`-Schlüsselwörtern (114 Stellen), ~1,3k Zeilen nur für
  Claude-Funktionen (wp64, wp66, wp67, wp69, wp70, wp73, wp93, wp95, phase3-plan, elicitation).
- Web: 45,7k Testzeilen und 7,7k Fake/Demo/Playground, Claude-förmig.

## Teil B – OpenCode (Stand 24.11.2026, v2.4.1)

Belegt gegen Code und Doku-Quellen im Repo am Tag `v2.4.1`, npm, Release-Notizen und den OpenAPI-Diff
`v2.2.7`…`v2.4.1`. **[unverifiziert]** = nicht direkt belegt, **[Schluss]** = abgeleitet.

### B.0 Korrekturen gegenüber 11.11.2026

1. 2.2.7 / 46 Releases → **2.4.1 / 51** (2.3.0 am 13.11., 2.3.1/2.3.2 am 18.11., 2.4.0/2.4.1 am 23.11.), dazu etwa vier
   Dev-Builds täglich.
2. `reject` lehnt nicht mehr alle offenen Anfragen der Session ab, sondern seit 2.3.1 nur die **desselben Schritts**
   (gleiche Session und Message, #64343); die Doku ist veraltet.
3. Inbox: nur die Zustellart ist änderbar, **keine Umsortierung**.
4. `session.idle` ist veraltet → `session.status` und `session.execution.*`.
5. Subagents laufen seit 2.3.0 **immer im Hintergrund**.
6. `CLAUDE.md` wird seit 2.3.1 als Fallback gelesen (die Seite „Claude Agent“ sagt noch das Gegenteil).
7. ~170 → **178** Operationen; die `schedule`-Routen sind durch `automation` ersetzt.
8. `serve`: Standardport 4096 aufwärts, zufälliges Passwort, Lease-Modus `--stdio`; Grenzen beim Teilen der DB (B.2).
9. Auth nur Basic; das Bearer-Beispiel der Client-Doku passt nicht zum Server-Code.
10. Plan-Prompt: Plan im Chat besprechen, Plan-Dateien nur auf Wunsch; weiterhin kein Ausstieg, keine Freigabe.
11. Claude Agent: `configDir`, Kontowechsel bei Limit, Entrypoint `opencode`, Websuche.
12. Neu: eigener Worktree-Manager (B.7) und Automationen (B.13).

### B.1 Version und Stabilität

- 2.4.1 vom 23.11.2026 (npm `latest`). Brüche und Verhaltensänderungen seit 2.2.7:
  - 2.3.0: Subagents immer im Hintergrund.
  - 2.3.1: `schedule` → `automation`; Hintergrund-Kompaktierung Standard (`compaction.background`); Shell-Befehle mit
    Timeout wandern in den Hintergrund statt beendet zu werden; `reject` enger; `CLAUDE.md`-Fallback zurück; ein
    abstürzender Request liefert 500 mit `UnknownError`.
  - 2.4.0 (neuer Abschnitt „Upgrade notes“): Plugins laden wieder im Hintergrund (Modell- und Provider-Listen direkt
    nach dem Start evtl. leer, auf `model.updated` neu laden); Plugins mit `@latest` oder Bereich aktualisieren sich
    alle 24 h; Automationen standardmäßig an; Image-Tool umbenannt; Copilot liest `GITHUB_TOKEN` nicht mehr; MCP
    zuerst mit dem neuesten Protokoll; Assistant-Parts als eigene DB-Zeilen.
- OpenAPI-Diff 2.2.7 → 2.4.1: 170 → 178 Operationen; entfernt nur die sechs `schedule`-Operationen; neu automation,
  machine, blob, video, job; Session-, Permission-, Form- und Event-Pfade unverändert, Schemas nur ergänzt
  (`session.step.first-token`, `time.firstToken`, `experimental.job.updated`, `experimental.mcp.event`).
- Weiter „Experimental HttpApi surface for selected instance routes“, Spec-Version `0.0.1`, Gruppen „Experimental
  session routes“/„Experimental event stream routes“, keine Stabilitätszusage. Spec: `packages/protocol/openapi.json`
  und `/docs/openapi.json`. `CHANGELOG.md` diszipliniert (Highlights, Upgrade notes, SDK).

### B.2 Integrationsfläche

- **`opencode serve`:** `--hostname` (Default `127.0.0.1`), `--port` (Default 4096 aufwärts; der Dienst nutzt einen
  festen Kanalport), `--cors` (mehrfach), `--service`, `--stdio` (nicht kombinierbar). Passwort nur über
  `OPENCODE_PASSWORD` (Altname `OPENCODE_SERVER_PASSWORD`), sonst zufällig erzeugt und ausgegeben. Global:
  `--standalone`, `--server <url>`, `--print-logs`.
- **`--stdio` ist ein Lease:** der Server gibt eine Zeile `{"url":…}` aus, endet bei EOF auf stdin und entfernt das
  Passwort aus der Umgebung, die seine Tools erben. `--standalone` = `serve --stdio --port 0` mit Zufallspasswort.
  Das ist das Rezept für einen app-eigenen Server.
- **Trennung:** Pfade aus `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` (Default
  `~/.local/share/opencode` usw., auch unter Windows); dazu `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG` (Datei),
  `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DB` (Name, Pfad oder `:memory:`), `OPENCODE_DISABLE_PROJECT_CONFIG`. Die
  Zugangsdaten der Provider liegen in der DB – ein eigener Datenordner bedeutet eine eigene Anmeldung.
- **Teilen der DB:** mehrere Server-Prozesse können eine DB nutzen, koordinieren aber nur prozesslokal; verwaiste Turns
  setzt nur der Dienst fort; Automationen laufen aus jedem Server-Prozess. Ein privater Server auf dem
  Standard-Datenordner kann also Automationen des Nutzers doppelt ausführen und mit dessen Dienst um dieselbe Session
  konkurrieren. Abhilfe: eigener Ordner bzw. `OPENCODE_DB` – oder über `Service.ensure/discover` dem gemeinsamen Dienst
  beitreten.
- **`@opencode/client` 2.4.1:** MIT, nur ESM; Einstiege `.`, `/promise`, `/effect`, `/solid`, `/mcp`, `/service`
  (nur Node). Hängt exakt an `@opencode/protocol` und `@opencode/schema` 2.4.1, die `effect` 4.1.0 festlegen –
  Effect ist damit Laufzeitabhängigkeit (entpackt: Client 1,2 MB, protocol 2,8 MB, schema 4,5 MB, effect 56 MB). Kein
  `engines`-Feld; unter Node 26 nicht getestet **[unverifiziert]**.
- **Auth:** HTTP Basic (Benutzer `opencode`), Query-Parameter `auth_token` oder Session-Cookie.
- **`@opencode/sdk` (eingebettet):** zieht `@opencode/core` mit nativen Modulen (node-pty, sqlite, watcher) und das
  Agent SDK – für Parallax zu schwer.
- **ACP (`opencode acp`):** privater Server je Prozess ohne Port, viele Sessions, ein Prompt je Session zur Zeit;
  list/load/resume/fork, `usage_update` mit Kontextgröße und Kosten; kein steer/queue, revert, diff. Offenes Issue
  #64686: ACP hängt unter Windows.

### B.3 Events und Wiederaufnahme

- **`GET /api/event` (SSE):** „Volatile by contract“ – ein langsamer Konsument lässt den Strom überlaufen und abbrechen,
  Events während einer Trennung fehlen. Filter `types=`, `server.connected` als Resync-Marke; der Client hat weder
  Replay noch automatisches Neuverbinden.
- **Dauerhaftes Log je Session:** `GET /api/experimental/session/{id}/log?after=<seq>&follow=true`; Events tragen
  `aggregateID`, `seq`, `version`; `log.synced` markiert den Stand.
- **Nur live (flüchtig):** alle `*.delta`, `tool.progress`, `session.usage.updated`, `session.status`, `permission.*`,
  `form.*`; offene Permissions liegen nur im Server-Speicher.
- **Wiederaufnahme [Schluss]:** neu abonnieren, das Log ab dem letzten `seq` bis `log.synced` lesen, Session sowie die
  Listen `/permission` und `/form` neu holen.
- **Event-Typen:** Session-Lebenszyklus (`session.created`, `agent|model.selected`, `renamed`, `moved`, `archived`,
  `deleted`, `forked`, `permissions`); Inbox (`inbox.enqueued|delivered|cancelled|delivery.changed`); Ausführung
  (`execution.started|succeeded|failed|interrupted`, Grund `user|shutdown|superseded|inactivity`); Schritte
  (`step.started|first-token|streamed|ended|failed`, `ended` mit Kosten, Tokens, Snapshot, Dateien); Inhalt (`text`,
  `reasoning`, `tool.input` je `.started|.delta|.ended`, dazu `tool.called|progress|success|failed`);
  `retry.scheduled`, `compaction.started|delta|ended|failed`, `revert.staged|cleared|committed`,
  `usage.recorded|updated`, `shell.started|ended`, `skill.activated`, `instructions.updated`; `session.status` =
  `idle | busy | retry{attempt, message, action, next}`; außerdem `permission.asked|replied`,
  `form.created|replied|cancelled`, `experimental.job.updated`.
- **Subagents:** Kind-Sessions (`parentID`); ihr Bericht landet als `<background-result kind="subagent">` in der Inbox
  der Eltern-Session. **Todos:** Tool `todowrite`, standardmäßig aus, Daten nur in den Tool-Metadaten.

### B.4 Steuerung (`/api/session/{id}/…`)

- **Prompt:** `{text, files[{uri: file:|data:, name, …}], agents, skills, delivery: steer|queue (Default steer),
  resume}`; Anhänge bis 20 MiB, Bilder auf 2000 px und 5 MiB (base64) verkleinert.
- **Inbox:** auflisten, stornieren, Zustellart per `PATCH` ändern; keine Umsortierung.
- **Abbruch:** `interrupt?resume=` → `{interrupted}`. „Owned by this OpenCode process“ meint den Server-Prozess: jeder
  Client dieses Servers kann abbrechen, ein anderer Server auf derselben DB nicht. Dazu `/api/session/active`,
  `/background`, `experimental.job.cancel`.
- **Modell und Agent:** `/model` mit `{id, providerID, variant}` – die Variante trägt den Reasoning-Aufwand (Form
  `<provider>/<modell>#high`); `/agent` wechselt den Agenten. Beides gilt für die folgenden Turns.
- **Befehle und Skills:** `GET /api/command`, `/command`; Skills experimentell über `/skill`.
- **Kompaktierung:** `/compact` plus automatische Kompaktierung im Hintergrund.
- **Fork, Revert, Diff:** `/fork {before?}`; `revert/stage {messageID, files?}`, dann `/clear` oder `/commit`;
  `/diff?from&to&context` je Turn.
- **Liste und Verlauf:** `GET /api/session` (`search` nur über Titel, `parentID=null`, `archived`, `directory`,
  `project`, Cursor); `…/message` (Seiten bis 200, nach Typ filterbar), `/context`, Export/Import experimentell. Ein
  Volltextindex existiert intern, hat aber keine HTTP-Route.
- **Sonstiges:** `PATCH {title|archived|permissions}`, `DELETE` (inkl. Kind-Sessions), **`PUT /environment`
  (Shell-Umgebung je Session)**, `/shell`, `/synthetic`, `/generate`, `/wait`.

### B.5 Plan-Modus und Rechte

- **Plan:** nur der Agent `plan`; er darf nur unter `~/.opencode/plan` editieren, „remain in Plan mode until the user
  switches agents“, neu: „Discuss the plan … in the conversation. Do not create or update plan files unless the user
  explicitly asks“. **Kein** `plan_enter`/`plan_exit`, keine Freigabe – nachstellbar nur durch Wechsel auf `build`
  plus Prompt.
- **Regeln:** geordnete Liste `{action, resource, effect}`, die letzte passende gewinnt, ohne Treffer gilt `ask`.
  Grundpolicy erlaubt alles außer `.env*`; `external_directory` erlaubt; unter Windows case-insensitiv. Die neue Schicht
  `policies` kann nur hart verbieten. **Regeln je Session** beim Anlegen oder per `PATCH` – damit lässt sich ein
  Auto- oder Strikt-Modus je Session über die API setzen. CLI: `--auto`, versteckt `--yolo`.
- **Antworten:** `once | always | reject` plus optional `message` (das Modell macht mit dem Feedback weiter); `reject`
  storniert nur die übrigen Anfragen desselben Schritts. `always` speichert die vom Werkzeug vorgeschlagenen Muster als
  projektweite allow-Regeln in der DB und gibt passende offene Anfragen frei; verwaltbar über
  `GET/PATCH/DELETE /api/permission/saved`.

### B.6 Fragen und Elicitation

- **`question`:** `questions[]` mit `header`, `question`, `options{label, description}`, `multiple`. Alle Fragen kommen
  als **ein** Formular („Questions“, Felder `q0…qN`), Freitext wird automatisch ergänzt; Antwort
  `{answer: {q0: …}}`; Abbruch mit Nachricht lässt das Modell weitermachen.
- **Formulare allgemein:** string, number, integer, boolean, multiselect, external (URL), `when`-Bedingungen, `custom`.
  MCP-Elicitation läuft über denselben Mechanismus (Formulare evtl. mit `sessionID: "global"`).

### B.7 Git, Worktrees, Snapshots

- **Eigener Worktree-Manager:** Worktrees unter `<data>/worktree/<projectID:6>/<name>` (Einstellung
  `worktree.directory`), in der DB geführt; Zugriff über `/api/worktree`, `opencode run --worktree` und „New worktree“
  in der Desktop-App. Fremd angelegte Worktrees tauchen als nicht eigene Einträge auf; ändern würde OpenCode sie nur
  beim Entfernen über OpenCode **[Schluss]**.
- **Snapshots:** vor und nach jedem Schritt in einer eigenen Git-Objekt-DB `<data>/snapshot/<projectID>/<hash(worktree)>`,
  ohne Commits und ohne Index; erfasst versionierte und nicht ignorierte Dateien bis 2 MiB; je Worktree ein
  Snapshot-Repo (Plattenplatz wächst). Einstellung `snapshots`.

### B.8 Übergabe ans Terminal

- `opencode [--server URL] -s <id>` (auch `mini -s`, `run -s`, `--fork`, `-c`); an ein explizites `--server` wird
  `OPENCODE_PASSWORD` geschickt. Ein `attach` gibt es nicht.
- Mehrere Clients können an einer Session arbeiten (Events gehen an alle Clients des Servers). Die Übergabe braucht das
  TUI am **selben** Server (private URL plus Passwort).

### B.9 Konfiguration und Anweisungen

- `AGENTS.md`: global, dann aufwärts bis zur Projektwurzel, verschachtelte Dateien bei Bedarf. `CLAUDE.md`-Fallback
  (seit 2.3.1) in Ordnern ohne `AGENTS.md`, `~/.claude/CLAUDE.md` ohne globales `AGENTS.md`; abschaltbar mit
  `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` bzw. `OPENCODE_DISABLE_CLAUDE_CODE`.
- Skills aus `.opencode/skills`, `.claude/skills`, `.agents/skills` und den globalen Gegenstücken.
- Nicht gelesen: Claudes MCP-Konfiguration, Settings und Hooks. OpenCode hat eigenes `mcp`, Plugins (Hooks
  `execute.before/after`, Session-Kontext, Events) und `.opencode/commands`. Offener Fehler #64941: MCP-Server auf
  Projektebene werden unter Windows ignoriert.

### B.10 Plattformen

- Binaries für Windows x64/arm64/x64-baseline und Linux glibc und musl (x64, arm64, baseline), ~275 MB entpackt.
  Installation per curl-Skript, npm/bun/pnpm, Homebrew, Zip, Docker, Desktop-Installer (Windows `.exe`, Linux
  deb/rpm/AppImage); „Windows package managers are not supported“.
- Ein Server-Prozess für viele Sessions und Ordner. Shell-Befehle laufen unter Windows seit 2.3.0 über den
  Prozess-Daemon (`opencode-pty`); PowerShell, cmd und Git Bash (`OPENCODE_GIT_BASH_PATH`).
- Seit 11.11. 217 neue, noch offene Windows-Issues, z. B. #64958 (über 13 GB Speicher-Commit), #64664 (`%TEMP%`
  wächst), #64573 (cmd-Quoting), #65942 (hängender `serve --service` blockiert Updates). Ressourcenzahlen
  **[unverifiziert]**.

### B.11 Verbrauch und Limits

- `step.ended` und `Session.Info`: Kosten in USD und Tokens `{input, output, reasoning, cache.read/write}`;
  `Model.Info.limit.context` liefert die Kontextgröße, den Prozentwert rechnet der Client.
- `/api/experimental/usage/limits` nur für Budgets von OpenCode Console/Go. Abo-Limits von ChatGPT, Copilot oder
  Claude erscheinen nur als `session.status` `retry.action{reason, provider, …}` oder als Fehler.

### B.12 Claude über OpenCode

- **Provider „Claude Agent“:** nutzt `@anthropic-ai/claude-agent-sdk` 0.3.301 (fest), `settingSources: []`, Werkzeuge
  über einen In-Process-MCP-Server, `permissionMode: dontAsk`, `CLAUDE_CODE_ENTRYPOINT=opencode`; braucht Claude Code
  ≥ 2.1.248; Doku-Seite `noindex`.
- **Neu in 2.4.0:** `configDir`; mit einer Ordnerliste Wechsel zum nächsten Konto, wenn eines sein Limit erreicht (nur
  Abo-Logins); Websuche über `claude-agent`.
- **Anthropic (Rechtsseite, heute):** zusätzlich „Advertised usage limits for Pro, Max, and Ultra plans assume
  ordinary, individual usage of Claude Code and the Agent SDK“; Entwickler dürfen Claude.ai-Zugangsdaten nicht
  „collect, store, or intermediate“; Durchsetzung „without prior notice“ (ob neu seit 11.11.: **[unverifiziert]**).
  Kontowechsel bei Limits passt schlecht zu „ordinary, individual usage“. Neue Aussagen beider Seiten zu diesem
  Provider seit 11.11. nicht gefunden.
- Dieselben Klauseln betreffen Parallax’ heutigen Ansatz ebenfalls (unverändert seit 11.11.).

### B.13 Was einen externen Steuerer zusätzlich belastet

- **Gemeinsamer Dienst:** #64274 (`/api/info` wird unter Last langsam, Clients ersetzen dann einen lebenden Dienst und
  beenden dessen Läufe), #63357 (Dienst wird nach 45 s SSE-Stille beendet).
- **Automationen und `/goal`:** Sessions wachen ohne Zutun des Steuerers auf → `"automations": false`.
- **Drift:** Plugins aktualisieren sich selbst; Modelllisten sind direkt nach dem Start leer.
- **Sicherheitsvorgaben:** alles standardmäßig erlaubt; CORS lässt jedes `http://localhost:*`/`127.0.0.1:*` zu – nur
  das Passwort schützt.
- **Strikte Schemas** (`additionalProperties: false`) → tolerant parsen.
- **14-Tage-Regel (ADR-221):** neuester zulässiger Client heute 2.2.7; das Kern-Drahtformat 2.2.7 ↔ 2.4.1 ist stabil,
  ein älterer gepinnter Client sollte für die Kernoperationen reichen **[Schluss]**.

### Quellen

- GitHub `anomalyco/opencode` am Tag `v2.4.1`: `packages/protocol/src/groups/{session,message,event,permission,usage,server}.ts`,
  `packages/protocol/openapi.json` (auch am Tag `v2.2.7`),
  `packages/schema/src/{session-event,session-status-event,event,event-log,form,question,permission,session-inbox,session,model,token-usage,usage-limits}.ts`,
  `packages/cli/src/{commands/commands.ts,server-process.ts,env.ts,database-path.ts,services/standalone.ts,services/service-config.ts}`,
  `packages/client/src/service.ts`, `packages/util/src/{global,global-roots}.ts`,
  `packages/server/src/{auth,cors,process}.ts`, `packages/server/src/middleware/authorization.ts`,
  `packages/core/src/{permission.ts,plugin/plan.ts,tool/plugin/question.ts,tool/plugin/todo.ts,worktree/strategies.ts,snapshot.ts,session/execution/restart.ts}`,
  `packages/core/src/plugin/provider/claude-agent/claude/query-options.ts`, `packages/core/package.json`,
  `services/site/src/docs/content/{claude-agent,permissions,instructions,skills,snapshots,attachments,troubleshooting,index,mcp-servers,migrate-v1}.mdx`,
  `…/content/cli/{index,acp,tui}.mdx`, `…/content/build/{client,sdk}/index.mdx`, `CHANGELOG.md`
- Releases: https://github.com/anomalyco/opencode/releases (v2.3.0–v2.4.1, v1.19.6); Issues #63357, #64274, #64343,
  #64573, #64664, #64686, #64941, #64958, #65942
- npm: `@opencode/{cli,client,protocol,schema,sdk,core}`, `effect`; Erstfassung zusätzlich `@opencode-ai/sdk` (V1)
- Doku: https://opencode.ai/docs/llms.txt · https://opencode.ai/docs/api/ · https://opencode.ai/docs/build/client/ ·
  https://opencode.ai/docs/permissions/ · https://opencode.ai/docs/agents/ · https://opencode.ai/docs/cli/ ·
  https://opencode.ai/v2/docs/claude-agent · https://opencode.ai/changelog
- Anthropic: https://code.claude.com/docs/en/legal-and-compliance · https://code.claude.com/docs/en/agent-sdk/overview
- Hintergrund (Erstfassung): https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access

## Teil C – Umsetzungsweg (Entwurf 24.11.2026, nicht beauftragt)

### C.1 Zielbild

- **Backend-Art am Profil** (`backendKind`: `claude` | `opencode`; das Profil bündelt schon Programm, Env, Args,
  Defaults), beim Anlegen auf den Eintrag kopiert; Wechsel der Art bei vorhandenen Einträgen gesperrt.
  `--backend sdk|fake` bleibt der Echt/Fake-Schalter.
- **Treiber je Art** im Manager: Backend, Live- und Verlaufs-Normalizer, Entscheidungsregeln (Angebot, Ergebnis),
  Integration (Programm finden, Version, Anmeldestatus, Konsolen-Spec) und Fähigkeiten (Schnitte A.3).
- **Fähigkeiten statt `if (opencode)`:** die Session meldet z. B. Agenten bzw. Modi als Liste `{id, label, danger}`,
  `planApproval`, Effort-Art (`levels` | `variants` | keine), `fastMode`, `sideQuestions`, `remoteControl`,
  `accountLimits`, `sessionInfoSections`, `terminalHandoff`, `backgroundMove`, `compact` (Prompt oder Befehl). Die UI
  blendet danach aus (~25 Stellen); nach Art verzweigen nur Texte (Ziel-Hinweise, Setup, `{agent}` in Texten).
  Träger: `ProfileSummary` plus Selektor neben `selectSessionFeature` (A.5).
- **OpenCode-Prozess:** ein privater `opencode serve --stdio` je Profil (Lease: endet mit Parallax; Passwort von
  Parallax; `automations: false`), viele Sessions darin. Daten- und Konfigurationsordner je Profil über XDG,
  `OPENCODE_DB`, `OPENCODE_CONFIG_DIR` (Gegenstück zu `configDir`). Start über `spawnHidden` mit absolutem Pfad
  (`resolveExecutable`), Umgebung über `buildEnv`; `PARALLAX_ENTRY_ID`/`PARALLAX_WORKTREE_PORT` je Session über
  `PUT …/environment`. Rechte-Regeln je Session beim Anlegen (sichere Vorgabe statt „alles erlaubt“).
- **Eigener schlanker Client** (HTTP + SSE, zod an der Grenze, tolerant) für die genutzten Routen statt
  `@opencode/client` (zieht `effect` mit 56 MB, nur ESM, 14-Tage-Regel). Damit keine neue Abhängigkeit; die geprüfte
  OpenCode-Version steht in einem Profil wie `cli-profile.json`.
- **Werkzeuge kanonisch:** der OpenCode-Normalizer übersetzt Werkzeugnamen und Eingaben auf die heutigen Namen
  (`read` → `Read` mit `file_path`, `edit` → `Edit` mit `old_string`/`new_string`, `task` → `Agent`, `todowrite` →
  `TodoWrite`, …). Dann bleiben Renderer, `files/lib/file-tools.ts`, `files/sessionIndex.ts`, `overview.ts` und
  `detailTracker.ts` unverändert; der Edit-Renderer baut den Diff schon heute aus alt/neu, wenn `structuredPatch`
  fehlt. Alternative: ein Feld `toolKind` im Contract (sauberer, teurer).

### C.2 Was direkt funktioniert

- **Unverändert** (sofern der Normalizer Standard-Items liefert): Sync/Hub, HTTP, Store, Seitenleiste, Übersicht,
  Benachrichtigungen, Ungelesen und Status, mehrere Rechner, Updates, Volltextsuche, Änderungen/Review/Git-Leiste,
  Worktrees, Dateien-Viewer, Terminal-Panel, Aufgaben-Panel, Transkript-Kern, Composer-Kern (Entwürfe, Anhänge,
  Paste-Chips, @-Picker), `ui/*`.
- **Mit kleiner Anpassung:** Frage-Karte (ein Formular `q0…qN`; `notes`/`preview` ungenutzt), Elicitation-Karte
  (MCP-Formulare), Kontext-Anzeige (Prozent aus Tokens und `limit.context`, ohne Kategorien), Kosten (Sperre „nur mit
  API-Key“ entfällt), Slash-Menü (`GET /api/command`), Kompaktieren (Befehl statt Prompt), Modellwahl (nach Provider
  gruppiert; `isModelAlias`/`shortModelName` anpassen), Subagent-Panel (Kind-Sessions), Todos, Fortsetzen im Terminal
  (`opencode --server <url> -s <id>`, mehrere Clients erlaubt), Projekte mit `CLAUDE.md` und `.claude/skills`
  (Fallback in OpenCode).

### C.3 Was nachgebaut werden muss (Schätzung)

| Bereich | Inhalt | WP |
|---|---|---|
| Naht und Contracts | `backendKind` (Profil, Eintrag, `ProfileSummary`, `SessionSummary`; Felder mit Default), Fähigkeiten, generischer Installationsstatus statt `ClaudeInstallStatus`/`sdkClaudeCodeVersion`, Effort als Varianten, Agenten statt `PERMISSION_MODES`, `PROTOCOL_VERSION`; Schnitte A.3 (1)–(5); berührt ~4,9k Engine-Zeilen | 1,5–2 |
| OpenCode-Backend | Server-Aufsicht (Lease, Passwort, Neustart), SSE-Pumpe mit Wiederaufnahme (B.3), Verlauf, Umgebung je Session; Wiederherstellung und Schlafen neu (ein Server für viele Sessions; verwaiste Turns setzt nur der Dienst fort) | 1,5–2 |
| Normalizer | Live und Verlauf, Kontext-Prozent, Werkzeug-Kanonisierung, Kind-Sessions | 1,5 |
| Entscheidungen | Rechte-Karte für once/always/reject mit Nachricht (ein Ziel „Projekt“, kein acceptEdits; Geschwister-Karten bei `reject` desselben Schritts auflösen); Plan ausblenden oder nachstellen (C.4) | 1 |
| Web | Agenten- und Varianten-Picker, steer/queue („jetzt senden“ unterbricht bei OpenCode nicht), Kompaktieren, Profil-Editor je Art, Defaults der neuen Session, Setup-Banner und HostFacts, Session-Info (ausblenden ~1 PT, OpenCode-Abschnitte 3–4 PT), ~156 Texte je Sprache neutral (`{agent}`) | ~2 |
| Integration | OpenCode finden (absolut; `.exe` bzw. ELF), Version gegen Profil, Provider-Status, Konsolen-Spec, Profil-Validierung je Art | 1 |
| Fakes und Prüfungen | OpenCode-Fake (SSE + HTTP), Fixture-Format, Recorder, Kurz-Check wie `pnpm cli-check`, Szenarien für Fake-Host und Playground, E2E-Teilmenge je Backend | 1,5–2 |
| E2E und Live | Abnahme gegen echtes OpenCode (mit Nutzer-Freigabe) | 1 |
| **Summe** | | **~10–13** |

### C.4 Was schwieriger wird

- **Plan-Komfort:** OpenCode hat keine Plan-Freigabe. Der ausgefeilteste Teil (Web ~3,4k: Versionen, Anmerkungen,
  Freigabemodi, frischer Kontext) entfällt für OpenCode oder wird nachgestellt: Agent `plan`, Knopf „Umsetzen“ =
  Wechsel auf `build` plus Prompt. Die Plan-Datei unter `~/.opencode/plan` liegt außerhalb des `cwd` (Pfadregeln
  prüfen), und der Plan-Agent schreibt sie nur auf Wunsch.
- **Ungleiche Funktionen:** Remote Control, `/btw`, Abo-Limits und „weiter nach Limit“, Output-Styles, Tabs der
  Session-Info, Fast-Modus, „in den Hintergrund“ und Regel-Ziele gibt es nur bei Claude. Jede neue Funktion muss für
  beide Arten gedacht werden; Gefahr des kleinsten gemeinsamen Nenners.
- **Zwei Update-Spuren:** SDK exakt gepinnt plus CLI-Profil gegen OpenCode mit mehreren Releases pro Woche,
  „experimental“-API und sich selbst aktualisierenden Plugins. Für das OpenCode-Programm braucht es eine Regel wie für
  `claude` (Ausnahme von ADR-221, eigener Ablauf wie `/claude-update`).
- **Testmatrix:** Integration und E2E je Backend → mehr schwere Läufe, nacheinander (ADR-154).
- **Contracts:** großer Eingriff in `src/shared` mit Freigabe; mehrere Rechner müssen gleichzeitig aktualisieren.
- **Sicherheit:** OpenCode erlaubt standardmäßig alles, CORS lässt jedes localhost zu, Automationen laufen
  selbstständig → Parallax setzt Regeln je Session, ein eigenes Passwort und `automations: false`.
- **Prozessmodell:** ein Server je Profil statt ein Prozess je Session → ein Absturz trifft alle Sessions des Profils;
  Schlafen, Wecken und Wiederherstellung funktionieren anders.
- **Windows-Reife:** viele offene Windows-Issues (B.10); Speicherbedarf eines Servers mit vielen Sessions unbekannt.
- **Claude über OpenCode** ist kein verlässlicher Weg, das Claude-Abo zu nutzen (B.12).

### C.5 Vorgehen in Stufen

1. **Naht ohne OpenCode:** Treiber-Bündel, Fähigkeiten, neutrale Contracts; Claude bleibt das einzige Backend, alle
   Tests grün. Der riskanteste Teil, für sich prüfbar.
2. **OpenCode-Kern:** Chat, Werkzeuge, Rechte, Fragen, Modelle/Agenten/Varianten, Anhänge, Warteschlange, Abbruch,
   Verlauf und Fortsetzen, Kontext und Kosten; Änderungen, Worktrees und Suche kommen mit. Plan-Komfort und reine
   Claude-Funktionen bleiben ausgeblendet.
3. **Ausbau:** Übergabe ans Terminal, Plan-Ersatz, Fork/Revert, Abschnitte der Session-Info, Fakes und E2E
   vollständig, Kurz-Check, Live-Abnahme.

### C.6 Offene Entscheidungen (Nutzer)

- **Datenordner:** eigener je Profil (Empfehlung: sauber getrennt, keine doppelten Automationen; dafür eigene
  Provider-Anmeldung) oder der gemeinsame Dienst des Nutzers (Sessions auch im TUI und in der Desktop-App sichtbar;
  Risiken B.2, B.13).
- **Plan-Freigabe:** ausblenden oder nachstellen.
- **Zeitpunkt:** jetzt oder erst, wenn der Provider auf der Arbeit feststeht.
- **Versionsregel** für das OpenCode-Programm (wie `claude` von der 14-Tage-Regel ausnehmen?).
- **Vor einer Umsetzung zu prüfen:** Eingabeschlüssel der Werkzeuge und Permission-Actions der V2 im Detail,
  Verträglichkeit mit Node 26, Verhalten mehrerer Server-Prozesse, Speicherbedarf unter Windows.
