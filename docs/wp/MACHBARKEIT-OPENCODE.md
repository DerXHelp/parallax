# Machbarkeit: OpenCode als zweites Agent-Backend (Ausblick)

> Koordinator, 11.11.2026. Anlass (Nutzer): Parallax soll auch auf der Arbeit laufen; dort wird
> voraussichtlich früher oder später komplett auf OpenCode umgestellt. Nutzer-Entscheidung 11.11.2026:
> **nicht jetzt umsetzen**, ganz ans Ende des Ausblicks (`docs/plan.md` „Backlog“), später gemeinsam
> ansehen. Das Phase-3-Design (WP-50) bekommt **keine** Vorgabe zur Backend-Neutralität.
> Stand der Fakten: Parallax `main` = `109c073` (SDK 0.3.322, CLI 2.1.322), OpenCode 2.2.7 (10.11.2026).
> Vor einer Umsetzung beide Teile neu prüfen (OpenCode ändert sich schnell).

## Kurzfazit

- **Machbar, aber eine eigene Phase** (Schätzung: Umfang ähnlich Phase 2, etwa 6–8 Pakete).
- OpenCode ist ein **eigenständiger Agent** (eigener Loop, eigene Tools, Rechte, SQLite-Sessions), kein
  Aufsatz auf Claude Code – technisch aber **gut fernsteuerbar**: HTTP-API (OpenAPI 3.1) mit SSE-Events,
  offizieller TS-Client, ein Server für viele Sessions/Ordner, Terminal-Übergabe per `opencode -s <id>`.
- Rund **65–70 % von Parallax sind backend-unabhängig** (Sidebar, Navigation, Benachrichtigungen,
  Transkript-Renderer, Composer-Kern, Stores, Sync, HTTP, Launcher); 30–35 % sind Claude-spezifisch.
- **Hürden:** (1) OpenCode-V2-API „experimental“, 46 Releases seit 2.0.0 (11.09.2026), Brüche sogar
  innerhalb 2.2.x → Version pinnen, laufende Pflege. (2) Keine Plan-Freigabe à la `ExitPlanMode`, keine
  festen Permission-Modi (Agenten + Regeln statt dessen). (3) Claude-Abo über OpenCode nur indirekt
  (Provider „Claude Agent“ über das installierte `claude`; Bedingungen ungeklärt) – auf der Arbeit
  entscheidet ohnehin der dort eingesetzte Provider.

## Teil A – Kopplung von Parallax an Claude Code (Code-Analyse, read-only)

Größte Kopplungsstellen, die ein Mehr-Backend-Design schneiden muss:
1. **Port `AgentBackend`** (`src/server/backend/types.ts`): trägt rohe SDK-Messages (`message: unknown`)
   und SDK-Typen (`PermissionResult`, `PermissionUpdate`, `PermissionMode`, `EffortLevel`);
   `PermissionRequest` ist `canUseTool` 1:1. Ziel: jedes Backend liefert eigene Übersetzung
   (Normalizer) bzw. direkt `ops`/`signals` (`sessions/ports.ts`: `NormalizerOutput`, `StatusSignal`).
2. **Broker/Entscheidungsmodell**: Tool-Namen-Routing (`sessions/brokerRules.ts`), Angebote aus
   Claude-`suggestions`, Regel-Ziele, `acceptEdits`, Plan-Freigabemodi, Ergebnis als `updatedPermissions`.
3. **Normalizer als Manager-weites Singleton** (`sessions/manager.ts`) plus Verlaufs-Normalizer auf SDK
   `SessionMessage`; der Normalizer (~4,4k Zeilen) ist komplett Claude-Format-spezifisch.
4. **Shared-Enums/Contracts**: `PERMISSION_MODES`, `EFFORT_LEVELS`, `RULE_DESTINATIONS`,
   `ClaudeInstallStatus`, Profil-Felder (`configDir` = `CLAUDE_CONFIG_DIR`, `args`), `CLAUDE_*`-Fehlercodes,
   Abo-Limit-Fenster, Slash-Semantik (`/model /effort /fast /plan /clear …`).
5. **Claude-Integration und Prozessmodell** (`src/server/claude/**`, ~2,9k Zeilen): `resolveClaude`,
   `buildEnv`, Profil-Args, `claude auth status`, Preflight, Versionsregel, externe Konsole
   (`claude --resume`), ein `claude.exe` je Session, CLI-seitige Warteschlange, Bereitschaft über
   `supportedModels()`.

Weitere Befunde:
- **Web:** Claude-spezifisch sind Mode-/Model-Picker (Effort, Fast), Slash-Menü (native Befehle),
  Context-Gauge (`/compact`), Rate-Limit-Banner, Abo-Limits, Plan-Karte/-Panel, Permission-Karte
  (Regel-Ziele), Frage-Karte (AskUserQuestion-Format), Renderer-Zuordnung nach Claude-Tool-Namen
  (unbekannte Tools fallen schon heute auf den generischen Renderer), Profil-Editor.
- **FakeBackend** simuliert das Claude-CLI (SDK-förmige Messages durch den echten Normalizer); ~11k
  Zeilen Session-Tests und die E2E-Suite prüfen den Claude-Pfad. Ein zweites Backend braucht eine
  eigene Fake-/Fixture-Basis.
- **Vorschlag für später:** `backendKind` am **Profil** (bündelt schon Programm, Env, Args, Defaults),
  auf den Eintrag kopiert; Wechsel der Art bei vorhandenen Einträgen sperren; im Manager je Art eigenes
  Backend, Integration, Normalizer und Entscheidungsregeln. `--backend sdk|fake` bleibt der
  Real-/Fake-Schalter.
- Schätzung Anteil Claude-spezifisch: Server ~45 % (≈15k Zeilen inkl. Fake), Shared ~35 %, Web ~15–20 %.

## Teil B – OpenCode (Web-Recherche, Stand 11.11.2026)

Stand 2026-11-11: V2-Doku, GitHub `anomalyco/opencode` (v2.2.7 vom 2026-11-10, Code `dev`), npm. **[unverifiziert]** = nicht direkt belegt.

### 0. Kurzantwort
OpenCode ist ein **eigenständiger Agent-Harness**: eigener Agent-Loop, eigene Tools, eigenes Rechte- und Config-System und eine eigene SQLite-Session-DB. Für eine Steuer-App ist es aber **besser geeignet als das CLI**, weil es eine dokumentierte HTTP-API (OpenAPI 3.1) mit SSE-Events, einen offiziellen TS-Client und dauerhaft gespeicherte Sessions hat. Ein zweites Backend ist machbar, braucht aber eine eigene Abbildungsschicht; die V2-API ist jung, „experimental“ und ändert sich oft.

**Versionslage:** OpenCode 2.0.0 erschien am 2026-09-11 (npm `@opencode/cli`). Seither gab es 46 Releases der 2.x-Reihe; aktuell ist 2.2.7. V2 hat die Server-API und die Clients bewusst gebrochen: `@opencode-ai/sdk` (V1) wurde durch `@opencode/client` (V2) ersetzt. V1 wird parallel weiter gepflegt (1.19.5 vom 2026-10-28). Lizenz: MIT.

### 1. Architektur und Integrationsfläche
- **Server:** Standardmäßig findet oder startet jeder Client einen gemeinsamen Hintergrund-Server pro Benutzerkonto. Dieser besitzt Sessions, Konfiguration und Integrationen. Wahlweise geht auch ein privater Server über `--standalone` oder ein expliziter über `opencode serve --hostname/--port`. Weitere Flags von `serve`: `--cors`, `--service`, `--stdio`. Basic Auth über `OPENCODE_PASSWORD` (Benutzer `opencode`).
- **API:** REST/JSON unter `/api/*` (~170 Operationen). Die Referenz nennt sie „Experimental HttpApi surface“, einzelne Routen „may change without compatibility guarantees“. Der Event-Stream `GET /api/event` ist SSE (im Code `StreamSse`). Er ist laut Doku „volatile by contract“: kein Replay, Events während eines Verbindungsabbruchs gehen verloren. Dauerhaftes Log: `/api/experimental/session/{id}/log?follow=true`.
- **Clients:**
  - `@opencode/client` 2.2.7 ist ein reiner Netzwerk-Client. `@opencode/client/service` bietet `Service.ensure()`, das `opencode serve --service` startet oder findet (nur unter Node).
  - `@opencode/sdk` ist ein eingebetteter Host ohne HTTP-Listener.
  - `opencode acp` spricht das Agent Client Protocol (JSON-RPC über stdio) mit einem privaten Server pro Prozess.
- **Ablauf:**
  - `session.create({ location: { directory } })` legt eine Session an.
  - `POST /api/session/{id}/prompt` nimmt `text`, `files`, `agents`, `skills`, `delivery: steer|queue` und `resume` entgegen.
  - `event.subscribe()` liefert die Ausgabe.
  - `POST /api/session/{id}/interrupt` bricht ab; mit `resume=true` laufen die Steering-Eingaben danach weiter.
- **Mehrere Verzeichnisse:** Ein Server hostet viele „Locations“. Sessions tragen `location.directory`, Events enthalten `location`, und die Session-Liste lässt sich nach `directory` und `project` filtern. Man braucht also **keinen Server pro Projekt**.
- **Windows-Prozessmodell:** Natives Binary (`@opencode/cli-windows-x64`, `-arm64`, `-x64-baseline`, `bin/opencode.exe`), dazu ein Desktop-Installer (Electron, Beta). Der Shell-Scanner versteht PowerShell (Fixes in v2.2.6/2.2.7). Die V1-Doku empfahl noch WSL; die V2-Doku hat keine WSL-Seite mehr. Laut Doku: „Windows package managers are not supported“, also kein scoop/choco/winget für V2.

### 2. Nachrichten- und Event-Modell
- **Nachrichtentypen:** u. a. User, Assistant, Synthetic, Shell, Compaction, AgentSelected/ModelSelected, Idle.
- **Assistant-Inhalte:** Text, Reasoning und Tool. Ein Tool-Aufruf hat den Status `streaming`, `running`, `completed` oder `error`, jeweils mit `input`/`content`/`metadata`.
- **Events:** `session.text|reasoning|tool.input.*` (`started`/`delta`/`ended`), `session.tool.called/progress/success/failed`, `session.step|inbox|execution|compaction.*`, `session.idle`, `permission.asked/replied`, `form.created/replied/cancelled`.
- **Diffs:** `GET /api/session/{id}/diff` (pro Turn); kein eigener Patch-Part.
- **Verbrauch:** `session.usage.updated` meldet `cost` (USD) und Tokens (`input`, `output`, `reasoning`, `cache.read/write`). Modelle haben `limit.context`. Die Kontext-Auslastung in Prozent muss der Client selbst berechnen **[Schluss]**.

### 3. Berechtigungen
- **Regeln:** `permissions` ist ein geordnetes Array aus `{action, resource, effect: allow|ask|deny}`; die letzte passende Regel gewinnt. Greift keine Regel, gilt `ask`. Actions u. a. `read`, `edit`, `shell`, `subagent`, `webfetch`, `question`, `external_directory`, MCP als `<server>_<tool>`.
- **Grundpolicy:** Alles erlaubt, nur `.env*` fragt nach. `external_directory` ist in V2 standardmäßig erlaubt.
- **Antwort:** `POST /api/session/{id}/permission/{requestID}/reply` mit `{decision: once|always|reject, message?}`.
  - `always` speichert die vom Tool vorgeschlagenen Muster als projektweite allow-Regel.
  - `reject` lehnt **alle** offenen Anfragen der Session ab.
- **Auto-Modus:** CLI-Flag `--auto` („Auto-approve permissions that are not explicitly denied“), versteckt auch `--yolo` und `--dangerously-skip-permissions`. Alternativ eine Regel `*`/`*`/`allow`.

### 4. Entsprechungen zu Parallax-Funktionen
- **Plan-Modus:** Es gibt einen Agent `plan`. Er darf nur unter `~/.opencode/plan` editieren. Laut Code-Prompt gilt „You remain in Plan mode until the user switches agents.“ Ein ExitPlanMode-/Plan-Freigabe-Gegenstück gibt es in V2 **nicht** (V1: experimentelle `plan_enter`/`plan_exit`).
- **Rückfragen:** Das Tool `question` hat header, question, options{label, description} und `multiple`; eine freie Antwort ist immer möglich. Es kommt beim Client als Form an (`form.created`); geantwortet wird mit `POST …/form/{id}/reply {answer}`.
- **Subagents:** Kind-Sessions, im Vorder- oder Hintergrund (`background: true`), Standard-Verschachtelungstiefe 1.
- **Todos:** Tool vorhanden, aber standardmäßig aus (`experimental.todo`).
- **Befehle:** Eigene Slash-Commands als `.opencode/commands/*.md` mit `$ARGUMENTS`; über die API `GET /api/command` und `POST /api/session/{id}/command`.
- **Modell- und Agent-Wechsel:** `POST /api/session/{id}/model` und `…/agent` gelten für die folgenden Turns. Die festen Claude-Permission-Modes haben kein Gegenstück; der Agent-Wechsel plus Regeln ersetzt sie.
- **Provider:** API-Keys über `/connect`, OpenAI auch per ChatGPT-Login, Copilot per Device-OAuth, lokal Ollama/LM Studio/vLLM, „Claude Agent“ (§7).
- **Anhänge:** `uri` als `file:`- oder `data:`-URL. PNG/JPEG/GIF/WebP, PDF, Text, Verzeichnisse; max. 20 MiB.
- **Warteschlange:** Ein Inbox-Modell mit `steer` (geht in den laufenden Turn) oder `queue` (wartet auf den nächsten); Einträge listbar, umstellbar, stornierbar.
- **Fortsetzen:** Sessions liegen dauerhaft in der SQLite-DB. Liste `GET /api/session`, Verlauf `…/message`; CLI `opencode session list/export/import`.
- **Fork, Revert, Undo:** `…/fork` mit `before`; `revert/stage|commit` und `DELETE …/revert`. Snapshots: interne Git-Objekt-DB, nur Dateien im Git-Worktree.
- **Kompaktierung:** automatisch (Puffer 15 %) und `POST …/compact`.
- **Teilen:** Laut V1-SDK-Doku ist `session.share` eingestellt; die V2-Doku hat keine Share-Seite **[in V2 nicht verifiziert]**.

### 5. Übergabe ans Terminal
Im TUI setzt `opencode -s <id>` („Session ID to continue, or to create if it does not exist“) eine bestimmte Session fort, `-c` die letzte im Verzeichnis, `--fork` legt vorher einen Fork an. Mit `--server <url>` verbindet sich das TUI mit einem bestimmten Server. Läuft Parallax gegen den gemeinsamen Dienst, sehen TUI und Parallax dieselben Sessions **[Schluss aus der Architektur]**. Ein `attach`-Kommando gibt es in V2 nicht; gleichzeitiges Arbeiten zweier Clients an einer Session ist unklar. `interrupt` wirkt nur auf Ausführungen, die „owned by this OpenCode process“ sind.

### 6. Plattform, Verteilung, Reife
- **Installation:** curl, npm (`@opencode/cli`, Postinstall wählt natives Binary), Homebrew, mise, AUR, Zip-Binaries, Docker, Desktop-App.
- **Laufzeit:** natives Binary; Wechsel Bun→Node und Tauri→Electron nur laut Sekundärquellen **[unverifiziert]**; intern Effect (im Code sichtbar).
- **Reife:** Breaking Changes in Client/SDK gibt es sogar innerhalb von 2.2.x (z. B. v2.2.7: `agent.list`-Semantik, Plugin-Wartezeiten; v2.2.1: entfernte Einstiegspunkte in `@opencode/ai`). Die Release-Frequenz liegt bei mehreren Releases pro Woche. Client und CLI erscheinen in gleicher Version; Versionen pinnen.

### 7. Claude über OpenCode
- **Direkter Login:** Seit 2026 gibt es keinen direkten Claude-Pro/Max-OAuth-Login mehr. OpenCode entfernte ihn am 2026-02-19 mit dem Commit „anthropic legal requests“ (The Register).
- **Provider „Claude Agent“ (seit v2.2.3):** Er nutzt ein lokal installiertes Claude Code ≥ 2.1.248 nach `claude auth login`. „Claude Code calls the model, and OpenCode does everything else“: OpenCodes Tools und Rechte gelten, CLAUDE.md, Hooks, MCP und Skills von Claude Code werden nicht geladen. Bei Abo-Login zeigt OpenCode die Kosten als „None, your plan covers it“. Zu Anthropics Bedingungen sagt die Seite nichts.
- **Anthropic, Stand der Seite heute:**
  - „Developers building products … including those using the Agent SDK, should use API key authentication … Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users.“
  - Zugleich: Das verhindert nicht, dass „an end user [signs] in to the unmodified Claude Code binary with their own Claude subscription“.
  - Die Agent-SDK-Übersicht schreibt: „Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products“.
  - Ob der Claude-Agent-Provider darunter fällt, sagen die Quellen nicht. Dieselben Klauseln betreffen Parallax’ heutigen Ansatz ebenfalls.

### Quellen
- https://opencode.ai/docs/llms.txt (V2-Index) · https://opencode.ai/docs/migrate-v1/ · https://opencode.ai/docs/api/
- https://opencode.ai/docs/build/client/ · https://opencode.ai/docs/build/sdk/ · https://opencode.ai/docs/cli/ · https://opencode.ai/docs/cli/tui/ · https://opencode.ai/docs/cli/acp/
- https://opencode.ai/docs/permissions/ · https://opencode.ai/docs/agents/ · https://opencode.ai/docs/tools/ · https://opencode.ai/docs/commands/
- https://opencode.ai/docs/providers/ · https://opencode.ai/v2/docs/claude-agent · https://opencode.ai/docs/attachments/ · https://opencode.ai/docs/snapshots/ · https://opencode.ai/docs/compaction/
- https://opencode.ai/docs/ · https://opencode.ai/docs/troubleshooting/ · https://opencode.ai/docs/windows-wsl (V1) · https://opencode.ai/docs/server/ und https://opencode.ai/docs/sdk/ (V1)
- https://opencode.ai/changelog · https://github.com/anomalyco/opencode · https://github.com/anomalyco/opencode/releases
- Code (dev, 2026-11-11): `packages/cli/src/commands/commands.ts`, `packages/cli/src/session-target.ts`, `packages/core/src/plugin/plan.ts`, `packages/protocol/src/groups/{session,permission,event}.ts`, `packages/schema/src/{permission,question,form,prompt-input,session-event,token-usage,model}.ts`
- npm: https://registry.npmjs.org/@opencode/client · https://registry.npmjs.org/@opencode/cli · https://registry.npmjs.org/@opencode-ai/sdk
- https://code.claude.com/docs/en/legal-and-compliance · https://code.claude.com/docs/en/agent-sdk/overview
- https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access
