# Plan: „Parallax“, eine eigene Mission-Control-App für parallele Claude-Code-Sessions

> Der Name „Parallax“ ist festgelegt. Er steht im Code an genau einer Stelle (Produktname, App-ID, Titel).
> Im Umfeld der KI-Agenten ist der Name mehrfach belegt, etwa durch GradientHQ/parallax und HaruHunab1320/parallax. Für die private Nutzung ist das unkritisch.

> **Lesehinweis für die Umsetzung:**
> - Bei Widersprüchen gilt der Abschnitt **„Änderungen nach kritischem Review“** (A, B, C) vor den älteren Abschnitten.
> - Danach kommen „Umsetzungsstrategie“ und „Antworten des Nutzers vor WP-00“.
> - Der Plan ist mit dem Nutzer vollständig abgestimmt (Stand 14.10.2026).

## Context
Der Nutzer betreibt unter Windows 11 viele parallele Claude-Code-CLI-Sessions über verschiedene Projekte, jede in einem eigenen Konsolenfenster.

Es fehlt:
- eine Übersicht über alle Sessions,
- ein sichtbarer Status (arbeitet / wartet auf Permission oder Antwort / fertig),
- der Context-Füllstand,
- eine angenehme Oberfläche wie in der VS-Code-Extension.

Ergebnis der Recherche (14.10.2026):
- Kein fertiges Tool deckt alles sauber ab. Am nächsten kommen Claude Desktop (Code-Tab), Nimbalyst und Orca.
- Das offizielle **Claude Agent SDK** liefert Status, Context und Permissions als Events: `session_state_changed`, `context_usage.percentage` und `canUseTool`.
- Private Nutzung mit dem eigenen Login ist zulässig.

**Entscheidungen des Nutzers:**
- Selbst bauen.
- Chat-UI über das SDK, dazu ein Terminal-Fallback.
- React als Frontend.
- Observer-Modus für Konsolen-Sessions erst nach dem MVP.
- **Das installierte `claude` verwenden.** Es wird kein Claude-Binary mitgeliefert.
- **Für den Durchstich wird nichts installiert und keine .exe ausgeliefert.** Das Tool soll auch auf dem Arbeitsrechner laufen.

Zielordner: `d:\develop\cloudeCode\terminalWrapper` (leer, kein Git-Repo).
**Repo:** Es wird ein privates GitHub-Repo angelegt bzw. gepusht, aber nur nach Freigabe durch den Nutzer. Um den Transfer auf den Arbeitsrechner kümmert sich der Nutzer später selbst.
**Phasen und Umfang** werden am Ende gemeinsam besprochen.

---

## Grundarchitektur: lokaler Server plus Web-UI (Electron-Hülle später optional)
```
Browser (Edge im App-Modus, wirkt wie ein eigenes Fenster)
   │  WebSocket (typisiertes Protokoll) + Token
Node-Server „parallax“ (127.0.0.1)
   ├─ SessionManager ── je Session ein SDK query() → startet das INSTALLIERTE claude(.exe)
   ├─ PermissionBroker (canUseTool → Karten im UI)
   ├─ TerminalHost (node-pty, Phase 4)
   └─ Registry (%LOCALAPPDATA%\Parallax\sessions.json)
```
- **Start:** `git clone` → `pnpm install` → `pnpm start`.
  - Der Server startet unsichtbar und öffnet Edge mit eigenem Profil: `--user-data-dir=… --app=http://127.0.0.1:<port>/#code=…`.
  - Das ergibt ein eigenes Fenster ohne Browser-Leiste. Optional kann man es in Edge „als App installieren“ (PWA).
- **Voraussetzungen:** Node.js 26 (mindestens 22), pnpm 12, das installierte `claude` und ein Login. Mehr nicht.
- **Sessions leben im Server.** Wird das Fenster geschlossen, laufen sie weiter. Erst wenn der Server stoppt, stoppen auch sie. Danach lassen sie sich mit `resume` fortsetzen.
- **Update:** `git pull` → `pnpm install` → Neustart.
- **Später optional (eigene Phase):** Eine Electron-Hülle (Tray, native Toasts, Setup-.exe) bettet denselben Server und dieselbe UI ein.

### Sicherheit (wichtig, da der Server Befehle ausführen lässt)
- Der Server lauscht nur auf `127.0.0.1`.
- Zugang über einen Einmal-Code und ein persistentes HttpOnly-Cookie. Origin-, Host- und Sec-Fetch-Site-Prüfung, CSP, UNC-Filter, Spawn ohne Shell. Details stehen im Review: A.8 und C.10.

### Claude-Auflösung (`src/server/claude/resolveClaude.ts`)
- **Reihenfolge:**
  1. Pfad aus den Settings.
  2. `where claude`; bevorzugt wird das native `claude.exe`, typischerweise `%USERPROFILE%\.local\bin\claude.exe`.
  3. Bei npm-Installation wird der `.cmd`-Shim zum eigentlichen Ziel aufgelöst (JS-CLI über Node bzw. natives Binary). Das ist zu verifizieren.
- Der Pfad geht an das SDK als `pathToClaudeCodeExecutable`.
- **Versions-Hinweis:**
  - Die UI zeigt die CLI-Version (`init.claude_code_version`) und die SDK-Version an.
  - Bei Abweichung jenseits des erwarteten Bereichs erscheint eine Warnung.
  - Das SDK wird regelmäßig nachgezogen.
- **Login:** Die App nutzt den Login bzw. die Konfiguration des installierten `claude`, auf dem Arbeitsrechner also auch Firmen-Login und Managed Settings. Die App fasst keine Credentials an.
  - Ist der Nutzer nicht eingeloggt, erscheint ein Hinweis mit Terminal-Tab bzw. Anleitung.
- Das vom SDK als optionale Abhängigkeit mitgelieferte Binary wird per `ignoredOptionalDependencies` gar nicht erst installiert (siehe unten).

### Claude-Profile (Vorschlag – in Diskussion)
Mit einem Profil wird festgelegt, *wie* der Claude-Prozess gestartet wird. Es gilt für die SDK-Session und für den Terminal-Fallback gleichermaßen.

- **Eingebaut:** Das Profil „Standard“ startet das automatisch gefundene `claude` ohne Extras und ist zunächst Default.
- **Speicherort:** `%LOCALAPPDATA%\Parallax\profiles.json`, **pro Server bzw. Rechner**.
  - Pfade unterscheiden sich zwischen zuhause und Arbeit, daher liegen die Profile nicht im Repo.
  - Bei Multi-Host hat jeder Server eigene Profile und ein eigenes Default-Profil.
  - Export und Import als JSON sind optional.
  - Das Profil-API wird serverseitig gebaut (`GET/PUT /api/profiles`). Die UI liest die Profile immer vom Host der jeweiligen Session.
- **Felder:**
  - `name`, `color`, damit die Sidebar ein Profil-Chip zeigt.
  - `isDefault`: Genau ein Profil ist das Default.
  - `executable`: `auto` (Auflösung wie oben) oder ein fester Pfad.
  - `configDir`: wird als `CLAUDE_CONFIG_DIR` gesetzt, mit Ordnerauswahl. Damit sind z. B. getrennte Accounts möglich (privat / Arbeit), jeder Config-Dir hat seinen eigenen Login.
  - `env`: **beliebige** Variablen mit beliebigen Werten, ausdrücklich auch API-Keys wie der interne Key `test`. Sie werden im Klartext in `profiles.json` gespeichert, ohne Warnungen und ohne Sperren.
    - Komfort: Werte von Keys wie `*_KEY`, `*_TOKEN` oder `*_SECRET` erscheinen in der UI maskiert und lassen sich per Auge-Icon einblenden.
    - Optional ist `${env:NAME}` als Verweis auf eine Variable des Rechners möglich.
  - `contextWindow` (optional): überschreibt die Größe des Context-Fensters für die Gauge. Das ist für interne bzw. Gateway-Modelle gedacht (`ANTHROPIC_BASE_URL`), deren Fenstergröße das CLI nicht kennt.
  - `args`: zusätzliche CLI-Argumente als Liste mit einem Argument pro Zeile, also ohne Quoting-Probleme.
    - Bekannte Flags werden auf SDK-Optionen gemappt: `--model`, `--permission-mode`, `--add-dir`, `--mcp-config`, `--settings`, `--append-system-prompt`, `--allowedTools` …
    - Der Rest geht über `extraArgs` an das SDK.
    - Gesperrt sind Flags, die Parallax selbst steuert: `-p`, `--output-format`, `--input-format`, `--resume`, `--continue`, `--permission-prompt-tool`, `--replay-user-messages`.
    - `--dangerously-skip-permissions` ist erlaubt, wird aber rot markiert.
  - `defaults`: Modell, Permission-Mode und Effort als Vorbelegung neuer Sessions.
- **Auswahl beim Anlegen einer Session:** Vorausgewählt ist immer das **Default-Profil**. Wer will, wählt im Dialog explizit ein anderes. Eine Erinnerung pro Projekt gibt es nicht, das hat der Nutzer bewusst abgelehnt, weil er in Projekten häufig wechselt.
- **Kein Profilwechsel innerhalb einer Session.** Der Nutzer bestätigt: Ein anderes Profil bedeutet immer eine neue Session.
  - Komfort: Ein Projekt-Eintrag in der Sidebar bzw. das Kontextmenü einer Session bietet „Neue Session in diesem Projekt…“. Der Pfad ist vorbelegt, das Default-Profil vorausgewählt, und ein anderes Profil lässt sich explizit wählen.
- **Bindung:** Eine Session ist fest an ihr Profil gebunden, `profileId` steht in der Registry. Grund: Transkripte liegen in `<configDir>/projects`, und ein `resume` funktioniert nur mit demselben Config-Dir.
  - Ein Profil, das von Sessions benutzt wird, kann nicht gelöscht werden, nur bearbeitet. Bei einer Änderung des `configDir` erscheint eine Warnung.
- **„Profil testen“:** führt mit genau diesem Profil `claude --version` und `claude auth status` aus und zeigt Version und Login-Status. `pnpm preflight` prüft alle Profile.
- **Folgen für andere Bausteine:**
  - SDK-Session: `pathToClaudeCodeExecutable`, `env = {...process.env, ...profil.env, CLAUDE_CONFIG_DIR}`, gemappte Optionen und `extraArgs`.
  - Der Terminal-Fallback startet die CLI mit denselben Werten.
  - Verlauf laden (`getSessionMessages`/`listSessions`): Ob diese Funktionen `CLAUDE_CONFIG_DIR` pro Aufruf respektieren, ist **zu verifizieren**. Falls nicht, laufen sie in einem Child-Prozess mit Profil-Env oder lesen den Verlauf über `resume`.
  - Observer-Modus (Phase 5): Hooks bzw. Statusline werden pro Config-Dir eingetragen. Sessions mit `PARALLAX_ENTRY_ID` werden dabei ignoriert.
- **Phase:** Profile gehören in **Phase 2**. Phase 1 nutzt intern bereits dieselbe Struktur mit dem Profil „Standard“, damit später nichts umgebaut werden muss.

### Paketmanager: pnpm 12 (Registry-Nexus-tauglich)
- **Version:** `packageManager: "pnpm@12.8.2"` in `package.json`.
  - 12.8.2 erschien am 30.09.2026 und ist damit rund zwei Wochen abgehangen. `latest` ist aktuell 12.11.2 vom 09.10.
  - Zu Hause ist pnpm 9.15 installiert, deshalb einmalig `npm i -g pnpm@12.8.2` (oder pnpm lädt die festgelegte Version selbst nach; das ist zu prüfen).
  - Corepack wird mit Node 26 nicht mehr mitgeliefert.
- **Node:** Standard ist **Node 26** auf beiden Rechnern.
  - Zu Hause ist 26.4 installiert. Auf dem Arbeitsrechner installiert der Nutzer 26.
  - Node 26 wird am 28.10.2026 Active LTS und wird bis April 2029 gepflegt.
  - Die technische Untergrenze ist `engines.node: ">=22"` (pnpm 11+, Vite).
  - Eine `.node-version`-Datei mit `26` dient Versionsmanagern (fnm, nvm-windows, Volta).
  - `pnpm preflight` warnt bei einer Version unter 22 bzw. bei einer anderen Hauptversion als 26.
- **Keine fest eingetragene Registry.**
  - pnpm 11+ liest aus `.npmrc` nur noch Registry- und Auth-Einstellungen. Der Nexus-Eintrag in `~/.npmrc` auf dem Arbeitsrechner greift also.
  - Ad hoc geht es über `pnpm install --registry <url>` bzw. `pnpm_config_registry`. `npm_config_*` wird nicht mehr gelesen.
  - `pnpm-lock.yaml` enthält keine Tarball-URLs, deshalb funktioniert derselbe Lockfile ohne Trick mit npmjs und mit dem Nexus.
- **Projekteinstellungen in `pnpm-workspace.yaml`.** Der `pnpm`-Block in `package.json` wird ab pnpm 11 ignoriert.
  - `ignoredOptionalDependencies`: Die `@anthropic-ai/claude-agent-sdk-*`-Plattform-Binaries (~270 MB) werden nicht installiert, denn es wird das installierte `claude` genutzt.
  - `allowBuilds`: eine explizite Liste der Pakete, die Install-Skripte ausführen dürfen (z. B. esbuild; node-pty ab Phase 4). Zusammen mit dem Default `strictDepBuilds: true` scheitert der Install, sobald ein Paket unangemeldet etwas ausführen oder nachladen will.
  - Die Defaults bleiben: `minimumReleaseAge` (1 Tag) und `blockExoticSubdeps`.
  - Workspaces: zunächst ein Paket. Eine spätere Electron-Hülle (Backlog) kommt als `apps/electron` dazu, eventuell mit `nodeLinker: hoisted` für electron-builder.
- **Alle Abhängigkeiten müssen vollständig über die Registry beziehbar sein.** Keine Downloads per `postinstall` von GitHub, CDNs o. Ä.
  - Die node-pty-Prebuilds sind zu prüfen. Es darf kein Source-Build-Fallback greifen.
  - **Electron** kommt nicht in die Web-Variante. Die Electron-Hülle (Backlog) läuft als separates Workspace-Paket und braucht in der Firma `ELECTRON_MIRROR`.
- **Zur Laufzeit lädt Parallax nichts aus dem Internet.** Fonts und Shiki werden mitgebündelt. Ins Netz geht nur das `claude`-CLI selbst.
- **`pnpm preflight`** prüft:
  - Node-Version,
  - pnpm-Version,
  - die genutzte Registry (`pnpm config get registry`),
  - den aufgelösten `claude`-Pfad und dessen Version,
  - den Login-Status (`claude auth status`),
  - ob Edge vorhanden ist.
  - Bewusst nicht `doctor`, weil `pnpm doctor` ein eingebauter Befehl ist.
- Die README bekommt einen Abschnitt „Andere Registry / Firmen-Nexus“: `~/.npmrc` (`registry=`, Auth, `cafile`, Proxy), `--registry` und `pnpm_config_registry`.

## Stack
- **Server:** Node + TypeScript, Fastify (statische Auslieferung und API) + `ws`. Im Dev-Modus `tsx watch`.
  - `@anthropic-ai/claude-agent-sdk` wird exakt gepinnt, und zwar auf **0.3.296**. 0.3.299 ist jünger als 24 h und würde an `minimumReleaseAge` scheitern.
    - Ein CLI, das neuer ist als das SDK, ist der unterstützte Fall.
    - Regel: Das SDK nur auf Versionen anheben, die ≥ 24 h alt sind und nicht über dem ältesten CLI beider Rechner liegen.
- **Web:** Vite + React 19 + Tailwind v4 + shadcn/ui (Radix) + Lucide, State mit Zustand.
  - Darstellung: react-markdown + remark-gfm (ohne rehype-raw) bzw. streamdown, `shiki/core`, jsdiff, `virtua`.
- **Gemeinsam:** `src/shared/protocol.ts` mit typisierten WS-Nachrichten (Client↔Server).
- **Terminal (Phase 4):** @xterm/xterm + addon-fit im Browser, node-pty im Server. Prebuilds prüfen, keine Build-Tools voraussetzen.
- **Tests:** Vitest. Aufgezeichnete SDK-Message-Streams laufen gegen Normalizer und Statusmaschine.
- **Struktur:** ein Paket mit `src/server`, `src/web`, `src/shared`.
  - `pnpm dev`: Server + Vite mit Proxy.
  - `pnpm start`: Web bauen, falls nötig, Server starten, Edge-App-Fenster öffnen.

## Server-Bausteine
### SessionManager (`src/server/sessions/`)
- **Pro Session ein `query()`** im Streaming-Input-Modus. Die Prompts kommen aus einer AsyncIterable-Queue.
- **Options:**
  - `cwd`
  - `settingSources: ['user','project','local']`
  - `systemPrompt: {type:'preset', preset:'claude_code'}`
  - `permissionMode`:
    - Nur setzen, wenn das Profil ihn explizit vorgibt bzw. bei Resume den zuletzt tatsächlichen Modus.
    - Sonst weglassen, das CLI entscheidet (siehe Review C.3).
    - Bypass nur über `allowDangerouslySkipPermissions`.
  - `includePartialMessages: true`
  - `thinking: {type:'adaptive', display:'summarized'}`
  - `promptSuggestions: true`
  - `toolConfig.askUserQuestion.previewFormat: 'markdown'`
  - `env: buildEnv(profil)`: bereinigt und case-insensitiv gemischt (siehe Review C.2).
  - `pathToClaudeCodeExecutable` (aus dem Profil bzw. aufgelöst, siehe oben)
  - `canUseTool` → PermissionBroker
  - Später: `enableFileCheckpointing` + `extraArgs:{'replay-user-messages':null}` (Rewind) und `onElicitation`.
- **Normalisierung** der `SDKMessage`s in UI-Items:
  - User-Text,
  - Assistant-Text (Streaming über `stream_event`),
  - Thinking,
  - `tool_use` + `tool_result` (gepaart über die `id`),
  - System-Hinweise (`compact_boundary`, Fehler, `api_retry`),
  - Result-Zusammenfassung.
- **Statusmaschine:** `working` | `needs-permission` | `needs-answer` | `needs-review` (Plan prüfen) | `done`(+unread) | `idle` | `error` | `terminal`.
  - Abgeleitet aus `session_state_changed`, `result`, `assistant.error`, `rate_limit_event` und offenen Requests.
- **Context:**
  - Nach jedem Turn `getContextUsage({detail:'summary'})`, während des Turns eine Schätzung aus der Usage (siehe Review C.1).
  - `context_usage` gibt es nur bei `/context`.
- **Steuerung:** `interrupt()`, `setModel()`, `setPermissionMode()`, `close()` und `resume`. Die UI zeigt `init.apiKeySource` an.

### PermissionBroker
- `canUseTool` legt einen Pending-Request an (`requestId`, `toolName`, `input`, `suggestions`) und schickt ihn per WebSocket an die UI.
- **Allow:** optional „immer“ (`updatedPermissions` = `suggestions`).
- **Deny:** mit Nachricht.
- **AskUserQuestion:** Antwort über `updatedInput.answers`.
- Bricht das `signal` ab, wird die Karte entfernt.
- **Reconnect:** Offene Requests überleben einen Browser-Reload. Beim Verbinden schickt der Server den kompletten Zustand.

### TerminalHost (Phase 4; Phase 2 nutzt als Notlösung eine externe Konsole mit gleichem Handoff)
- **Handoff:**
  1. Die SDK-Query schließen.
  2. node-pty startet das installierte `claude --resume <id>` im `cwd`, mit `CLAUDE_CODE_NO_FLICKER=1` und `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1`.
  3. Die Ausgabe läuft per WebSocket zu xterm.js.
  4. Beim Exit wird die SDK-Query per `resume` wieder geöffnet und der Verlauf neu geladen.
- SDK und PTY laufen nie gleichzeitig auf einer Session.

### Registry
- `%LOCALAPPDATA%\Parallax\sessions.json`.
- **Ein Sidebar-Eintrag ist von der Claude-Session-ID entkoppelt**, weil `/clear` und `/fork` neue IDs erzeugen:
  `{id, title, titleIsCustom, profileId, cwd, currentSessionId, previousSessionIds[], pinned, lastActivity, model}`.
- Beim Serverstart werden die Sessions als „ruhend“ geladen und erst bei Interaktion per `resume` geöffnet.

## Chat-Ansicht (Vorschlag – in Diskussion; Stand CLI 2.1.299 / SDK 0.3.299)
Prinzip: kompakt wie in VS Code. Pro Tool-Call eine Zeile, aufklappbar. Spezial-Renderer gibt es für die wichtigen Tools, ein generischer Fallback (JSON/Text) für alle übrigen und künftigen Tools.

**Gerendert werden** aus `SDKMessage` und `tool_use_result`:
- **User:**
  - Text, Bilder und Dokumente.
  - Gequeuete Nachrichten erscheinen grau, bis sie verarbeitet sind.
- **Assistant:**
  - Text: Streaming-Markdown über `stream_event`-Deltas, Code-Blöcke mit Shiki und Copy-Button.
  - Thinking: eingeklappt. Wichtig: `thinking: {type:'adaptive', display:'summarized'}`, sonst ist der Text auf neuen Modellen leer.
- **Tool-Renderer:**
  - `Edit`/`Write`: Diff aus `structuredPatch`.
  - `Read`: Datei und Zeilenbereich.
  - `Bash`/`PowerShell`: Befehl und Output (einklappbar, ANSI-Farben).
  - `Grep`/`Glob`: Trefferliste.
  - `WebFetch`/`WebSearch`: URL bzw. Ergebnisse.
  - `Agent`: Subagent-Karte mit Status und Laufzeit. Subagents laufen per Default im Hintergrund (`async_launched` → später `task_notification`).
  - `TaskCreate`/`TaskUpdate`/`TodoWrite`: angepinnte Aufgabenliste.
  - MCP-Tools: Text, Bild bzw. `structuredContent`.
  - `Monitor`/Hintergrund-Tasks: Task-Karte.
- **System-Elemente:**
  - Compact-Trenner (`compact_boundary`).
  - Retry-Banner (`api_retry`).
  - Rate-Limit-Banner (`rate_limit_event`, `resetsAt`).
  - Toasts (`system/notification`).
  - Hook-Meldungen (`system/informational`).
  - „Abgelehnt“-Hinweise (`permission_denied`, Auto-Mode).
  - Memory-Chip (`memory_recall`).
  - Fehler (`assistant.error`).
  - Ein dezenter Turn-Footer (Dauer, Tokens, Kosten-Schätzung).

**Interaktion:**
- **Composer:**
  - Enter sendet, Shift+Enter macht einen Zeilenumbruch.
  - „/“-Menü (siehe unten).
  - @-Datei-Picker: Fuzzy über `git ls-files` bzw. einen Dateibaum vom Server.
  - Bild-Paste und Datei-Drop.
  - `prompt_suggestion` als Ghost-Text.
- **Während Claude arbeitet:**
  - Nachrichten werden gequeuet (`priority:'next'`).
  - „Jetzt senden“ (`priority:'now'`).
  - Stop (`interrupt()`).
- **Permission-Karten:**
  - Optionen: einmal / immer (`updatedPermissions` aus `suggestions`, mit Ziel session/local/project/user) / ablehnen mit Begründung.
  - Für Edit und Write mit Diff-Vorschau in der Karte.
  - `suppressAlwaysAllowRule` und `defaultToNo` werden respektiert.
- **Frage-Karten (AskUserQuestion):**
  - Optionen mit Vorschau (`toolConfig.askUserQuestion.previewFormat:'markdown'`), „Andere“-Freitext und Notizen.
- **Plan-Review (ExitPlanMode):**
  - Der Plan wird als Markdown angezeigt.
  - Optionen: Ausführen (Auto) / Ausführen mit manueller Freigabe / Weiter planen mit Feedback.
- **Kopfleiste der Session:**
  - Modus-Wahl: Manual / Edits automatisch / Plan / Auto; Bypass rot und nur, wenn im Profil erlaubt.
  - Modell-Picker mit Effort (`supportedModels`), Fast-Toggle.
  - Context-Gauge: Klick zeigt die Aufschlüsselung (`getContextUsage`) und einen Compact-Button.
- **Default-Permission-Mode:** Wie in der CLI-Konfiguration des Nutzers (`defaultMode`), im Profil überschreibbar. Achtung: Seit 2.1.283 ist Auto der CLI-Default.
- **Später:**
  - Agent-Map / Task-Panel (`task_*`, `background_tasks_changed`, `stopTask`).
  - Checkpoints und Rewind (`enableFileCheckpointing`, `rewindFiles`, `forkSession`).
  - `/btw` als Seitenpanel (Fork ohne Tools).
  - `!`-Bash-Modus: Der Server führt aus und injiziert die Ausgabe.
  - MCP-Elicitation-Dialoge (`onElicitation`). Ohne diese Dialoge lehnt das SDK automatisch ab.
  - Prompt-Cache-Uhr.
  - Per-Hunk-Diff-Freigabe.
- **Bekannte SDK-Lücken:**
  - MCP-OAuth läuft nicht im SDK → Terminal bzw. `claude mcp …`.
  - Kein Auto-Continue nach einem Usage-Limit → eigener Button „fortsetzen um HH:MM“.
  - Kein Live-Stdout für laufende Bash-Befehle (nur Laufzeit über `tool_progress`).
  - Agent-Teams gibt es nur interaktiv.

## Plan-Modus & Plan-Freigabe (Kernfeature – besonders sorgfältig)
Das Problem in der Konsole: Bei `ExitPlanMode` ploppt ein Dialog auf und blockiert alles. Ein Enter zur falschen Zeit gibt den Plan frei, und man kann nicht in Ruhe lesen, scrollen oder über den Plan reden.

**Grundsatz:** Claude wartet, der Nutzer nie. Alle Entscheidungs-Anfragen (Plan, Permission, Frage) sind **nicht-modal**. Nichts überdeckt den Chat, nichts stiehlt den Fokus. Während der Entscheidung bleiben Chat, Sidebar und andere Sessions voll benutzbar.

- **Plan live mitverfolgen:**
  - Schreibt Claude im Plan-Modus die Plan-Datei (Write/Edit auf `<configDir>/plans/*.md`), erkennt Parallax sie als „Plan-Datei“.
  - Sie öffnet sich auf Wunsch im Seitenpanel und aktualisiert sich live, schon während des Planens und nicht erst am Ende.
- **Plan fertig (`canUseTool('ExitPlanMode')`):**
  - Die Session bekommt den Status **`needs-review` („Plan prüfen“)** mit eigenem Icon. Sie zählt zu „Wartet auf dich“ und hat eine eigene, konfigurierbare Benachrichtigung.
  - Der Plan erscheint als **Plan-Karte** im Chat (Titel, Zusammenfassung, „Plan öffnen“) und vollständig im Seitenpanel.
    - Quelle: `input.plan` bzw. `planFilePath`. Die Feldnamen sind noch zu verifizieren.
  - Über dem Composer liegt eine **schmale angedockte Entscheidungsleiste**, kein Popup:
    `Plan v2 bereit · [Umsetzen ▾] [Weiter planen] [Plan öffnen] · Kontext 78 %`
- **Weiter planen bzw. diskutieren:**
  - Wer einfach in den Composer tippt, gibt Feedback. Technisch: deny mit `message` = Text. Claude bleibt im Plan-Modus und überarbeitet.
  - Tippen kann **nie** versehentlich freigeben.
  - Optional (Ausbau): **Inline-Kommentare** im Plan-Panel. Man markiert eine Stelle, schreibt einen Kommentar, und alle Kommentare gehen gesammelt als strukturiertes Feedback raus (Zitat + Kommentar).
- **Umsetzen (Split-Button, merkt sich die letzte Wahl):**
  - *Mit Auto-Modus* → allow + `updatedPermissions:[{type:'setMode', mode:'auto'}]`.
  - *Edits automatisch* → `acceptEdits`.
  - *Jede Änderung einzeln freigeben* → `default`/manual.
  - *Mit frischem Kontext umsetzen:* Die CLI kennt `conversation_reset` mit Trigger `plan_mode_exit`. Wie das über das SDK ausgelöst wird, ist zu verifizieren.
    - Fallback-Emulation: deny + interrupt → `/clear` → neuer Prompt „Setze diesen Plan um: …“ im gewählten Modus.
    - Diese Option wird **hervorgehoben**, sobald die Context-Gauge z. B. über 60 % liegt.
  - Freigabe nur per Klick bzw. eindeutigem Tastenkürzel, das im Fließtext nicht vorkommt. Kein nacktes Enter.
- **Plan bearbeiten vor Freigabe (Ausbau):**
  - Der Plan ist im Panel editierbar und wird mit `updatedInput` freigegeben (`planWasEdited`). Das ist noch zu verifizieren.
  - Fallback: Die Plan-Datei auf Platte wird geändert, und Claude liest sie.
- **Plan-Versionen:**
  - Jeder `ExitPlanMode`-Aufruf erzeugt v1, v2 und so weiter.
  - „Was hat sich geändert?“ zeigt den Diff zur Vorversion. Das ist hilfreich, wenn man mehrfach iteriert.
- **Nach der Freigabe:** Ein „Plan“-Button in der Kopfzeile öffnet den freigegebenen Plan jederzeit. Der Fortschritt läuft über die Aufgabenliste.
- **Dasselbe Prinzip für Permission- und Frage-Karten:**
  - Angedockt, nicht-modal.
  - Composer-Text während einer offenen Permission = „Nein, stattdessen: …“ (deny + message). Dafür gibt es einen expliziten Button „Als Antwort senden“.
  - Kein Fokus-Diebstahl, solange der Nutzer tippt.

## Anhänge, Bilder & Dateiverweise (Vorschlag – in Diskussion)
**Nutzer → Claude:**
- **Screenshots:**
  - Win+Shift+S und dann Strg+V in den Composer. Ebenso Drag & Drop aus dem Explorer oder per Büroklammer-Button.
  - Jedes Bild erscheint als Thumbnail-Chip über dem Eingabefeld: Vorschau, Entfernen, mehrere Bilder möglich.
  - Gesendet wird als `image`-Block (base64) in der User-Message.
  - Vorher verkleinert der Client auf API-taugliche Größe (lange Kante ca. 1568–2000 px, < 5 MB, PNG/JPEG/WebP).
- **PDFs:** werden als `document`-Block gesendet.
- **Andere Dateien:**
  - Der Browser kennt beim Drop keinen echten Pfad.
  - Projektdateien: über den @-Picker (relativer Pfad als @-Mention).
  - Fremde Dateien: Der Inhalt wird an den Server hochgeladen, unter `%LOCALAPPDATA%\Parallax\attachments\<eintrag>\` abgelegt und als @-Pfad in den Prompt eingefügt. Claude liest die Datei dann selbst.
- **Große Text-Pastes:** werden als Chip „[Eingefügter Text, 120 Zeilen]“ zusammengeklappt, wie in der CLI (`pasted_content`).

**Claude → Nutzer:**
- **Bilder in Tool-Ergebnissen:** z. B. ein Screenshot über das chrome-devtools-MCP, `Read` auf ein Bild oder Bash mit `isImage`.
  - Sie erscheinen inline als Thumbnail. Ein Klick öffnet eine Lightbox mit Zoom und „Speichern unter / In Ordner zeigen“.
  - Technik: Der Server zieht base64-Bilder aus allen Messages heraus, auch beim Laden des Verlaufs. Er legt sie inhaltsadressiert in einem Cache ab und schickt der UI nur `/api/blob/<hash>`. So bleiben die WebSocket-Nachrichten und der Speicher klein.
- **Dateiverweise im Text:**
  - Erkannt werden:
    - Markdown-Links,
    - `pfad:zeile`-Angaben (das Format, das Claude Code ohnehin nutzt),
    - Inline-Code und Text, der wie ein Pfad aussieht (relativ zum `cwd` oder absolut).
  - Der Server prüft per `fs.stat`, ob die Datei existiert, **aber erst nach dem UNC- und Device-Filter** (siehe Review C.10). Nur existierende Pfade werden klickbar und bekommen ein Datei-Icon.
- **Dateien aus Tool-Calls:** Write, Edit und NotebookEdit haben den Pfad im Input, die Karte ist direkt klickbar.
  - Dazu kommt ein Panel **„Dateien dieser Session“** mit allen gelesenen, erstellten und geänderten Dateien. Darüber findet man z. B. die „irgendwo generierte .md-Datei“ sofort.
- **Datei-Viewer:** eine Seitenleiste rechts bzw. ein Drawer neben dem Chat.
  - Markdown wird gerendert, mit Umschalter auf Rohtext.
  - Code mit Shiki, Sprung zur Zeile bei `pfad:zeile`.
  - Bilder, PDFs (eingebauter Edge-Viewer) und HTML (sandboxed iframe).
  - Live-Aktualisierung per `fs.watch`, solange Claude an der Datei schreibt.
  - Größenlimit für die Textvorschau (z. B. 2 MB).
- **Aktionen pro Datei:**
  - Vorschau.
  - „Im Editor öffnen“: konfigurierbarer Befehl als Vorlage mit Platzhaltern `{file}`, `{line}`, `{col}`.
    - **Default ist Notepad++:** `"<notepad++.exe>" -n{line} -c{col} "{file}"`.
    - Die exe wird gesucht über die Settings, die Registry (`HKLM\SOFTWARE\Notepad++`) und die Standardpfade unter `Program Files`.
    - Fallback, falls nicht gefunden: „Mit Standardprogramm öffnen“, **nur für eine Endungs-Allowlist** und ohne `start`/Shell (siehe Review C.10), plus ein Hinweis in `pnpm preflight`.
    - Vorlagen für VS Code (`vscode://file/{path}:{line}:{col}`) und weitere Editoren stehen in den Settings zur Auswahl.
    - Gestartet wird immer per Argument-Array mit `shell:false`.
  - „Im Explorer zeigen“ (`explorer /select,`).
  - Pfad kopieren.
- **Sicherheit:** Die Datei- und Blob-API liefert nur:
  - Pfade unter `cwd` und `additionalDirectories`,
  - Pfade, die in dieser Session explizit vorkamen (Tool-Inputs, Text),
  - eigene Attachments.
  - Immer nur mit Token.

## Slash-Befehle (Strategie, Stand CLI 2.1.299 / SDK 0.3.299)
- **Discovery beim Session-Start:**
  - Gelesen werden `init.slash_commands`, `init.terminal_slash_commands` und `supportedCommands()` (`{name, description, argumentHint, aliases, builtin}`).
  - Danach live über `system/commands_changed`, z. B. wenn MCP-Prompts dazukommen.
  - Daraus entsteht das „/“-Menü im Composer mit Fuzzy-Suche, Beschreibung und Argument-Hinweis.
- **Drei Kategorien:**
  1. **Durchreichen** als Prompt `"/name args"`. Die Ausgabe kommt als Assistant-Message bzw. Spezial-Event.
     - Built-ins: `/compact` (→ `compact_boundary`), `/context`, `/usage`, `/recap`, `/btw`, `/init`, `/code-review`, `/security-review`, `/simplify`, `/loop`, `/doctor` u. a.
     - Alle Skills, `.claude/commands`, Plugin-Skills und MCP-Prompts (`/mcp__server__prompt`).
  2. **Nativ in Parallax** über eine eigene UI und SDK-APIs. Das Tippen des Befehls öffnet dieselbe UI.
     - `/model` → Modell-Picker (`setModel`, `supportedModels`).
     - `/effort` → Effort-Auswahl (`applyFlagSettings({effortLevel})`).
     - `/fast` → Toggle (`applyFlagSettings({fastMode})`).
     - `/plan` sowie der Permission-Mode → Mode-Wahl (`setPermissionMode`).
     - **`/clear`** wird oft genutzt. Es läuft **im selben Sidebar-Eintrag** wie in der Konsole, also ohne Umweg über „Neue Session“.
       - `/clear` wird an das SDK durchgereicht, das SDK meldet `conversation_reset` mit `new_conversation_id`.
       - Parallax leert das Transkript, setzt die Context-Gauge zurück und behält Eintrag, Position, Profil und `cwd`.
       - Die alte Unterhaltung bleibt unter „Frühere Unterhaltungen“ des Eintrags erhalten und lässt sich per `resume` wieder öffnen.
       - Der Titel wird zurückgesetzt (Auto-Titel aus dem nächsten Prompt), außer er wurde manuell vergeben. Der Nutzer hat das bestätigt.
     - **`/rename`** wird oft genutzt.
       - `/rename <name>` benennt sofort um: Sidebar, Kopfzeile und Claude-Session-Titel über `renameSession()`. Der Name erscheint damit auch im `/resume`-Picker der CLI.
       - `/rename` ohne Argument macht den Titel in der Kopfzeile inline editierbar.
       - Zusätzlich: Doppelklick auf den Titel in Sidebar oder Kopfzeile, ebenso F2.
     - `/resume` → Session-Historie (`listSessions`, `getSessionMessages`).
     - `/rewind` → Checkpoint-Menü (`rewindFiles`, Fork über `resumeSessionAt`). **Später.**
     - `/fork`/`/branch` → `forkSession`.
     - `/status` → Info-Panel (`initializationResult`, `accountInfo`).
     - `/mcp` → MCP-Panel (`mcpServerStatus`, `toggleMcpServer`, `reconnectMcpServer`).
     - `/tasks` → Hintergrund-Tasks (`task_*`-Events, `stopTask`).
     - `/export`, `/copy` → Export bzw. Copy-Buttons.
     - `/diff` → `git diff` über den Server.
     - `/help` → Befehlsliste.
     - `/context` → zusätzlich strukturiert über `getContextUsage()` beim Klick auf die Gauge.
     - `/add-dir` und `/cd` → Session-Einstellungen. Dafür wird neu gestartet mit `resume`.
  3. **Nicht in Parallax** (Terminal-UI-spezifisch oder irrelevant): `/theme`, `/terminal-setup`, `/tui`, `/vim`, `/keybindings`, `/statusline`, `/ide`, `/desktop`, `/bg`, `/voice`, `/mobile`, `/install-*`, `/upgrade` …
     - Werden ausgeblendet. Wer sie tippt, bekommt „In externer Konsole öffnen“ (ab Phase 2) bzw. „Im Terminal öffnen“ (ab Phase 4) angeboten.
     - Dorthin gehen auch interaktive Dialoge ohne Argument-Form: `/permissions`, `/hooks`, `/memory`, `/plugin`, `/login`, `/config` ohne `key=value`, bis Parallax dafür eigene Panels hat.
- **Remote Control:**
  - Offiziell nur für interaktive Sessions vorgesehen.
  - Für SDK-Hosts gibt es eine **undokumentierte** Runtime-Methode `query.enableRemoteControl()` bzw. den Control-Request `remote_control`. Sie fehlt in `sdk.d.ts` und kann sich ändern.
  - Voraussetzung ist ein claude.ai-Abo-Login, mit API-Key bzw. Gateway funktioniert es nicht, bei internen Modellen also nie.
  - **Vorschlag:** Später als experimenteller Toggle pro Session, sichtbar nur bei Abo-Profilen. Fallback ist der Terminal-Tab mit `/remote-control`.

## Web-UI
- **Layout:**
  - Standard ist **Sidebar links + eine Session rechts**.
  - Flexibilität entsteht fast ohne Aufwand über die Web-Architektur. „In neuem Fenster öffnen“ startet ein weiteres Edge-App-Fenster mit `#session=<id>`, das am selben Server hängt. Jedes Fenster kann eine andere Session zeigen und lässt sich z. B. auf einen zweiten Monitor ziehen.
  - Geteilte Ansicht (2 Sessions nebeneinander oder untereinander) steht im Backlog. Die Layout-Komponente wird von Anfang an pane-fähig gebaut.
- **Sidebar:**
  - Sie ist umschaltbar: **gruppiert nach Projekt** oder **flach**, sortiert nach „wartet auf mich“ → Aktivität.
  - Oben eine Zeile „Wartet auf dich (n)“.
  - Jede Session ist ein zweizeiliger Eintrag mit einem Farbstreifen links (Profilfarbe):
    ```
    ▌ ● Refactoring Auth-Service                     2m  •
    ▌   3\4 · ⎇ feature/login · opus · ▓▓▓▓▓▓░░ 72%
    ```
    - Zeile 1: Status-Icon, Titel, letzte Aktivität, Ungelesen-Punkt.
    - Zeile 2: die letzten zwei Pfadknoten des `cwd` (`D:\1\2\3\4` → `3\4`), Git-Branch, Modell, Context-Balken (ab 70 % gelb, ab 85 % rot).
    - Tooltip: voller Pfad, Profilname, Session-ID.
  - **Git-Branch:**
    - Ermittelt per `git rev-parse --abbrev-ref HEAD` im `cwd`, aktualisiert beim Session-Start, nach jedem Turn-Ende und per Watch auf `.git/HEAD`, auch in Worktrees mit `.git`-Datei.
    - Kein Git-Repo → wird ausgeblendet. Detached HEAD → kurzer Hash.
  - **Modell:** Name aus `init.model` bzw. nach `setModel()` als Kurzname (opus/sonnet/haiku/fable oder ein Custom-Name bei internen Modellen).
  - **Titel:** anfangs der gekürzte erste Prompt, umbenennbar.
- **ChatView:**
  - Virtualisierte Liste.
  - Tool-Calls einklappbar, Edit/Write als Diff, Bash mit Ausgabe.
  - Permission- und Question-Karten.
- **Composer:** Enter sendet, Shift+Enter macht einen Zeilenumbruch. Dazu Stop, Modell- und Mode-Wahl, „In externer Konsole öffnen“ (ab Phase 2) bzw. „Im Terminal öffnen“ (ab Phase 4).
- **Kontextwechsel:**
  - Strg+K öffnet einen Quick-Switcher mit Fuzzy-Suche.
  - Alt+1..9 wählt eine Session direkt. Die Kürzel werden browser-sicher gewählt.
  - Ein Shortcut springt zur nächsten Session, die auf mich wartet.
- **Neue Session:**
  - Liste zuletzt genutzter Projekte, ein Pfadfeld und ein Ordner-Browser über die Server-API.
  - Optional ein nativer Ordnerdialog, den der Server per PowerShell öffnet.
- **Benachrichtigungen (vollständig konfigurierbar, `%LOCALAPPDATA%\Parallax\settings.json`):**
  - **Ereignisse:** Permission nötig, Frage/Antwort nötig, **Plan prüfen**, fertig, Fehler (inkl. Rate-Limit).
  - **Pro Ereignis:**
    - Windows-Toast an/aus.
    - Ton an/aus.
    - Tonauswahl aus mehreren mitgelieferten kurzen Sounds.
  - **Global:**
    - Lautstärke.
    - „Nur wenn das Fenster nicht im Fokus ist“ bzw. „auch wenn eine andere Session sichtbar ist“. Im Fokus erscheint dann ein In-App-Hinweis statt eines OS-Toasts.
    - Schalter „Nicht stören“.
  - **Technik:**
    - Web Notifications über Edge erscheinen als Windows-Toast. Ein Klick fokussiert das Fenster und die Session. Die Notification-Berechtigung wird einmalig angefragt.
    - Töne laufen über Web Audio.
    - Wegen der Autoplay-Policy wird Audio erst nach der ersten Interaktion im Fenster freigeschaltet. Zu prüfen ist, wie sich das im Edge-App-Modus verhält; ansonsten hilft ein Hinweis-Banner „Töne aktivieren“.
  - Fenstertitel und App-Badge zeigen „(n) Parallax“.
  - Phase-1-Minimum: Toast bei „wartet auf dich“ und „fertig“. Vollständige Einstellungen kommen in Phase 2.

---

## Multi-Host (Überlegung des Nutzers – Ausbau, Vorbereitung ab Phase 1)
**Szenario Arbeit:**
- Auf dem Arbeitsrechner läuft Claude gegen interne Modelle (über `env` in `settings.json`).
- Auf einer Windows-VM läuft Claude gegen Anthropic-Modelle.
- **Wunsch:** Die Sessions auf der VM sollen sich vom Parallax des Arbeitsrechners aus steuern lassen.

**Machbarkeit:** Die Server/UI-Trennung passt gut dazu.
- Auf der VM läuft ein eigener Parallax-Server, mit eigenen Profilen, eigenem `claude` und eigener Registry.
- Die UI des Arbeitsrechners verbindet sich mit **mehreren Hosts**, z. B. „Lokal“ und „VM“. Jeder Host hat eine eigene WebSocket-Verbindung.
- Die Sidebar zeigt alle Sessions mit einem Host-Badge. „Wartet auf dich“, Benachrichtigungen und Strg+K arbeiten über alle Hosts hinweg.
- Neue Sessions lassen sich wahlweise auf dem lokalen Host oder auf der VM anlegen. Ordner-Browser und Profile stammen dann vom jeweiligen Host.
- **Profile gehören zum Server, nicht zur UI** (vom Nutzer so festgelegt):
  - Jeder Server hat sein eigenes `profiles.json` und damit eigene Profile, die sich nicht überschneiden.
  - Jeder Server hat **sein eigenes Default-Profil**.
  - Im Dialog „Neue Session“ wählt man zuerst den Host. Vorausgewählt ist dann das Default-Profil *dieses* Hosts, die Profilliste zeigt nur dessen Profile.
  - Profile werden über die Settings-Seite pro Host bearbeitet.
  - Das passt bereits zur aktuellen Ablage in `%LOCALAPPDATA%\Parallax\profiles.json` auf dem jeweiligen Rechner. Es ist keine Synchronisation nötig.

**Was sich für Remote-Hosts ändert:**
- „Im Editor öffnen“ und „Im Explorer zeigen“ würden auf der VM ausgeführt. Bei Remote-Hosts werden diese Aktionen deshalb ausgeblendet. Es bleiben Vorschau und „Herunterladen“.
- Anhänge werden zum Remote-Server hochgeladen.

**Voraussetzungen und Sicherheit:**
- Der VM-Server muss vom Arbeitsrechner erreichbar sein. Dafür gibt es zwei Varianten:
  - **SSH-Tunnel:** Der VM-Server bleibt auf 127.0.0.1 und wird per `ssh -L` getunnelt. Das ist die sicherste Variante, braucht aber einen OpenSSH-Server auf der VM.
  - **Netzwerk-Bindung:** Bind-Adresse konfigurierbar, **TLS** (selbstsigniertes Zertifikat mit Pinning), **dauerhafte Pairing-Tokens** pro Client statt Token pro Start, optional eine IP-Allowlist.
  - Beide Varianten brauchen vermutlich Admin-Rechte bzw. IT-Freigabe: eine eingehende Firewall-Regel oder den sshd.
- **Compliance-Hinweis:** Prompts, Screenshots und Dateien vom Arbeitsrechner würden über die VM zu Anthropic gehen. Falls die VM-Trennung genau das verhindern soll, muss das mit der IT bzw. Compliance geklärt sein.

**Vorbereitung ab Phase 1 (billig, spart späteren Umbau):**
- Das Protokoll und die UI-State-Struktur sind **host-fähig**: Session-Keys sind `hostId:entryId`, und es gibt einen ConnectionManager für n Server, anfangs nur „local“.
- Die Bind-Adresse ist im Server konfigurierbar, Default `127.0.0.1`.
- Die Token-Logik wird so gekapselt, dass später Pairing-Tokens möglich sind.

**Umsetzung:** **im Hintergrund behalten, nicht priorisieren** (Nutzerentscheidung).
- Das System wird ab Phase 1 nur vorbereitet.
- Die eigentliche Umsetzung steht im Backlog und kommt erst nach Klärung der Netzwerk- und Policy-Lage.

**Zero-Effort-Alternative bis dahin:** Parallax läuft zusätzlich in der VM und wird per RDP genutzt. Das funktioniert sofort, ergibt aber zwei getrennte Fenster.

## Weitere Entscheidungen (zuvor offene Punkte)
1. **Server-Betrieb** (entschieden):
   - `pnpm start` bzw. ein Startskript (`parallax.cmd`/`.ps1`, ohne Installation) startet den Node-Server **unsichtbar im Hintergrund** (`Start-Process -WindowStyle Hidden` bzw. detached spawn) und öffnet nur das Edge-App-Fenster.
   - Beenden über das Menü in Parallax („Server beenden“, mit Hinweis, dass laufende Sessions gestoppt werden).
   - **Single-Instance:** Ein erneuter Start erkennt den laufenden Server (Lockfile mit Port, Token und PID in `%LOCALAPPDATA%\Parallax`) und öffnet nur ein weiteres Fenster.
   - **Port einstellbar:** Default z. B. 4711. Festgelegt über Settings, `--port` bzw. `PARALLAX_PORT`. Eine Änderung wird nach dem Server-Neustart wirksam. Ist der Port belegt, gibt es eine klare Fehlermeldung.
   - **Autostart optional:** Parallax legt auf Wunsch eine Verknüpfung im Benutzer-Autostart-Ordner an bzw. entfernt sie wieder. Das ist keine Installation.
   - Logs liegen in `%LOCALAPPDATA%\Parallax\logs`.
2. **Ressourcen & Aufräumen** (entschieden):
   - **Leerlauf-Schlaf ein- und ausschaltbar**, mit einstellbarer Dauer. Default: an, 30 Minuten.
   - Eine schlafende Session beendet ihren Claude-Prozess und setzt sich beim nächsten Klick per `resume` fort.
   - Sessions im Zustand `needs-*` schlafen nie ein.
   - **Archivieren:** Einträge verschwinden aus der Sidebar, bleiben aber unter „Archiv“ erreichbar und lassen sich wiederherstellen.
3. **Bestehende Konsolen-Sessions öffnen** (Import und Resume aus `~/.claude/projects`): **ans Ende verschoben** (Backlog).
4. **Worktrees:** **ans Ende verschoben.** Das Thema ist vom Nutzer noch nicht bewertet und wird später gemeinsam betrachtet.
5. ~~UI-Sprache~~ → **entschieden: Englisch (Default) und Deutsch, ab dem Durchstich**.
   - Typisierte Wörterbücher `src/web/i18n/en.ts` + `de.ts`. `de` hat den Typ von `en`, fehlende Keys sind damit ein Compile-Fehler.
   - Kleiner `t()`-Helper mit Interpolation und Plural.
   - Datum, relative Zeit und Zahlen über `Intl` (`RelativeTimeFormat`, `NumberFormat`).
   - Der Umschalter sitzt in den Settings und wird in `settings.json` gespeichert. Ohne Auto-Erkennung, Start immer mit Englisch.
   - Server-Fehler kommen als Codes und werden in der UI übersetzt. `pnpm preflight` und die Logs bleiben englisch.
   - Claudes Antworten sind davon unberührt.
   - Regel: kein UI-Literal ohne `t()`. Optional prüft das eine ESLint-Regel.
   - **Theme (entschieden):** Dark als Default, Light und System wählbar.
6. **Kleinkram (entschieden):**
   - Die Sidebar ist standardmäßig flach, sortiert nach „wartet auf dich“ und dann nach Aktivität. Gruppierung umschaltbar.
   - Abo-Limit-Anzeige (5h- und Wochenlimit aus `rate_limit_event`) dezent unten in der Sidebar, nur bei Abo-Profilen.
   - Auto-Titel aus Claudes Session-Summary, sobald vorhanden, bis dahin aus dem ersten Prompt.

## Änderungen nach kritischem Review (verbindlich; gehen vor ältere Abschnitte)
### A. Architektur & Robustheit
1. **Phase 0 – SDK-Spike + Fixture-Recorder vor allen Contracts.**
   - Skript-Szenarien laufen gegen das echte `claude`: Haiku, Mini-Prompts, Scratch-Ordner, mit Token-Freigabe des Nutzers.
   - Sie beantworten alle Punkte mit dem Vermerk „zu verifizieren“, z. B.:
     - ob `getSessionMessages`/`listSessions` `CLAUDE_CONFIG_DIR` respektieren,
     - die Felder von `ExitPlanMode`,
     - `/clear` → `conversation_reset`,
     - `priority`,
     - `replay-user-messages`,
     - ob `tool_use_result` im Verlauf enthalten ist,
     - `parent_tool_use_id`,
     - das Verhalten bei weggelassenem `permissionMode`,
     - Waisenprozesse nach `close`,
     - das Format der AskUserQuestion-Antworten,
     - die Auflösung von `.cmd`-Shims,
     - die Ausgabe von `claude auth status`.
   - Ergebnis: `docs/sdk-findings.md` mit Belegen und bereinigte Fixtures in `test/fixtures/sdk/*.jsonl` (`pnpm record <szenario>`).
2. **Sync-Protokoll präzisiert:**
   - **Handshake:** `hello{protocolVersion, buildId, serverInstanceId}`. Eine neue `serverInstanceId` löst einen Full-Resync aus, eine neue `buildId` einen Client-Reload, damit nach `git pull` kein alter Code in offenen Fenstern weiterläuft.
   - **Zwei Kanäle:**
     - Host-weite Session-Summaries an alle Clients: Status sofort, Context und Aktivität gedrosselt auf ≤ 1/s.
     - Transkript nur für Abonnenten über `subscribe{sessionKey, sinceSeq?}`. Pro Session gibt es eine Sequenznummer und einen Ringpuffer. Ist die Lücke im Puffer, wird ein Replay geschickt, sonst ein Snapshot der letzten N Items plus `loadEarlier`.
   - **Befehle** tragen eine `cmdId`, der Server bestätigt mit `ack` und ist idempotent.
   - **Entscheidungen** tragen eine Server-ID, und der erste Klick gewinnt. Andere Fenster erhalten `decisionResolved`.
   - **Stabile Item-IDs** (`messageUuid:blockIndex`), identisch für live und Verlauf.
   - **Text-Deltas** werden serverseitig alle 30–50 ms gebündelt, der Client wendet sie pro Animation-Frame an.
3. **Source of Truth** (korrigiert nach dem technischen Review):
   - Für die **Anzeige** ist das Transkript ein **eigenes append-only-Log normalisierter Items** pro Unterhaltung unter `PARALLAX_HOME/entries/<id>/transcript.jsonl`.
     - Grund: `getSessionMessages` liefert kein `tool_use_result`, keine Timestamps und liest `CLAUDE_CONFIG_DIR` prozessweit.
   - Das Claude-JSONL bleibt maßgeblich für Claudes Kontext und `resume`. Gelesen wird es nur als Fallback bzw. für Import, und zwar in einem `worker_threads`-Worker pro Config-Dir, weil jeder Worker sein eigenes `process.env` hat.
   - Live-only-Events (Deltas, Retry, Rate-Limit, Hooks) gehen bei einem Neustart verloren. Das wird akzeptiert.
   - Offene Entscheidungen leben im Speicher, ihre Metadaten werden persistiert.
   - Plan-Versionen, Attachments und „Dateien dieser Session“ liegen unter `PARALLAX_HOME/entries/<id>/`.
   - Sidebar-Daten stehen in `sessions.json` (kleiner Index), Entwürfe und Panelgrößen im `localStorage`.
   - Der **Normalizer hat zwei Eingangsadapter** (live und Verlauf) mit identischen Items.
   - Renderer verlassen sich nicht allein auf `tool_use_result`, den Diff gibt es zur Not aus `old_string`/`new_string`.
4. **Statusmodell neu:**
   - `runState`: starting | working | waiting(permission|question|plan) | idle | sleeping | error | interrupted | external/terminal.
   - Getrennte Flags: `unread`, `backgroundTasks`, `rateLimitedUntil`, `compacting`.
   - Eine reine Funktion `deriveDisplayStatus()` in `src/shared` gilt für Server und UI.
5. **Hintergrund-Arbeit beachten:**
   - Ein `result` heißt nicht „fertig“, solange Subagents, Monitor, Hintergrund-Bash, Wakeups oder `/loop` laufen.
   - Eine Session schläft nie bei laufender Arbeit, offener Entscheidung, `backgroundTasks > 0`, geplantem Wakeup, gequeueten Prompts oder einem Handoff.
   - „Fertig“-Toasts gibt es erst ohne Hintergrund-Arbeit.
   - Schlafende Einträge zeigen die zuletzt gespeicherte Zusammenfassung.
6. **Mehrere offene Entscheidungen pro Session** (z. B. von Hintergrund-Subagents):
   - Sie stehen in einer Queue. Die Leiste zeigt die älteste plus „+n weitere“.
   - Jede Karte nennt den Fragesteller (Haupt-Agent oder Subagent).
7. **Env-Builder entfernt Session-Variablen der aufrufenden Claude-Session:**
   - Betroffen sind `CLAUDECODE`, `CLAUDE_CODE_{ENTRYPOINT,SESSION_ID,CHILD_SESSION,EXECPATH,SESSION_ATTENDED,SSE_PORT}`, `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_CODE_BRIDGE_*`, `CLAUDE_PID` und `CLAUDE_EFFORT`.
   - Sie würden sonst bei Entwicklung bzw. Start aus Claude Code heraus in jede Session lecken.
   - Danach werden das Profil-Env sowie `PARALLAX=1` und `PARALLAX_ENTRY_ID` gesetzt.
   - **`PARALLAX_HOME`** überschreibt das Datenverzeichnis, `PARALLAX_PORT=0` ist erlaubt. Tests und Dev-Läufe fassen nie das echte `%LOCALAPPDATA%\Parallax` an.
   - Das produktiv genutzte Parallax läuft später aus einem separaten Checkout bzw. Build, damit Dev-Neustarts nicht die eigene Arbeits-Session killen.
8. **Auth überarbeitet:**
   - Der Launcher öffnet `…/#code=<einmal-code>`. Die Seite tauscht den Code per `POST /api/auth` gegen ein **persistentes HttpOnly-, SameSite=Strict-Geräte-Cookie** (Port im Namen) und entfernt ihn sofort per `history.replaceState`.
   - Das Secret liegt persistent und rotierbar in `PARALLAX_HOME`. Damit funktionieren `<img src=/api/blob/…>`, iframes, Downloads, neue Fenster (`window.open`) und Server-Neustarts.
   - SameSite ignoriert den Port. Deshalb sind **Origin-, Host- und `Sec-Fetch-Site`-Prüfung Pflicht** für jeden nicht-GET-Request und den **WS-Upgrade** (im `upgrade`-Handler, mit `@fastify/websocket`). Im Dev-Modus kommt die Vite-Origin dazu.
   - `Origin: null` wird abgelehnt. Kein Token in WS-URLs, keine CORS-Header.
   - Edge läuft mit **eigenem `--user-data-dir`** und `--no-first-run`. So landen keine Token-URLs in der privaten Browser-Historie, und die Notification-Berechtigung bleibt stabil.
9. **Benachrichtigungen entscheidet der Server:**
   - Die Clients melden Präsenz (Fokus, Sichtbarkeit, angezeigte Session). Pro Ereignis wählt der Server genau einen Kanal:
     - einen In-App-Hinweis im fokussierten Fenster, oder
     - eine Web Notification aus genau einem Client, oder
     - **ohne offenes Fenster** einen nativen Windows-Toast über einen PowerShell-Helfer (`Windows.UI.Notifications`, ohne Installation). Auf dem Arbeitsrechner ist der Constrained Language Mode zu prüfen.
   - Ein Toast hat `tag = sessionKey` und den Text „‹Titel› – Plan prüfen“.
   - Ein Klick öffnet über einen optionalen HKCU-Protokoll-Handler `parallax:` (Opt-in wie Autostart) die richtige Session.
   - Beim Schließen des letzten Fensters erscheint einmalig der Hinweis „Parallax läuft weiter (n aktiv)“.
   - Das Präsenz-Protokoll kommt in Phase 1, der native Fallback in Phase 2.
10. **Neustart/Crash bei offenen Entscheidungen:**
    - Plan-Versionen und Entscheidungs-Metadaten sind persistiert. Nach einem Neustart ist die Karte read-only „abgelaufen“ (der Plan bleibt lesbar), der Status ist `interrupted`.
    - Aktionen: „Fortsetzen & Plan freigeben“ bzw. „Fortsetzen“.
    - Bei einem Prozess-Crash wird der Status `error` und es gibt den Button „Neu starten (resume)“. Ein Auto-Retry erfolgt nur aus `idle`, mit Backoff und höchstens 3-mal.
    - „Server beenden“ listet vorher die arbeitenden und wartenden Sessions.

### B. Weitere wichtige Punkte
- **Persistenz:** ein `JsonStore<T>`:
  - zod-Schema, `schemaVersion`, Migrationen,
  - atomar über Temp-Datei und Rename, mit Retry bei EPERM/EBUSY (Virenscanner bzw. Indexer),
  - `.bak` als Sicherung, Quarantäne korrupter Dateien plus UI-Warnung,
  - ein einziger Writer, Debounce.
  - Fehlende Entry-Felder werden ergänzt: `schemaVersion`, `createdAt`, `archived`, `lastRunState`, `contextPct`, `permissionMode`, `effort`, `cliVersion`, `lastError`, `conversations[]` mit Datum und Titel.
- **`cwd` exakt behalten** (korrigiert nach dem technischen Review):
  - Das CLI verschlüsselt Transkripte über den `cwd`-String *wie übergeben*, inklusive der Groß- und Kleinschreibung des Laufwerksbuchstabens. In `~/.claude/projects` liegen deshalb `D--…` und `d--…` doppelt vor.
  - Pro Eintrag wird der exakte String gespeichert und immer wiederverwendet. **Kein `realpath.native`**, weil das subst-Laufwerke und Junctions auflösen würde.
  - Vergleiche und Gruppierung laufen intern case-insensitiv über einen gemeinsamen Pfad-Helper. Bei Lookups per ID wird `dir` weggelassen.
- **Claude-Auflösung:**
  - `claude.exe.old.*` wird ignoriert.
  - `.cmd`-Shims brauchen seit dem Node-CVE-Fix `shell:true` bzw. eine Shim-Auflösung.
  - Die CLI-Version gilt **pro Session** (`init.claude_code_version`), weil sich das CLI im laufenden Betrieb selbst aktualisiert.
- **Message-Routing:**
  - `parent_tool_use_id` wird unter der Agent-Karte einsortiert, in Phase 1 eingeklappt.
  - `input_json_delta` wird verarbeitet.
  - Die finale `assistant`-Message ersetzt den gestreamten Teil, der Abgleich läuft über die Message-ID.
- **Speicher und Performance:**
  - Tool-Output pro Item auf ca. 32–64 KB gekappt, dazu „vollständig laden“ über HTTP.
  - Transkripte nicht abonnierter Sessions werden aus dem Cache verdrängt.
  - Eine Anzeige zeigt Prozesse und RAM.
  - Markdown: fertige Blöcke werden gecacht, nur das Ende wird neu geparst.
  - Shiki läuft nur auf geschlossenen Code-Blöcken und lädt Sprachen lazy.
  - Die Liste bleibt am unteren Ende kleben, Zustand-Selektoren gibt es pro Session.
- **Tastatur:**
  - **Keine Strg+Alt-Kürzel**, weil AltGr auf deutschem Layout = Strg+Alt ist (`@ € { [ ] } \ ~ |`).
  - Strg+W/N/T sind nicht abfangbar.
  - Eine zentrale Shortcut-Registry mit `?`-Hilfe.
  - Entscheidungs-Kürzel gelten nur, wenn die Leiste den Fokus hat.
  - Stop über Esc bei leerem Composer.
- **Entwürfe:** Composer-Entwürfe werden pro Session im `localStorage` gehalten.
- **Gequeuete Nachrichten:** Jede Nachricht bekommt eine eigene `uuid`. Sie gilt als übernommen, sobald sie in `user_message_uuids` einer Antwort erscheint. Ob `replay-user-messages` zusätzlich nötig ist (später auch für Rewind), klärt der Spike.
- **Tests ohne Token-Verbrauch:** Port-Interface `AgentBackend` mit `SdkBackend` und **`FakeBackend`** (Szenario-DSL, spielt Fixtures ab, wartet auf Entscheidungen, simuliert Crashes). Ebenen:
  1. Unit-Tests: Normalizer, Status, Pfade, `JsonStore`, Args-Parser, `resolveClaude`.
  2. Fixture-Contract-Tests mit Snapshots. Ein SDK-Upgrade wird so als Diff sichtbar.
  3. Server-Integrationstests: echter WS-Client, FakeBackend, Temp-`PARALLAX_HOME`, Port 0.
  4. E2E mit **Playwright und `channel:'msedge'`**, ohne Browser-Download.
  5. Live-Smoke nur mit `PARALLAX_LIVE=1` und Haiku.
  - **Aufzeichnungen vom Arbeitsrechner kommen nie ins Repo.**
- **SDK-Upgrade-Prozess** (`docs/sdk-upgrade.md`): Version anheben → typecheck → Fixture-Tests → neu aufzeichnen → Snapshot-Diff → Zähler für unbekannte Message-Typen prüfen → Live-Smoke.
- **First-Run und Fehler:**
  - Ein Setup-Screen, falls `claude` fehlt bzw. kein Login besteht: Preflight in der UI, Pfadwahl, Retry.
  - Empty State mit zuletzt genutzten Projekten.
  - Fehlerbanner mit Aktionen.
  - Notification- und Ton-Berechtigung nur auf Klick.
- **Windows-Prozesse:**
  - Prozessbäume werden mit `taskkill /T /F` beendet.
  - Waisen aus dem Lockfile werden beim Start aufgeräumt (PID, Name, Startzeit prüfen).
  - Edge wird über ShellExecute bzw. App Paths gestartet, weil `msedge` nicht im PATH liegt.
  - Das Lockfile wird per authentifiziertem Health-Ping validiert.
- **Datei- und Editor-Sicherheit:**
  - `realpath` vor dem Allowlist-Check. UNC-, Device- und ADS-Pfade werden abgelehnt.
  - **Niemals `start "" "{file}"`**, denn `&` im Dateinamen führt zu Command-Injection. Programme werden per Argument-Array ohne Shell gestartet, bzw. über `explorer.exe`.
  - Der Logger maskiert Env-Werte und Tokens.
- **Claude-Settings:** `settingSources:user` lädt auch Plugins und Hooks des Nutzers in die Parallax-Sessions. Das ist gewollt, aber zu beachten. Parallax warnt, wenn dieselbe Session parallel in einer Konsole fortgesetzt wird (zwei Writer auf einem JSONL).
- **Dev-Experience:**
  - `pnpm dev` nutzt standardmäßig das **FakeBackend**, weil `tsx watch`-Neustarts sonst echte Sessions killen. `pnpm dev:live` ist explizit.
  - tsconfig-Projektreferenzen (server/web/shared) plus `no-restricted-imports`: Web importiert nie Server-Code.
- **Vereinfachungen:**
  - Multi-Host-Vorbereitung nur clientseitig: `hostId` lebt nur in der Connection-Map, der Server bleibt host-agnostisch.
  - Profil-Args: Strukturierte Felder gibt es nur für SDK-gesteuerte Flags, alles andere wird unverändert durchgereicht, nur gegen eine Blocklist geprüft.
  - Git-Branch wird bei Turn-Ende, bei Fensterfokus und alle 60 s für sichtbare Sessions aktualisiert, ohne `.git/HEAD`-Watcher.
  - „Fertig“-Toasts nur bei Turns > 20–30 s oder ohne Fokus, Serien werden gebündelt.
  - Kosten nur bei API-Key-Profilen anzeigen.
  - `promptSuggestions` ist ein Setting, weil es pro Turn einen extra Request kostet.
  - Ein PWA-Manifest bzw. App-Badge kommt erst ins Backlog, weil es mit dem Auth-Bootstrap kollidiert (ein PWA-Start hat keinen Code). Der Zähler „(n)“ steht im Fenstertitel.
  - i18n-Dateien pro Feature-Bereich, Lint mit `react/jsx-no-literals`.
  - `@fastify/websocket`, pino mit Redaction und Rotation.
  - Optional automatisches Weiterlaufen nach einem Rate-Limit-Reset.
  - Barrierearmut: Status als Icon plus Text, nicht nur Farbe.

### C. Technische Korrekturen (gegen SDK-Typings 0.3.299 und CLI-Binary 2.1.299 geprüft)
1. **Context-Gauge:**
   - `assistant.context_usage` gibt es **nur bei `/context`-Antworten**.
   - Richtig ist: nach jedem Turn (`session_state_changed:idle` bzw. `result`) `getContextUsage({detail:'summary'})` aufrufen. Das kostet keinen API-Call und liefert `percentage`, `totalTokens` und `rawMaxTokens`.
   - Während eines Turns wird geschätzt: letzte Main-Thread-Usage (input + cache_creation + cache_read + output) geteilt durch `rawMaxTokens` bzw. `modelUsage[model].contextWindow`.
   - `detail:'full'` nur beim Klick und mit Fehlerbehandlung, weil Gateway-Modelle Token-Counting eventuell nicht können.
   - Der Profil-Override `contextWindow` wird zusätzlich als `settings:{autoCompactWindow:N}` übergeben (100k–1M), sonst kompaktiert das CLI an der falschen Stelle.
2. **`buildEnv()` (eine Funktion für SDK, Terminal, externe Konsole und „Profil testen“):**
   - Basis ist `process.env`. Entfernt werden:
     - `CLAUDECODE` und `CLAUDE_CODE_*` (außer einer Allowlist, z. B. `CLAUDE_CODE_GIT_BASH_PATH` und `CLAUDE_CODE_USE_POWERSHELL_TOOL`),
     - `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_*`,
     - `npm_*`, `PNPM_*`, `INIT_CWD`, `NODE_ENV`, `NODE_OPTIONS`,
     - Einträge von `node_modules\.bin` im PATH.
   - Das Profil-Env wird **case-insensitiv** gemischt, z. B. `PATH` gegen `Path`.
   - Danach gesetzt: `PARALLAX=1`, `PARALLAX_ENTRY_ID`, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `CLAUDE_AGENT_SDK_CLIENT_APP=parallax/<ver>`.
   - Der Launcher startet `node <abs>/dist/server.js` direkt, nicht über `pnpm run`.
3. **Permission-Mode:**
   - **Nicht selbst aus den Settings lesen.** Der Grund ist der Trust-Filter des CLI gegen eskalierende Modi aus Repo-Settings sowie die Managed- und Policy-Ebene.
   - Neue Session: `permissionMode` wird weggelassen, außer das Profil setzt ihn explizit. Das CLI entscheidet dann wie bei `claude -p`.
   - Die UI zeigt immer den **tatsächlichen** Modus aus `system/init.permissionMode` bzw. `system/status.permissionMode`.
   - Bei Resume (Schlaf, Neustart) wird der **zuletzt tatsächliche Modus** aus der Registry übergeben.
   - Bypass braucht `allowDangerouslySkipPermissions:true` **beim Start** der Query. Das Profil-Flag wird darauf gemappt, nicht auf `extraArgs`.
   - Das SDK kennt kein `manual`. „Manual“ ist nur das UI-Label für `'default'`.
4. **Plan-Freigabe (verifiziert):**
   - `setMode` braucht **`destination:'session'`**, also `{type:'setMode', mode, destination:'session'}` für alle Optionen. Niemals `userSettings`.
   - Den Mode immer explizit senden. Das CLI würde sonst den Modus von *vor* dem Plan-Modus wiederherstellen.
   - `plan` und `planFilePath` werden vom CLI in den `canUseTool`-Input injiziert. Sie sind nicht im öffentlichen Typ, also tolerant behandeln.
   - Plan-Datei-Pfad immer aus `planFilePath` nehmen, weil es eine `plansDirectory`-Setting gibt.
   - **Plan bearbeiten funktioniert:** `updatedInput.plan` geändert → das CLI schreibt die Datei und setzt `planWasEdited`. Das kann damit früher kommen.
   - **„Mit frischem Kontext“** hat keinen SDK-Request. Ablauf als Fallback:
     1. deny mit `interrupt:true`,
     2. `/clear`,
     3. auf `conversation_reset` warten,
     4. `setPermissionMode(gewählt)`,
     5. „Implement the plan in `<planFilePath>`“ senden.
5. **Event-Details:**
   - „Fertig“ kommt aus `session_state_changed:'idle'`. Es wartet auf Hintergrund-Arbeit, und idle bzw. result kommen in beliebiger Reihenfolge.
   - **Stop killt Hintergrund-Subagents**, solange `perTaskStopAffordance` nicht gesetzt ist. Bis zum Task-Panel bleibt das bei Default, danach wird es aktiviert.
   - `system/init` kommt zu Beginn jedes Turns. Es wird aktualisiert, nicht zurückgesetzt.
   - Nach `/clear` wird `new_conversation_id` sofort als aktuelle Session-ID gespeichert.
   - `rate_limit_event` kommt auch mit `allowed`. Nur `rejected` ist ein Fehler, `allowed_warning` erzeugt ein Banner.
   - `result.startup_failure_reason` (`shell_tool_missing`, `cwd_unavailable`, `org_*`) und `assistant.error:'authentication_failed'` erzeugen einen Login- bzw. Setup-Hinweis.
   - Nicht freigegebene Projekt-MCP-Server aus `.mcp.json` werden im SDK abgelehnt. Das wird in der UI angezeigt.
   - Das `stderr`-Callback geht ins Log.
6. **`/rename`:**
   - Bei einer laufenden Session wird `/rename <name>` über die Session gesendet. Ob das im SDK funktioniert, prüft der Spike.
   - `renameSession()` nur bei ruhenden Sessions, weil es ins JSONL schreibt, das das laufende CLI parallel schreibt.
   - Auto-Titel: Nach einem `result` wird `getSessionInfo` gepollt. Ob SDK-Sessions überhaupt KI-Titel bekommen, prüft der Spike.
7. **Claude-Auflösung:**
   - Nur `.exe` wird verwendet. Den npm-Shim auf `…\node_modules\@anthropic-ai\claude-code\bin\claude.exe` auflösen. Das extensionslose sh-Skript aus `where` überspringen.
   - Die SDK-Plattform-Binaries auszulassen ist verifiziert unkritisch, es gibt keine Auflösung beim Import.
   - **Versionsregel:** rot, wenn das CLI älter ist als `package.json#claudeCodeVersion` des SDK; sonst nur Info. Die Version wird pro Session angezeigt.
8. **Prozesse:**
   - libuv beendet `claude.exe` mit dem Server, aber **dessen Kinder** (Bash, MCP-Server, Dev-Server, Monitor) überleben einen harten Kill.
   - „Server beenden“:
     1. `close()` auf alle Queries,
     2. bis zu 5 s warten,
     3. `taskkill /PID <pid> /T /F`.
   - PIDs werden über einen `spawnClaudeCodeProcess`-Wrapper erfasst und mit Startzeit gespeichert, für die Waisen-Bereinigung beim nächsten Start.
   - `windowsHide:true` gilt für **jeden** serverseitigen Spawn.
   - Launcher: `process.execPath` detached, stdio ins Log, `unref()`.
   - Single-Instance über `/api/health` mit Instanz-UUID statt PID-Prüfung.
   - Autostart mit absolutem `process.execPath`, weil fnm bzw. nvm beim Logon nicht im PATH sind.
9. **Edge:**
   - Edge über App Paths (HKLM/HKCU) bzw. Program Files (x86) finden und per Argument-Liste spawnen, ohne `cmd /c start`.
   - Ein eigenes Profil: `--user-data-dir=%LOCALAPPDATA%\Parallax\edge --no-first-run`. Es kostet ca. 100–200 MB extra, isoliert dafür Token, Historie und Sync.
   - Ob Firmen-Policies `--user-data-dir` erlauben, ist zu prüfen.
   - Ein neues Fenster öffnet sich per `window.open(…,'popup')` aus der App und erbt das Cookie.
10. **Sicherheit (kritisch):**
    - **UNC/SMB-Leak:** Vor **jedem** Dateisystemzugriff werden abgelehnt:
      - `\\…`, `//…`, `\\?\` und `\\.\`,
      - ein `:` nach dem Laufwerksbuchstaben (ADS),
      - reservierte Namen (CON, NUL, COM1 …),
      - Punkt bzw. Leerzeichen am Ende.
      - Grund: Ein `fs.stat` auf einen Pfad aus Claudes (injizierbarem) Text würde sonst den NTLM-Hash an fremde Server senden.
    - **Editor und Standardprogramm:**
      - Die Vorlage wird einmal in ein Argument-Array zerlegt, die Platzhalter werden pro Argument ersetzt, dann `spawn(exe, args, {shell:false})`.
      - VS Code öffnet über `vscode://file/{path}:{line}:{col}`.
      - „Mit Standardprogramm öffnen“ nur für eine Endungs-Allowlist (txt, md, json, Bilder, pdf). Ausführbare Typen (exe, bat, cmd, lnk, url, hta, js, vbs, msi, scr) **nie**, dort gibt es nur „Im Explorer zeigen“: `explorer.exe /select,"<p>"` mit `windowsVerbatimArguments`.
    - **XSS = Codeausführung**, denn die UI kann Profile, Executables und Bypass setzen. Deshalb:
      - Eine strikte **CSP**: `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:PORT`. Das erzwingt auch „nichts aus dem Internet“.
      - Kein `rehype-raw` und kein `dangerouslySetInnerHTML`. ANSI wird escaped. Links nur http(s).
      - `/api/file` und `/api/blob` liefern mit `nosniff`, `CSP: sandbox; default-src 'none'` und `CORP: same-origin`.
      - HTML-Vorschau nur in einem `<iframe sandbox>` ohne `allow-same-origin`. SVG nur per `<img>`.
11. **Anhänge:**
    - Der Attachment-Ordner des Eintrags kommt in `additionalDirectories`, sonst fragt jedes Read nach einer Permission.
    - Dateinamen sind `<hash>.<ext>`.
    - `bodyLimit` wird pro Upload-Route erhöht, `maxPayload` für den WebSocket explizit gesetzt.
12. **Profil-Args:**
    - `extraArgs` ist ein Record: keine wiederholten Flags, ein Wert pro Flag. Mehrwertige Flags werden auf SDK-Optionen gemappt: `additionalDirectories`, `allowedTools`, `disallowedTools`, `plugins`, `betas`.
    - **Allowlist mit Schalter „roh durchreichen“** statt Blocklist. Zusätzlich gesperrt: `--print`, `--session-id`, `--fork-session`, `--setting-sources`, `--system-prompt*`, `--max-turns`, `--json-schema`, `--resume-session-at`, `-w`, `--remote`, `--teleport`, `--sdk-url`.
    - Pauschale `--allowedTools`-Einträge umgehen `canUseTool`. Dafür gibt es einen Warnhinweis.
    - Ein geändertes `--append-system-prompt` greift bei fortgesetzten Sessions nicht, weil ein System-Prompt-Snapshot verwendet wird.
13. **pnpm und Firma:**
    - `engines.pnpm: ">=12.8"`, damit ein altes pnpm sofort scheitert.
    - pnpm 12 ist eine native exe. Falls AppLocker/WDAC sie blockiert, ist pnpm 11.28 der Fallback.
    - **Nexus-Auth:** `_auth` in `~/.npmrc` wird von pnpm 11+ eventuell ignoriert. Es gilt nur aus dem globalen `config.yaml` bzw. `pnpm_config__auth`. **Erster Spike auf dem Arbeitsrechner: `pnpm install` gegen den Nexus.**
    - `minimumReleaseAge` greift beim Nexus eventuell nicht, falls das `time`-Feld fehlt.
    - `allowBuilds` braucht nur `esbuild`.
    - node-pty 1.1 fällt auf `node-gyp rebuild` zurück. Für Phase 4 ist `@lydell/node-pty` (Prebuilds ohne Skripte) eine Alternative, die zu prüfen ist.
14. **Kleinkram:**
    - `!`-Bash über `shouldQuery:false`.
    - Pfaderkennung auch für `/c/…`, `C:/…` und `pfad:zeile:spalte`, von rechts geparst.
    - Git-Branch nicht über einen Watch auf `.git/HEAD`, sondern über Polling bzw. Turn-Ende.
    - Markdown-Streaming über `streamdown` oder memoisierte Blöcke. `shiki/core` mit JS-Regex-Engine.
    - Virtualisierung über `virtua` oder `content-visibility:auto` statt tanstack.
    - ca. 150–300 MB RAM pro Session einplanen, optional `prewarm()`.

## Phasen (Vorschlag – in Diskussion)
**Phase 1: Durchstich.** Eine Session funktioniert von vorn bis hinten.
- **Fundament:**
  - `git init`, pnpm 12.8.2 und Node 26.
  - `pnpm-workspace.yaml` mit `ignoredOptionalDependencies` und `allowBuilds`.
  - Fastify + ws, Vite + React + Tailwind + shadcn, `src/shared/protocol.ts`.
  - i18n-Grundgerüst (en/de), Theme (Dark/Light/System).
  - `pnpm preflight`.
- **Server-Betrieb:**
  - Token, nur localhost, Origin-Prüfung.
  - Port einstellbar, Single-Instance-Lock.
  - Unsichtbarer Start und Edge-App-Fenster, Menüpunkt „Server beenden“.
- **Claude:** Auflösung des installierten `claude`. Intern gibt es bereits die Profil-Struktur mit dem Profil „Standard“.
- **Host-fähige Grundstruktur** für ein späteres Multi-Host-Setup:
  - Session-Keys der Form `hostId:entryId` und ein ConnectionManager, anfangs nur „local“.
  - Bind-Adresse konfigurierbar, gekapselte Token-Logik.
- **Eine Session:**
  - SessionManager, Normalizer und Statusmaschine.
  - Streaming-Chat mit den Kern-Renderern: Text, Thinking, Edit/Write-Diff, Bash/PowerShell, Read, Grep/Glob, generischer Fallback.
  - Nachrichten-Queue, Stop, Context-Gauge, Modell- und Mode-Wahl.
- **Nicht-modale Karten:**
  - Permission (einmal / immer / ablehnen mit Text).
  - AskUserQuestion.
  - **Plan-Freigabe als Grundversion:** Plan-Karte, Plan im Seitenpanel, angedockte Entscheidungsleiste, Feedback per Tippen.
  - Diese Karten sind nötig, weil die Session sonst hängt.
- **Minimale Toasts:** „wartet auf dich“ und „fertig“.

**Phase 2: Mission Control (MVP für den Alltag).**
- **Viele Sessions:**
  - Sidebar flach bzw. gruppiert. Zweizeilige Einträge mit Pfad-Ende, Branch, Modell, Context und Profilfarbe.
  - Zeile „Wartet auf dich“.
  - Strg+K, Alt+1..9 und „nächste wartende Session“.
  - „In neuem Fenster öffnen“.
- **Registry & Lebenszyklus:**
  - Entkoppelte Einträge, Resume nach Neustart.
  - Leerlauf-Schlaf (umschaltbar), Archiv.
- **Neue Session:**
  - Dialog mit zuletzt genutzten Projekten und Ordner-Browser.
  - Profilwahl.
  - „Neue Session in diesem Projekt…“.
- **Profile vollständig:**
  - Editor, Config-Dir, Env, Args, Context-Fenster-Override.
  - „Profil testen“.
- **Slash-Menü:**
  - Discovery und Durchreichen.
  - Nativ: `/model`, `/effort`, `/fast`, `/plan`, `/clear` (im selben Eintrag), `/rename`, `/status`, `/help`.
  - Terminal-Befehle mit Hinweis.
- **Screenshots:** Paste, Drop und Thumbnails. Bilder aus Tool-Ergebnissen inline mit Lightbox, über den Blob-Cache.
- **Benachrichtigungen vollständig:** pro Ereignis Toast und Ton, Lautstärke, „Nicht stören“, Fokus-Regel.
- **Settings-Seite:** Sprache, Theme, Port, Autostart, Editor, Benachrichtigungen, Leerlauf.
- **Sonstiges:**
  - Abo-Limit-Anzeige.
  - Rate-Limit-Banner mit „Fortsetzen um HH:MM“.
- **Notlösung für Terminal-Befehle:** „In externer Konsole öffnen“.
  1. Die SDK-Query wird geschlossen.
  2. In einem neuen Konsolenfenster startet `claude --resume <id>` mit dem Profil.
  3. Mit „Zurückholen“ geht es danach in Parallax weiter.

**Phase 3: Dateien & Plan-Komfort.**
- **Dateien:**
  - Klickbare Dateiverweise.
  - Datei-Viewer: Markdown, Code mit Zeilensprung, Bild, PDF, live.
  - Panel „Dateien dieser Session“.
  - „Im Editor öffnen“ (Notepad++ als Default) und „Im Explorer zeigen“.
  - PDFs und Datei-Drops als Anhang, Paste-Chips.
  - @-Datei-Picker, Prompt-Vorschläge als Ghost-Text.
- **Plan-Komfort:**
  - Plan-Datei live während des Planens.
  - Plan-Versionen mit Diff.
  - „Mit frischem Kontext umsetzen“, hervorgehoben bei hohem Context.
  - Split-Button, der sich die letzte Wahl merkt.
- **Hintergrund-Tasks:**
  - Subagent- und Task-Karten.
  - Angepinnte Aufgabenliste.
  - Task-Panel mit Stop.

**Phase 4: Eingebetteter Terminal-Tab.** xterm.js und node-pty mit sauberem Handoff. Ersetzt die externe Konsole aus Phase 2 für `/permissions`, `/hooks`, `/login`, `/plugin`, MCP-OAuth und Remote Control.

**Phase 5: Observer-Modus.** Live-Sessions aus normalen Konsolen erscheinen read-only in der Sidebar.
- Datenquellen: HTTP-Hooks, Statusline-POST und `claude agents --json`.
- Aktion „In Parallax übernehmen“.

**Backlog (später; Reihenfolge nach Bedarf):**
- **Multi-Host:** die Sessions der Arbeits-VM vom Arbeitsrechner aus steuern, mit Profilen und Default-Profil pro Server. Ab Phase 1 vorbereitet, umgesetzt erst nach Klärung von Netzwerk und Policy.
- Rewind/Checkpoints, Fork.
- `/btw`-Seitenpanel, `!`-Bash-Modus.
- MCP-Panel und Elicitation-Dialoge.
- Plan: Inline-Kommentare und Plan editieren.
- Split-View, Prompt-Cache-Uhr, Per-Hunk-Diff-Freigabe.
- Remote Control (experimentell).
- **Bestehende Konsolen-Sessions importieren**, **Worktrees** (erst bewerten).
- Suche über Sessions.
- Electron-Hülle (Tray, Setup-.exe).

## Umsetzungsstrategie: Hauptkontext frei halten, Arbeit über Subagenten (Nutzerwunsch)
### Rollen
- **Koordinator (Hauptagent):**
  - Liest nur `CLAUDE.md`, `docs/progress.md`, die Contracts (`src/shared/**`) und Subagent-Berichte.
  - Liest **keinen Implementierungscode**. Für Fragen dazu setzt er einen Explore-Subagenten an.
  - Führt eine Todo-Liste der aktuellen Welle.
- **general-purpose:** implementiert ein Arbeitspaket (WP). Mit read-only-Auftrag übernimmt er auch Verifikation und Review.
- **Plan:** entwirft vor dem Coden die zwei schwierigsten Pakete (Sync-Protokoll mit Item-Modell, Session-Engine).
- **Explore:** schlägt in `node_modules/@anthropic-ai/claude-agent-sdk/*.d.ts` und im Code nach, damit diese Inhalte nicht im Hauptkontext landen.
- **Rückfragen:** Subagenten fragen den Nutzer nicht selbst. Sie melden `BLOCKED: <frage>`, der Koordinator sammelt und stellt die Fragen.
- **Parallelität:** maximal 3–4 parallel. Optional Sonnet für UI- und Boilerplate-Pakete, Opus für Spike, Contracts, Normalizer, Engine und Integration.

### Dauerhafter Zustand im Repo (übersteht Kontext-Kompaktierung)
- `CLAUDE.md` (≤ 150 Zeilen): Stack, Befehle, Ordner-Ownership, Konventionen. Wird von jedem Subagenten automatisch geladen.
- `docs/plan.md`: dieser Plan inklusive Review-Änderungen.
- `docs/architecture.md`: Module, Datenfluss, Source-of-Truth-Tabelle, Sync-Protokoll.
- `docs/sdk-findings.md` und `docs/sdk-upgrade.md`.
- `docs/progress.md`:
  - WP-Tabelle (ID, Status, Commit, Ergebnis in einer Zeile, Follow-ups),
  - Contract-Changelog,
  - offene Fragen an den Nutzer,
  - nächste Schritte.
- `docs/decisions.md`: kurze ADRs, nur anhängen.
- `docs/wp/WP-xx.md`: der exakte Auftrag plus ein ausführlicher Ergebnisteil, vom Subagenten geschrieben. Details bleiben so aus dem Hauptkontext heraus, und ein WP lässt sich identisch erneut ausführen.

### Regeln in `CLAUDE.md` (gelten für jeden Subagenten)
- **Code:** TypeScript strict, kein `any`, zod an jeder Grenze (WS, HTTP, Dateien, Env). Fehlercodes kommen aus `src/shared/errors.ts`.
- **UI und Logging:** Kein UI-String ohne `t()`. Logging nur über `logger`.
- **Abhängigkeiten im Code:**
  - Web importiert nie Server-Code.
  - Helfer nur in `*/lib`. **Vor dem Anlegen eines Helfers erst greppen**, ob es ihn schon gibt.
  - UI-Primitives nur aus `src/web/ui`, mit Design-Tokens.
- **Tests:**
  - `*.test.ts` liegen neben dem Code.
  - Immer mit `PARALLAX_HOME=<tmp>` und `PARALLAX_PORT=0`.
  - **Kein Live-`claude`**, außer das WP erlaubt es ausdrücklich.
- **Tabu ohne Freigabe:** `package.json`, Lockfile und `src/shared/**`. Änderungen daran werden im Bericht angefragt.
- **Windows:** Pfad-Helfer und `taskkill` für Prozessbäume. Gestartete Hintergrundprozesse am Ende beenden.

### Auftrag und Bericht
- **Ein Auftrag enthält:**
  - Ziel,
  - Pflichtlektüre,
  - Besitz-Pfade und Tabu-Pfade,
  - Abnahmekriterien als Befehle,
  - ob ein Live-`claude` erlaubt ist,
  - Commit-Anweisung.
- **Der Bericht** hat höchstens 250 Wörter und ein festes Format:
  - Status,
  - geänderte Pfade,
  - Schnittstellen bzw. Contract-Abweichungen,
  - ≤ 3 Entscheidungen,
  - Checks (typecheck, lint, Tests),
  - gewünschte Abhängigkeiten,
  - Follow-ups,
  - Commit.

### Phase-1-Arbeitspakete (kritischer Pfad: 00 → 01 → 02 → 12 → 13 → 20 → 22)
| WP | Inhalt | Abhängig | Ausführung |
|---|---|---|---|
| 00 Bootstrap | Configs, pnpm-workspace, tsconfig-Referenzen, ESLint und Prettier, Vitest, Vite-Proxy, Tailwind + shadcn-Basis, Ordner- und lib-Gerüst. **Alle Phase-1-Dependencies vorab installieren.** Initial-Commit. | – | sequenziell |
| 01 SDK-Spike + Recorder | `scripts/record`, Fixtures, `docs/sdk-findings.md` (live, Haiku) | 00 | sequenziell |
| 02 Contracts | `src/shared/{protocol,model,errors,status}` (zod), `AgentBackend`-Interface, `architecture.md`, `CLAUDE.md` v1 | 01 | sequenziell (Plan → GP) |
| 10 Server-Plattform | App, Config, Auth, HTTP/WS, Sync mit Seq und Ringpuffer, `JsonStore`, Logger | 02 | Welle 1a, Worktree |
| 11 Claude-Integration | `resolveClaude`, Env-Builder, Profil „Standard“, `pnpm preflight` | 02 | Welle 1a, Worktree |
| 12 Normalizer + Status | zwei Adapter, Snapshots aller Fixtures, `deriveDisplayStatus` | 01, 02 | Welle 1a, Worktree |
| 14 Web-Shell + State | WS-Client mit Resync, Stores, Theme, i18n-Kern, Playground-Route | 02 | Welle 1a, Worktree |
| 13 Session-Engine | FakeBackend, Broker (mehrere Entscheidungen), Manager (Queue, Interrupt, Modell und Mode, Crash/interrupted), SdkBackend | 11, 12 | Welle 1b, Worktree |
| 15 Transkript-Renderer | Streaming-Markdown, Diff, Bash, Fallback, virtualisierte Liste | 14 | Welle 1b, Worktree |
| 16 Entscheidungen + Composer | Permission-, Frage- und Plan-Karten, Leiste, Queue, Stop, Entwürfe, Picker, Gauge | 14 | Welle 1b, Worktree |
| 20 Integration + E2E | Verdrahtung, Playwright (msedge) auf dem FakeBackend | 10–16 | Welle 2 |
| 21 Betrieb/Launcher | unsichtbarer Start, Lock und Health-Ping, Edge-Profil, `/auth`-Cookie, „Server beenden“ | 10 | Welle 2, Worktree |
| 22 Live-Abnahme | Phase-1-Checks gegen echtes `claude`, Screenshots | 20, 21 | Welle 3 |
| R0–R3 Reviews | read-only nach jeder Welle: Konventionen, Duplikate, i18n, Import-Grenzen, Sicherheit; `/code-review` am Ende | – | nach jeder Welle |

### Verifikationsleiter
1. Der Subagent prüft sein eigenes Paket: `tsc`, `eslint` und `vitest` auf seine Pfade.
2. Der Koordinator prüft bei jedem Merge:
   - `git diff --stat` liegt nur in den Besitz-Pfaden,
   - danach komplettes `pnpm check`.
3. Pro Welle ein Verifier-Subagent:
   - App auf FakeBackend mit Port 0 und Temp-Home,
   - Playwright,
   - Screenshots dark/light × en/de über das chrome-devtools-MCP,
   - meldet nur, fixt nicht.
4. Meilenstein: Live-Abnahme (WP-22).

### Commits, Merges, Fallstricke
- **Commit-Policy** wird einmalig mit dem Nutzer geklärt. Vorschlag:
  - lokale Commits pro WP und Merge-Commits erlaubt, **nie pushen** ohne Freigabe,
  - Worktree-Pakete auf `wp/xx`, der Koordinator merged nacheinander,
  - Welle 1b startet erst nach dem Merge von Welle 1a.
- **Fallstricke und Gegenmittel:**
  - Lockfile-Konflikte: alle Dependencies in WP-00, neue nur über den Koordinator.
  - Gemeinsame Registrierungsdateien: Pakete exportieren nur Module, die Verdrahtung macht erst WP-20.
  - Contracts: eingefroren, Änderungen nur per Anfrage.
  - Ressourcen: Temp-Home und Port 0. Jeweils nur ein Subagent nutzt das chrome-devtools-MCP.
  - Windows-Worktrees: Worktree-Ordner aus tsconfig, Vitest, ESLint, Vite-Watcher und `.gitignore` ausschließen; `git config core.longpaths true`; `pnpm install` pro Worktree.

### Antworten des Nutzers vor WP-00
1. **Commits:** Lokale Commits pro WP und Merge-Commits sind erlaubt, **nie pushen** ohne Freigabe.
2. **pnpm 12.8.2** darf global installiert werden (`npm i -g pnpm@12.8.2`).
3. **Live-Aufrufe gegen Claude:** Der Nutzer hat **keine API-Abrechnung** eingerichtet und nutzt den Abo-Login des CLI.
   - Live-Aufrufe laufen deshalb **ausschließlich über das installierte `claude` mit dem bestehenden Abo-Login**, genau wie in der Konsole. Kein API-Key, keine API-Abrechnung.
   - Erlaubt sind nur WP-01 (Spike) und WP-22 (Abnahme), mit Haiku, Mini-Prompts und einem Scratch-Ordner. Der Verbrauch liegt grob im niedrigen fünfstelligen Token-Bereich, aus dem Abo-Kontingent.
   - **Vor dem ersten Live-Aufruf** bestätigt der Nutzer das in der Umsetzungs-Session einmal kurz.
   - Der Spike prüft dabei zugleich das **Grundrisiko des Projekts**: dass das Agent SDK mit dem Abo-Login funktioniert. Laut Help Center vom 07.10.2026 ist das so: SDK und `claude -p` funktionieren mit Abo-Limits, Max enthält zusätzlich API-Credits für das SDK.
   - Klappt das nicht (Auth-Fehler, `credits_required`), wird **sofort gestoppt** und der Nutzer informiert, bevor weitergebaut wird.
4. **Sprache (bestätigt):**
   - **Dokumentation auf Deutsch**: README, `docs/**`, `CLAUDE.md`, WP-Aufträge und -Berichte, `progress.md`, `decisions.md`.
   - **Code-Bezeichner und Code-Kommentare auf Englisch.**
   - **Commit-Messages auf Deutsch**, mit mehreren `-m`-Flags und ohne Heredoc (globale Nutzerregel).
   - Die UI ist zweisprachig (en Default, de), die Kommunikation mit dem Nutzer läuft auf Deutsch.
   - **Eigenes Edge-Profil: bestätigt.**

### Fallback, falls Live-Aufrufe nicht möglich sind
Diese **Variante ohne Live-Aufrufe** greift, wenn der Abo-Login im SDK nicht funktioniert oder der Nutzer ablehnt:
- Die Fixtures werden synthetisch aus `sdk.d.ts`, den Docs und dem Changelog erstellt.
- Die Subagenten starten niemals ein echtes `claude`.
- Die Live-Prüfung läuft als **manuelle Checkliste** für den Nutzer. Später lassen sich echte Mitschnitte aus der Nutzung über den Dev-Schalter „Rohstream aufzeichnen“ als Fixtures übernehmen.
- Das Risiko: Fehlannahmen über das Event-Format fallen erst bei der ersten echten Nutzung auf.

## Risiken und Leitplanken
- **Policy:** Nur das installierte, unveränderte `claude` unter dem eigenen Login. Keine Credentials anfassen, keine Weitergabe.
- **Versionsdrift:** Das installierte CLI aktualisiert sich selbst, das SDK ist gepinnt. Dagegen helfen die Versionsanzeige mit Warnung und unbekannte Message-Typen tolerant ignorieren.
- **Lokaler Server:** Token, nur localhost, Origin-Prüfung.
- **Arbeitsrechner:**
  - Node muss vorhanden sein.
  - Der npm-Registry-Zugriff muss erlaubt sein.
  - Der Edge-App-Modus ist in der Regel unproblematisch.

## Verifikation
- **Phase 1:**
  - `pnpm start` öffnet das Edge-App-Fenster. Ohne Token antwortet der Server mit 401, ein fremder Origin wird abgewiesen.
  - Die Claude-Auflösung findet das installierte `claude`. Die angezeigte Version stimmt mit `claude --version` überein.
  - In einem Scratch-Projekt erzeugt „lege test.txt an“ eine Permission-Karte. Nach Allow existiert die Datei.
  - Stop bricht ab. Eine AskUserQuestion-Karte lässt sich beantworten.
  - Der Context-Wert ist plausibel im Vergleich zu `/context`.
  - Nach einem Browser-Reload ist der Zustand inklusive offener Karte wieder da.
- **Phase 2:**
  - Drei Sessions in verschiedenen Ordnern laufen parallel.
  - Die Status-Wechsel sind korrekt (working → needs-permission → working → done+unread → idle).
  - Ein Toast erscheint, ein Klick führt zur Session.
  - Nach einem Server-Neustart lassen sich die Sessions fortsetzen.
  - Eine Session lässt sich auch in der Konsole mit `claude --resume <id>` fortsetzen.
- **UI-Checks** über das chrome-devtools-MCP (Seite unter localhost), Screenshots.
- **Arbeitsrechner:**
  - `git clone` + `pnpm install` + `pnpm start` laufen über den Nexus-Mirror, ohne Admin-Rechte und ohne weitere Installation.
  - Zuhause ist mit demselben Lockfile ein `pnpm install --frozen-lockfile` gegen npmjs möglich.
  - `pnpm preflight` zeigt die Nexus-Registry an.
  - Das Install-Log (`pnpm install --reporter=ndjson` bzw. ein Netzwerk-Mitschnitt) zeigt keine Downloads außerhalb der Registry.
  - Das `node_modules` enthält keine `claude-agent-sdk-win32-*`-Binaries.
