# SDK-Findings (WP-01: Spike gegen das echte `claude`)

**Stand:** 15.10.2026 · **CLI** 2.1.300 (`C:\Users\<USER>\.local\bin\claude.exe`, Abo-Login „Claude Max“)
· **SDK** `@anthropic-ai/claude-agent-sdk` 0.3.296 (`claudeCodeVersion` im SDK-Manifest: 2.1.296)
· **Modell** `haiku` (= `claude-haiku-5-5`, 1M-Kontextfenster) · Node 26.4.0 · Windows 11.

**Nachträge:** 16.10.2026 aus der Live-Abnahme WP-22 (`docs/wp/WP-22.md`, Abnahme 15.10., Nachprüfung
16.10.2026; gleiche CLI 2.1.300 und SDK 0.3.296). Sie stehen als „Nachtrag 16.10.2026 (WP-22)“ bei den
betroffenen Punkten; die ursprünglichen Befunde bleiben unverändert stehen.

Der Plan wurde gegen SDK 0.3.299 / CLI 2.1.299 geprüft. Alle dort zitierten APIs existieren auch in
0.3.296 (`perTaskStopAffordance`, `suppressAlwaysAllowRule`, `defaultToNo`, `toolConfig.askUserQuestion`,
`renameSession`, `stopTask`, `getContextUsage({detail})`, `applyFlagSettings`, `spawnClaudeCodeProcess`,
`conversation_reset` mit `trigger: 'plan_mode_exit'`, …). `query.enableRemoteControl()` fehlt wie erwartet
in `sdk.d.ts`, ist aber in `sdk.mjs` vorhanden. Abweichungen betreffen fast nur das **Laufzeitverhalten**
und **untypisierte Zusatzfelder** (siehe unten).

**Belege:** `szenario#seq` = Datei `test/fixtures/sdk/<szenario>.jsonl`, Event mit dieser `seq`.
Befehlsausgaben sind mit `$` markiert (E-Mail/Org geschwärzt). Aufgezeichnet mit `pnpm record`
(siehe „Recorder“). Rohaufzeichnungen liegen nur lokal in `.recordings/` (git-ignoriert).

---

## Die wichtigsten Abweichungen vom Plan (Kurzfassung)

1. **`/clear`: `new_conversation_id` ist nicht die neue Session-ID.** Nach `/clear` tragen `init` und alle
   Messages eine *dritte* ID; `getSessionInfo(new_conversation_id)` liefert nichts. Plan C.5 („nach
   `/clear` `new_conversation_id` als Session-ID speichern“) ist falsch → `session_id` des nächsten
   `system/init` übernehmen (Punkt 7).
2. **„Immer erlauben“ = alle `suggestions` ist gefährlich:** Die Vorschläge enthalten fast immer
   `{type:'setMode', mode:'acceptEdits', destination:'session'}` und `addRules` mit Ziel
   `localSettings` (schreibt `<cwd>\.claude\settings.local.json`). Ungefiltert zurückgegeben wechselt
   die Session in `acceptEdits`, danach laufen `rm`/`touch` ohne Rückfrage (Punkt 3).
3. **Wiederholte Bash-Abfragen trotz Regel:** Eine `addRules`-Regel (Ziel `session` oder `localSettings`,
   auch zusammen mit `addDirectories`) verhinderte die erneute Abfrage desselben `mkdir`-Befehls nicht;
   die CLI fragt wegen `blockedPath` erneut (Punkt 3).
4. **Weggelassener `permissionMode` ergab `default`, nicht `auto`** (dieses Konto/diese CLI; Auto ist
   offenbar nicht eingerichtet). Der Default ist also maschinen-/kontoabhängig (Punkt 2).
5. **Plan-Modus mit Haiku plant auf Sonnet 5.5:** Alle Requests bis zur Freigabe liefen auf
   `claude-sonnet-5-5`, danach wieder Haiku (~96 % der Spike-Kosten). Modellanzeige muss aus
   `assistant.message.model` kommen, nicht aus `init.model` (Punkt 6).
6. **`getSessionMessages` liefert Timestamps** (Plan A.3: „keine Timestamps“), aber weiterhin kein
   `tool_use_result`; das Roh-JSONL enthält `toolUseResult` (Punkt 15).
7. **`CLAUDE_CONFIG_DIR` wird pro Aufruf aus `process.env` gelesen**, ein `worker_threads`-Worker mit
   eigenem `env` ist isoliert – das Worker-Konzept aus A.3 funktioniert (Punkt 15).
8. **Neuer, untypisierter Message-Typ `command_lifecycle`** (`queued`/`started`/`completed`/`cancelled`
   je gesendeter User-Message-UUID) und `system/session_title_changed` – beide fehlen in der
   `SDKMessage`-Union von 0.3.296 (Punkte 9, 8).
9. **Mit eigenem `spawnClaudeCodeProcess` ruft das SDK den `stderr`-Callback nicht auf** – der Wrapper
   muss stderr selbst lesen (sonst läuft die Pipe voll). Die PID gibt es alternativ über
   `initializationResult().pid` (Punkt 16).
10. **Token-Verbrauch:** Jeder Request liest ~27 k Tokens System-Prompt/Tools (Nutzer-Plugins, Skills,
    MCP) – der Spike verbrauchte ~2,1 Mio. Tokens (93 % Cache-Reads) statt „niedrig fünfstellig“;
    geschätzte Kosten 0,22 USD, Abo-5h-Fenster von 0 % auf 1 % (Abschnitt „Verbrauch“).

> **Nachtrag 16.10.2026 (WP-22):** Nr. 4 gilt nicht mehr allgemein – in der Abnahme wechselte der
> Default derselben CLI für dasselbe Konto von `default` auf `auto` (Punkt 2). Neu dazu: der KI-Titel
> steht auch in `getSessionInfo().customTitle` (Punkt 8), `total_cost_usd` begann nach einem Resume bei
> 0 (Punkt 14), nach hartem Server-Abbruch überleben Tool-Prozesse (Punkt 16).

---

## Punkt 1 – Auth mit Abo-Login, `apiKeySource`, `init`-Felder

- **Frage:** Funktioniert das SDK mit dem Abo-Login des installierten `claude`? Was steht in `system/init`?
- **Ergebnis:** Ja. `system/init.apiKeySource` = **`"none"`** (= kein API-Key, claude.ai-OAuth),
  kein `assistant.error`, `result.is_error=false`, kein `startup_failure_reason`.
  `accountInfo()` → `{email, organization, subscriptionType:"Claude Max", apiProvider:"firstParty"}`.
  `rate_limit_event` meldet `overageStatus:"rejected"`, `overageDisabledReason:"out_of_credits"` – es
  gibt keine API-Credits, Abrechnung läuft über das Abo.
  `init` kommt **zu Beginn jedes Turns erneut** (Plan C.5 bestätigt) und enthält: `cwd`, `session_id`,
  `tools` (31, u. a. `Bash` **und** `PowerShell`, `AskUserQuestion`, `ExitPlanMode`, `Agent`), `mcp_servers`
  (`{name, status:"pending", source}` – beim ersten `init` noch *pending*), `model:"claude-haiku-5-5"`,
  `permissionMode`, `slash_commands` (70), `terminal_slash_commands`, `apiKeySource`,
  `claude_code_version:"2.1.300"`, `output_style`, `agents`, `skills`, `plugins` (mit Pfaden),
  `capabilities` (`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`,
  `msg_lifecycle_v1`, `request_marker_lists_v1`, `sdk_mcp_*`, `mcp_read_resource_v1`,
  `mcp_tool_ui_meta_v1`, `ui_surface_v1`), `fast_mode_state`, `view_mode`; **untypisiert**:
  `analytics_disabled`, `product_feedback_disabled`, `memory_paths`, `messaging_socket_path`,
  `per_turn_effort_active`, `powershell_path`.
  `initializationResult()` enthält zusätzlich `pid`, `current_permission_mode`, `session_state`,
  `account`, `models`, `commands`, `remote_control_available:true` u. a.
- **Beleg:** `auth-probe#7` (init), `#9` (rate_limit_event), `#18` (result), `#21` (mark auth-ok),
  `#26` (initializationResult), `#27` (accountInfo).
- **Konsequenz:** Grundrisiko geklärt. `apiKeySource` in der UI anzeigen; `init` bei jedem Turn als
  Update behandeln. `mcp_servers.status` aus `init` ist beim Start unzuverlässig (pending) →
  `mcpServerStatus()` bzw. spätere `init`s nutzen.

> **Nachtrag 16.10.2026 (WP-22):** Mit dem echten Startweg (`pnpm start`, SdkBackend) bestätigt:
> `apiKeySource: "none"`, kein Auth-/Billing-Fehler. `rate_limit_event` brachte den Hinweis
> „Approaching the usage limit – 79–81 % used · seven_day“ (Wochenfenster des Kontos). Ohne Modell im
> Profil folgte die CLI `ANTHROPIC_MODEL=haiku` aus der Server-Umgebung (`claude-haiku-5-5`).

## Punkt 2 – Weggelassener `permissionMode`

- **Ergebnis:** Ohne `permissionMode` startete die Session in **`default`**
  (`init.permissionMode`, `initializationResult().current_permission_mode`), obwohl `supportedModels()`
  für Haiku `supportsAutoMode:true` meldet. Die Nutzer-Settings haben kein `permissions.defaultMode`;
  in `slash_commands` steht `auto-mode-setup` (Auto vermutlich nicht eingerichtet). Ein
  `setPermissionMode()` im Leerlauf erzeugt **kein** `system/status`; der Modus erscheint im nächsten
  `init`. Während eines Turns kommt `system/status` mit `status:null, permissionMode:<neu>`.
- **Beleg:** `auth-probe#7`, `#26`, `#24` (Haiku-Zeile), `#29`/`#33` (setPermissionMode, keine Message);
  `permissions#285`, `plan-mode#101` (status bei Moduswechsel im Turn).
- **Konsequenz:** Plan C.3 bleibt richtig („weglassen, tatsächlichen Modus anzeigen“), aber Parallax
  darf nicht annehmen, dass „weggelassen = auto“. Modus aus `init`/`status`, bei Leerlauf-Änderung
  zusätzlich lokal setzen (der Server weiß, was er gesetzt hat).

> **Nachtrag 16.10.2026 (Quelle: WP-22, Befund WP22-04; ADR-080):** In der Abnahme am 15.10.2026
> (CLI 2.1.300, SDK 0.3.296, dasselbe Konto) startete die erste Session um 22:21 ohne `permissionMode`
> noch in `default`; ab ≈ 23:20 starteten neue **und** fortgesetzte Sessions in **`auto`**
> (`initializationResult().current_permission_mode`, auch per SDK-Probe ohne Prompt – für einen neuen
> Ordner und für den Ordner der Session von 22:21; Transkript `permissionMode: "auto"`; in
> `~/.claude.json` u. a. `hasSeenAutoDefaultNotice`). Im Auto-Modus legte Claude eine Datei per
> `Set-Content` ohne Permission-Karte an. Der Default ist also nicht nur konto-/maschinenabhängig,
> sondern kann im Lauf ohne Versionswechsel umspringen; „weggelassen = `default`“ gilt nicht mehr
> allgemein. Parallax setzt bewusst **keinen** eigenen Modus (Plan C.3, ADR-080): es zeigt den
> tatsächlichen Modus aus `init`/`system/status` (auch einen Wechsel durch die CLI im Turn); wer immer
> gefragt werden will, wählt „Manual“ bzw. setzt `defaultMode` (der Live-Smoke wählt „Manual“ vor dem
> ersten Prompt).

## Punkt 3 – `canUseTool`: Signatur, Optionen, Entscheidungen

- **Typings 0.3.296:** `(toolName, input, {signal, suggestions?, blockedPath?, mcpServer?,
  decisionReason?, title?, displayName?, description?, defaultToNo?, suppressAlwaysAllowRule?,
  toolUseID, agentID?, requestId, matchedAskRule?}) => Promise<PermissionResult | null>`.
  `suppressAlwaysAllowRule` und `defaultToNo` **existieren**. `PermissionResult` hat zusätzlich
  `toolUseID?` und `decisionClassification?` (`user_temporary|user_permanent|user_reject`).
- **Beobachtet:** `suggestions`, `blockedPath`, `displayName`, `description`, `toolUseID`, `requestId`,
  `decisionReason` (nur einmal: `"This command requires approval"`) und **untypisiert**
  `decisionReasonType` (`"other"`, `"subcommandResults"`) sowie `requiresUserInteraction:true`
  (bei AskUserQuestion/ExitPlanMode). Nicht beobachtet: `title`, `agentID`, `defaultToNo`,
  `suppressAlwaysAllowRule`, `matchedAskRule`, `mcpServer`. Bei mehreren Tool-Calls in einer
  Assistant-Message kommen die `canUseTool`-Aufrufe **nacheinander**; während eine Entscheidung offen
  ist, steht `session_state_changed:requires_action`.
- **Suggestions:** Write/Edit → nur `[{type:'setMode', mode:'acceptEdits', destination:'session'}]`;
  Bash → `[{addRules:[{toolName:'Bash', ruleContent:'<ganzer Befehl>'}], behavior:'allow',
  destination:'localSettings'}, {addDirectories:[<cwd>|<blockedPath>], destination:'session'},
  {setMode acceptEdits, session}]`; PowerShell → teils `addRules`, teils nur
  `addDirectories`+`setMode`, teils gar keine.
- **Entscheidungen:**
  - *allow einmal* (`updatedInput` = Input) → Tool läuft (`permissions#41`).
  - *allow „immer“ nur mit `addRules`, Ziel → `session`* (`permissions#46`) → derselbe Befehl wurde
    **erneut abgefragt** (`permissions#162`); ebenso mit `addRules`+`addDirectories` (session)
    (`permissions-rules#112` → `#197`) und mit `addRules` (localSettings) (`#371` → `#406`, Datei
    `.claude\settings.local.json` wurde geschrieben, `#465`). Ursache laut Optionen: `blockedPath`
    (Pfad-Prüfung, die eine Befehlsregel nicht überstimmt).
  - *allow „immer“ mit allen Suggestions* (`permissions#282`) → `system/status mode=acceptEdits`
    (`#285`), danach `touch` **ohne** `canUseTool` (`#314`–`#318`), Regel in `settings.local.json` (`#330`).
  - *deny mit `message`* → `tool_result` `is_error:true` mit genau der Nachricht, `tool_use_result`
    = `"Error: <message>"`, Claude antwortet weiter, `result` `success`, Eintrag in
    `result.permission_denials` (`permissions#201`, `#205`, `#214`).
  - *deny mit `interrupt:true`* → `tool_result` „The user doesn't want to proceed …“
    (`tool_use_result:"User rejected tool use"`), User-Text `[Request interrupted by user for tool use]`,
    `result` **`error_during_execution`**, `is_error:true`, `terminal_reason:"aborted_tools"`,
    `command_lifecycle:cancelled`; die Session bleibt benutzbar (`permissions#236`–`#244`, `#259`).
- **Konsequenz (Contracts/WP-13/16):** „Immer“ nie als ungefilterte `suggestions` senden. Karte:
  `setMode` als **eigene, explizite** Option („Edits automatisch“) anzeigen; `addRules`/`addDirectories`
  mit wählbarem Ziel. Die Karte darf nicht „nie wieder fragen“ versprechen. `decisionReasonType`,
  `requiresUserInteraction` tolerant übernehmen. `interrupt:true`-Deny ist ein Fehler-`result`, aber
  kein Session-Fehler → Status `idle`/`interrupted`, nicht `error`. `decisionClassification` mitsenden.

> **Nachtrag 16.10.2026 (WP-22):** Live bestätigt: Write/Edit bieten nur `setMode acceptEdits`, keine
> Regel. Eine „Immer erlauben · Diese Session“-Regel für einen PowerShell-Befehl ohne Pfad
> (`ping -n 30 …`) verhinderte die erneute Abfrage desselben Befehls (kein `.claude\settings.local.json`
> im Projekt). Eine PowerShell-Karte für eine Datei **im** Projektordner meldete „Outside the allowed
> folders: <cwd>\notify.txt“ – der Text kommt aus der CLI (`blockedPath`).

## Punkt 4 – Write/Edit/Read/Bash/PowerShell: `tool_use_result` live

- **Write (neu):** `{type:"create", filePath, content, structuredPatch:[], originalFile:null,
  userModified:false}` – **bei neuen Dateien ist `structuredPatch` leer** (`permissions#43`).
  Write (Update): `type:"update"` (`plan-mode#100`).
- **Edit:** `{filePath, oldString, newString, originalFile, structuredPatch:[{oldStart, oldLines,
  newStart, newLines, lines:["-alpha","+beta"]}], userModified, replaceAll}` (`permissions#160`).
- **Read:** `{type:"text", file:{filePath, content, numLines, startLine, totalLines}}` (`plan-mode#188`).
- **Bash:** `{stdout, stderr, interrupted, isImage, noOutputExpected}`, LF; leere Ausgabe →
  `tool_result` „(Bash completed with no output)“ (`permissions#48`). Hintergrund:
  `backgroundTaskId`, untypisiert `backgroundedToDeliverMessage:true` (`queue-priority#107`).
- **PowerShell:** wie Bash ohne `noOutputExpected`, Ausgabe mit **CRLF** (`permissions#170`).
- **Konsequenz:** Diff-Renderer: Write-Create als „neue Datei“ aus `content` rendern (kein Patch);
  Edit aus `structuredPatch`. Bash/PowerShell-Renderer müssen `\r\n` normalisieren.

## Punkt 5 – AskUserQuestion

- **Input:** `{questions:[{question, header, multiSelect:false, options:[{label, description,
  preview}]}]}`; `preview` mit `previewFormat:'markdown'` ist ein Markdown-Codeblock
  (`ask-user-question#42`, `#44`).
- **Antwort:** `allow` mit `updatedInput = {...input, answers:{"<Fragetext>":"Blue"},
  annotations:{"<Fragetext>":{notes, preview}}}` (`#45`). Das Tool-Result an Claude lautet
  „The user answered: "<Frage>"="Blue" selected preview: … notes: …“, `tool_use_result` =
  `{questions, answers, annotations}` (`#50`); Claude gab Auswahl und Notiz korrekt wieder (`#135`).
- **Konsequenz:** Plan bestätigt. Schlüssel ist der **Fragetext**; Mehrfachauswahl laut Typings
  kommagetrennt; Freitext („Andere“) ist einfach ein anderer String. Notizen über `annotations`.

## Punkt 6 – Plan-Modus und Plan-Freigabe

- **Ablauf (`permissionMode:'plan'`):** Claude schreibt die Plan-Datei per **Write ohne `canUseTool`**
  nach `<HOME>\.claude\plans\<slug>.md` (`plan-mode#35`, `#45`), lädt `ExitPlanMode` erst per
  `ToolSearch select:ExitPlanMode` (deferred tool, `#43`) und ruft es dann auf.
- **`ExitPlanMode`-Input in `canUseTool`:** `{plan, planFilePath}` (vom CLI injiziert, nicht im Typ;
  Optionen `requiresUserInteraction:true`, keine `suggestions`) (`#55`).
- **Deny mit Feedback** → `tool_result` Fehler mit dem Feedback, Claude bleibt im Plan-Modus, schreibt
  die Datei neu und ruft `ExitPlanMode` erneut auf (v2, `#56`–`#98`).
- **Allow mit `updatedInput.plan` (geändert) + `updatedPermissions:[{type:'setMode', mode:'acceptEdits',
  destination:'session'}]`** (`#99`) → `system/status mode=acceptEdits` (`#101`); `tool_use_result`
  `{plan, isAgent:false, filePath, planWasEdited:true}`, Tool-Result „User has approved your plan …
  ## Approved Plan (edited by user): …“ (`#103`); die **Plan-Datei enthält die Änderung** (`#201`).
  Danach Write/Read ohne Abfrage (`#167`–`#188`), `IMPLEMENTED` (`#194`).
- **Modell:** Planungs-Requests liefen auf `claude-sonnet-5-5`, nach der Freigabe auf Haiku
  (`#35`–`#93` vs. `#153`–`#194`); `init.model` blieb `claude-haiku-5-5`.
- **Konsequenz:** Plan C.4 bestätigt (Feldnamen, `destination:'session'`, Bearbeiten über
  `updatedInput`). Plan-Datei-Erkennung: Write auf `planFilePath`/`<configDir>/plans` ist im Plan-Modus
  sichtbar, aber **ohne** Permission-Karte. „Mit frischem Kontext umsetzen“ nicht getestet (kein SDK-Request,
  Fallback aus C.4). Modell pro Assistant-Message anzeigen; Plan-Modus kostet mit Haiku deutlich mehr.

> **Nachtrag 16.10.2026 (WP-22):** Erneut beobachtet: Plan-Modus mit Haiku plante auf
> `claude-sonnet-5-5` (3 Requests, ≈ 0,20 der ≈ 0,25 USD der Abnahme); Plan-Datei
> `~/.claude/plans/<slug>.md`, Feedback-Runde v1 → v2 und Freigabe mit `acceptEdits` wie oben.

## Punkt 7 – `/clear`

- **Ergebnis:** `/clear` als User-Message → `conversation_reset {new_conversation_id, uuid (= dieselbe
  ID), trigger:"clear", user_message_uuid, timestamp}` (`clear-rename#39`), zweimal
  `system/session_title_changed` für die **neue** Session (`#40`, `#41`), `init` mit neuer
  `session_id` (`#42`), `result` mit `num_turns:0`, `total_cost_usd:0` (`#43`). Die neue `session_id`
  (`9b779de6…`) ist **nicht** `new_conversation_id` (`96ce35cc…`) (`#47`, `#65`).
  `getSessionInfo(new_conversation_id)` → `null` (`#68`, `#69`), es gibt kein Transkript dazu (`#73`);
  `listSessions` zeigt die alte und die neue Session (`#70`). Der **eigene Titel wird übernommen**
  (`customTitle` der neuen Session = alter Titel). `total_cost_usd` beginnt nach `/clear` bei 0.
  `/clear` hat laut `supportedCommands()` die Aliase `reset`, `new` und ein optionales `[name]`.
- **Konsequenz (Contract-Änderung):** Nach `conversation_reset` die Session-ID aus dem nächsten
  `system/init` (bzw. `session_id` der Folge-Messages) übernehmen; `new_conversation_id` nur als
  Korrelation speichern. Titel nach `/clear` nicht automatisch zurücksetzen – die CLI behält ihn.
  Kosten-/Usage-Summen pro Unterhaltung führen.

> **Nachtrag 16.10.2026 (WP-22):** Live bestätigt: nach `/clear` neue Session-ID (≠ Korrelations-ID
> `new_conversation_id`), der Titel bleibt.

## Punkt 8 – `/rename`, Titel, KI-Titel

- **Ergebnis:** `/rename <name>` über die laufende Session funktioniert: `system/session_title_changed
  {title}` (`clear-rename#24`), synthetische Assistant-Message (`model:"<synthetic>"`, untypisiert
  `local_command_run:{command:"rename", args}`, `local_command_source`) (`#26`), `result` mit
  `num_turns:0` (`#27`). `getSessionInfo` → `customTitle` und `summary` = neuer Titel (`#31`).
  **SDK-Sessions bekommen KI-Titel:** Transkripte enthalten `ai-title`-Einträge, `getSessionInfo().summary`
  ist z. B. „Simple OK reply“, „Notes.txt file creation and directory listing“
  (`history#6`, `#16`, `#9` Eintragstypen).
- **Konsequenz:** `/rename` durchreichen und `session_title_changed` auswerten (kein `renameSession()`
  auf laufende Sessions). Auto-Titel: nach `result` `getSessionInfo().summary` lesen, solange
  `titleIsCustom=false`. `session_title_changed` gehört in den Contract (untypisiert).

> **Nachtrag 16.10.2026 (Quelle: WP-22, Befund WP22-02; ADR-085):** Mit SDK 0.3.296/CLI 2.1.300
> liefert `getSessionInfo()` den KI-Titel einer **nie umbenannten** Session auch als `customTitle`
> (Beleg: `{summary: "Datei test.txt erstellen", customTitle: "Datei test.txt erstellen", firstPrompt:
> "lege test.txt …"}`; im Transkript nur `ai-title`-Einträge, dazu legt die CLI
> `<session>\custom-title.json` an). Laut ADR-085 füllt das SDK `customTitle` aus `custom-title` ‖
> Sidecar `custom-title.json` ‖ `aiTitle`. `customTitle !== null` ist damit **kein** Beleg für einen
> eigenen Titel – `titleIsCustom` (Konsequenz oben) darf nicht daraus abgeleitet werden. Parallax
> erkennt eigene Titel nur selbst (`titleSource 'custom'` nach `/rename`, `session.rename` oder Titel
> beim Anlegen) und übernimmt sonst `customTitle` bzw. `summary`; Nachprüfung 16.10.2026:
> `titleSource: ai`.

## Punkt 9 – Streaming-Input-Queue, `priority`, `replay-user-messages`

- **`priority:'next'`** während eines Bash-Calls (`queue-priority#20`): `command_lifecycle queued`
  (`#25`), nach dem Tool-Result in den laufenden Turn gefaltet (`#29` Replay, `#30` started), `status`
  und `result` listen **beide** UUIDs in `user_message_uuids` (`#31`, `#80`); ein gemeinsames `result`.
- **`priority:'now'`** (`#101`): der laufende Bash wird **in den Hintergrund verschoben**
  (`task_updated is_backgrounded:true` `#106`, `tool_result` „Command was moved to the background … so
  that a message that arrived while it was running can reach you“ `#107`), Turn C endet mit `result`
  `success`, `stop_reason:"tool_use"`, `terminal_reason:"aborted_tools"`, `queued_turn_count:1` (`#108`),
  Lifecycle C `cancelled` (`#109`); D läuft als eigener Turn (`#110`–`#156`). Der Hintergrund-Task
  meldet sich danach per `task_notification` und startet **automatisch einen weiteren Turn** ohne
  User-UUID (`#160`–`#216`).
- **`extraArgs:{'replay-user-messages':null}`** → CLI-Flag `--replay-user-messages`; jede User-Message
  kommt beim **Verarbeiten** als `user` mit `isReplay:true` zurück (`#10`, `#29`, `#89`, `#113`). Ohne das
  Flag (alle anderen Fixtures) gibt es keine Echos – `command_lifecycle` (Capability `msg_lifecycle_v1`)
  liefert dieselbe Information (`queued`/`started`/`completed`/`cancelled` je `command_uuid`).
- **Konsequenz:** Eigene `uuid` je Nachricht ist richtig. „Grau bis verarbeitet“ über
  `command_lifecycle` (oder `user_message_uuids`); `replay-user-messages` ist für die Queue **nicht**
  nötig (später ggf. für Rewind). „Jetzt senden“ (`now`) bricht den laufenden Turn ab und schiebt Tools
  in den Hintergrund → UI-Hinweis. `command_lifecycle` muss in den Contract (untypisiert!).

> **Nachtrag 16.10.2026 (WP-22):** Live bestätigt: `next` während eines Tools wird nach dem Tool
> übernommen; `now` schiebt das laufende Tool in den Hintergrund, die neue Nachricht wird beantwortet,
> nach der Task-Notification folgt automatisch ein weiterer Turn.

## Punkt 10 – `interrupt()` und `session_state_changed`

- **Während eines laufenden Tools** (`interrupt#25`–`#36`): `interrupt()` liefert `{still_queued:[]}`
  (`#31`), ~2,6 s später `tool_result` „User rejected tool use“ und User-Text
  `[Request interrupted by user for tool use]`, `result error_during_execution`, `is_error:true`,
  `terminal_reason:"aborted_tools"`, Lifecycle `cancelled`, dann `idle` (`#32`–`#36`). Folge-Turn
  funktioniert (`#51`).
- **Während eines Requests/Streams** (`interrupt-requesting#25`–`#29`, `#156`–`#162`): User-Text
  `[Request interrupted by user]`, `result error_during_execution`, `terminal_reason:"aborted_streaming"`.
  Ein `aborted:true` an Assistant-Messages wurde nicht beobachtet (Haiku war jeweils schon fertig).
- **Im Leerlauf:** `interrupt()` → `{still_queued:[]}`, keine Messages (`interrupt#173`).
- **Zustände:** `running` beim Annehmen der Eingabe (vor `init`), `requires_action` während einer offenen
  `canUseTool`-Entscheidung, `idle` am Ende. **In allen 12 Fixtures kommt `result` vor `idle`.** Mit
  Hintergrundarbeit kommen mehrere `result`s und erst danach ein `idle` (`subagent#87`, `#100`, `#102`;
  `queue-priority#108`, `#156`, `#158`).
- **Nebenbefund:** Die CLI blockiert `sleep N` (auch verkettet): „Blocked: standalone sleep 30 … use
  Monitor …“ (`interrupt-requesting#20`).
- **Konsequenz:** „Fertig“ nur aus `idle` (C.5 bestätigt). Interrupt-`result` ist `error_during_execution`
  mit `terminal_reason aborted_*` → Status `interrupted`/`idle`, kein Fehlerbanner. `requires_action`
  ist ein zusätzliches Signal für „wartet auf dich“.

> **Nachtrag 16.10.2026 (Quelle: WP-22, Befund WP22-08; ADR-087):** Nach jedem Stop/Interrupt enthält
> `result.errors` (CLI 2.1.300) einen internen Diagnose-Eintrag, z. B. `[ede_diagnostic]
> result_type=user last_content_type=n/a stop_reason=tool_use`; Parallax zeigt `[…diagnostic]`-Einträge
> nicht an. Live: `interrupt()` während `ping -n 30` → `idle` nach 228 ms, bei offener PowerShell-Karte
> → `idle` nach 252 ms (Karte weg, Tool abgebrochen).

## Punkt 11 – Subagent (Agent-Tool)

- **Ergebnis:** `Agent` startet per Default **im Hintergrund**: `background_tasks_changed` (`subagent#25`),
  `task_started {task_id, tool_use_id, is_backgrounded:true, spawn_depth:1, task_type:"local_agent",
  prompt}` (`#26`), `tool_result` „Async agent launched successfully …“ mit `tool_use_result
  {isAsync:true, status:"async_launched", agentId, resolvedModel, outputFile, …}` (`#28`).
  Subagent-Messages kommen als `assistant` mit `parent_tool_use_id` = Agent-`tool_use_id` (thinking +
  text, **ohne** Stream-Events; trotz `forwardSubagentText` = Default) (`#31`, `#32`). Ende:
  `task_updated status:completed` (`#33`), `task_notification status:completed, output_file, summary`
  (`#34`), `background_tasks_changed []` (`#35`). Der erste Haupt-`result` kommt, während der Agent
  noch „läuft“ (`#87`); die Notification startet automatisch einen zweiten Turn (`#90`–`#100`),
  `idle` erst danach (`#102`). `task_progress` erschien nicht (zu kurz).
  Verlauf: `listSubagents` / `getSubagentMessages` liefern die Subagent-Unterhaltung mit
  `parent_tool_use_id` (`history#87`, `#88`).
- **Konsequenz:** Agent-Karte aus `task_*` + `tool_use_result`; „fertig“ nur bei `idle` und leerem
  `background_tasks_changed`. Subagent-Text kann auch ohne `forwardSubagentText` erscheinen →
  immer per `parent_tool_use_id` einsortieren.

## Punkt 12 – Query-Methoden ohne API-Call

- `getContextUsage({detail:'summary'})` → `{categories:[{name, tokens, color, isDeferred?, kind}],
  totalTokens:26702, maxTokens:1000000, rawMaxTokens:1000000, percentage:3, gridRows, model, memoryFiles,
  mcpTools, agents, …}` + untypisiert `autocompactSource:"model-default"` (`auth-probe#22`), Antwort in
  < 200 ms ohne Request.
- `supportedCommands()` → 70 Einträge `{name, description, argumentHint, aliases?, builtin?}` (`#23`);
  `supportedModels()` → `default`, `opus`, `claude-fable-5-1[1m]`, `sonnet`, `haiku` … mit
  `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`,
  `supportsAutoMode`, untypisiert `supportsThinkingOff` (`#24`); `supportedAgents()` (`#25`).
- `setPermissionMode('default')`, `setModel('haiku')`, `applyFlagSettings({fastMode:false})` existieren
  und lösen mit `undefined` auf (`#29`–`#31`), ohne Messages (`#33`).
- **Konsequenz:** Context-Gauge wie in C.1. Bei 1M-Fenstern (Haiku 5.5) bleibt die Gauge lange niedrig.

> **Nachtrag 16.10.2026 (WP-22, Befunde WP22-12/-14):** `getContextUsage({detail:'summary'})` und
> `/context` lieferten dieselbe Summe (36,6 k von 1 M), aber andere Kategorien (System tools 13.8K
> vs. 7.9k, MCP tools (deferred) 33.6K vs. 25.6k, Messages 10.7K vs. 16.5k) – nur Beobachtung.
> `supportedModels()` beschreibt „Default (recommended)“ nach den Nutzer-Settings (hier „Opus 5.5“),
> auch wenn die Session per `ANTHROPIC_MODEL=haiku` auf Haiku läuft; das tatsächliche Modell kam aus
> `assistant.message.model` (`claude-haiku-5-5`).

## Punkt 13 – `rate_limit_event`, Stream-Deltas, Abgleich mit der finalen Message

- **`rate_limit_event`:** einmal pro Session beim ersten Request, `status:"allowed"`,
  `rateLimitType:"five_hour"`, `resetsAt`, `overageStatus:"rejected"`, `overageDisabledReason:
  "out_of_credits"`, `isUsingOverage:false`, untypisiert `unifiedWindows:{five_hour:{utilization,
  resetsAt}, seven_day:{…}}` (`auth-probe#9`).
- **Stream:** `message_start` (mit `message.id`, Usage), `content_block_start` (text/thinking/tool_use),
  `content_block_delta` mit `text_delta`, `thinking_delta`, `signature_delta`, **`input_json_delta`**
  (`partial_json`, z. B. `permissions#13`–`#23`), `content_block_stop`, `message_delta` (stop_reason,
  Usage), `message_stop`. Jedes Stream-Event trägt untypisiert **`api_message_id`** (778 von 778 Deltas);
  das erste trägt `user_message_uuid(s)`, `ttft_ms`, `thinking_display`.
- **Abgleich:** Pro fertigem Content-Block kommt eine eigene `assistant`-Message mit **derselben
  `message.id`** wie `message_start` (alle 72 gestreamten Messages hatten ein `message_start` mit gleicher ID;
  mehrere Assistant-Messages je ID z. B. `permissions#24`/`#35`), `stop_reason` dort `null`.
  Ohne Stream kommen nur Subagent-Messages und synthetische Local-Command-Antworten.
  `system/thinking_tokens` (geschätzte Thinking-Tokens) kommt sehr häufig (262 Frames).
- **Konsequenz:** Normalizer: Item-ID `messageId:blockIndex`, die Block-Message ersetzt den gestreamten
  Block (B bestätigt). `thinking_tokens` drosseln/ignorieren. Abo-Limit-Anzeige aus `unifiedWindows`.

## Punkt 14 – Resume

- **Ergebnis:** `resume:<id>` + `permissionMode:'default'` → CLI-Flag `--resume=<id>`, gleiche
  `session_id` in `init` (`resume#2`, `#7`, `#20`), Antwort `RESUMED` (`#12`), Fortsetzung im selben
  Transkript. `result.total_cost_usd` enthält die Kosten der ursprünglichen Session (0,00755 statt
  0,00212 USD, `#17`/`#20`). `promptSuggestions:true` lieferte innerhalb von 25 s **kein**
  `prompt_suggestion` (`#21`).
- **Konsequenz:** Resume wie geplant (gleicher `cwd`, gespeicherter Modus). Kosten nicht über Resumes
  summieren. Prompt-Suggestions nicht als verlässlich annehmen (nach Resume evtl. „erster Turn“).

> **Nachtrag 16.10.2026 (Quelle: WP-22, Befund WP22-10; ADR-087):** In der Abnahme begann
> `result.total_cost_usd` nach einem Resume **bei 0** (Unterhaltung `845aaf25…`: vor dem Neustart
> über 0,003 USD, im fortgesetzten Prozess 0,00053 USD) – anders als oben, bei derselben CLI 2.1.300; die
> Ursache des Unterschieds ist nicht geklärt. „Enthält die Kosten der ursprünglichen Session“ und
> „Kosten nicht über Resumes summieren“ sind damit nicht verlässlich. Parallax summiert die Kosten je
> Unterhaltung über die Query-Segmente (Nachprüfung 16.10.2026: 0,0080 + 0,0015 = 0,0095 USD über zwei
> Prozesse). Außerdem bestätigt: Resume nach Serverneustart mit derselben Session-ID; `claude --resume
> <id> -p … --output-format json` in der Konsole setzt eine Parallax-Session mit gleicher
> `session_id` fort – aus einer Claude-Code-Shell nur ohne `CLAUDECODE`/`CLAUDE_CODE_*` (die CLI
> schützt sich gegen verschachtelte Sessions).

## Punkt 15 – Verlauf: `getSessionMessages`/`listSessions`/`getSessionInfo`, `CLAUDE_CONFIG_DIR`, `dir`

- **Felder:** `SessionMessage` = `{type, uuid, session_id, message, parent_tool_use_id, parent_agent_id,
  timestamp, origin}` (+ vereinzelt `isQueuedCommand`, `isCompletedLocalCommand`) – **mit Timestamps**,
  **ohne `tool_use_result`** (Tool-Ergebnisse nur als `tool_result`-Content). Das Roh-JSONL enthält
  `toolUseResult` (z. B. 9 Einträge bei `permissions`) (`history#11`–`#19`). Subagent-Messages fehlen im
  Hauptverlauf, `getSubagentMessages` liefert sie mit `parent_tool_use_id` (`#87`, `#88`).
  `includeSystemMessages:true` änderte die Anzahl nicht.
- **`dir`:** Mit und ohne `dir` gleiche Ergebnisse; die **Laufwerksbuchstaben-Schreibweise in `dir` ist
  egal** (`C:`/`c:` jeweils gefunden, `history#4`/`#5`, `#43`/`#44`). Das CLI legt den Projektordner
  aber **mit der übergebenen Schreibweise** an: `c--Users-…-clear-rename` vs. `C--Users-…` (siehe Liste
  unten) – B („cwd exakt behalten“) bestätigt.
- **`CLAUDE_CONFIG_DIR`:** pro Aufruf aus `process.env` gelesen: Umsetzen auf einen leeren Ordner →
  0 Messages, `getSessionInfo` undefined; zurücksetzen → wieder 33 (`history#99`–`#101`). In einem
  `worker_threads`-Worker mit `env:{…, CLAUDE_CONFIG_DIR:<leer>}` → 0, mit geerbtem Env → 33
  (`#102`, `#103`).
- **Konsequenz:** A.3 bleibt (eigenes Transkript-Log, weil `tool_use_result` fehlt); der Verlaufs-Adapter
  kann Timestamps übernehmen. Mehrere Config-Dirs: je Profil ein Worker (bestätigt) – im Hauptprozess
  `process.env` nie umsetzen (Race mit parallelen Aufrufen).

## Punkt 16 – Prozesse, PID, Waisen, stderr

- **PID:** `spawnClaudeCodeProcess` existiert; der Wrapper bekommt `{command:<claude.exe>, args, cwd,
  env, signal}` und spawnt direkt die `.exe` (kein Node), PID sofort verfügbar (`permissions#2`).
  Alternativ liefert `initializationResult().pid` die PID (`auth-probe#26`).
- **Prozessbaum:** `claude.exe` → `conhost.exe` + 3× `cmd.exe` → `node.exe` (die User-MCP-Server
  github/primevue/chrome-devtools via `cmd /c npx …`) (`auth-probe#34`). Nach `close()` endet `claude.exe`
  nach **0,76–0,98 s**, nach Input-EOF nach **1,87 s**; **keine überlebenden Kinder** in allen 13
  Sessions (`process`-Event `after-close` mit `survivors:[]`, z. B. `auth-probe#37`, `permissions#335`;
  Exit-Zeiten in `spike-state`, Abschnitt „Verbrauch“ zählt die Sessions). Exit-Code 0, nach
  einem vorherigen Interrupt einmal 1 (`interrupt-requesting#165`).
- **stderr:** Laut `sdk.mjs` liest das SDK stderr nur in seinem eigenen Spawn; mit
  `spawnClaudeCodeProcess` wird der `stderr`-Callback nie aufgerufen. Der Recorder liest die Pipe selbst –
  in keiner Session kam stderr-Ausgabe (0 `stderr`-Events). Das SDK setzt `CLAUDE_CODE_ENTRYPOINT=sdk-ts`
  (falls nicht gesetzt) und entfernt `NODE_OPTIONS`.
- **Konsequenz:** C.8 bestätigt; Waisen traten im Normalbetrieb nicht auf, `taskkill /T /F` bleibt
  Fallback (harte Server-Abbrüche nicht getestet). WP-13: eigener Spawn-Wrapper **muss stderr
  konsumieren** (sonst blockiert die Pipe) und ins Log schreiben; `windowsHide:true` setzt das SDK im
  Default ebenfalls.

> **Nachtrag 16.10.2026 (Quelle: WP-22, Befunde WP22-05/-06/-07; ADR-081, ADR-083, ADR-084):**
> - **Harter Server-Abbruch** (`taskkill /PID <server> /F`, am 15. und 16.10.2026): `claude.exe`
>   beendete sich selbst (stdin zu) samt MCP-Servern; die von ihm gestarteten Tool-Prozesse
>   (`powershell.exe` → `PING.EXE`) liefen als **Waisen** weiter, bis der Befehl von selbst endete.
>   Prozessbaum vorher: `claude.exe` → `conhost.exe`, 3× `cmd.exe`/`node.exe` (MCP), `cmd.exe` →
>   `powershell.exe` → `PING.EXE`; ein Herzschlag-Schnappschuss zählte 21 Nachkommen. Parallax beendet
>   beim nächsten Start exakt verifizierte Prozesse des letzten Schnappschusses (ADR-081).
> - **Ende mit offener Entscheidung:** Eine Session, deren CLI auf eine `canUseTool`-Antwort wartet,
>   endete nach Input-EOF/`Query.close()` nicht innerhalb von 5 s (laut ADR-084 wartet die CLI auf die
>   Antwort, während das SDK das `canUseTool`-Signal vorher abbricht) → `taskkill`, Exit-Code 1. Mit
>   `interrupt()` vor `close()` endete sie nach ≈ 1,3 s.
> - **Umgebung der Tools** (Env-Probe): Im Tool-Prozess einer Session setzt die CLI selbst
>   `CLAUDECODE`, `AI_AGENT` (`claude-code_<version>_agent`), `CLAUDE_CODE_SESSION_ID` (eigene
>   Session), `CLAUDE_PID` (eigene PID), `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`,
>   `CLAUDE_CODE_SESSION_ATTENDED` (`0`) und `CLAUDE_CODE_CHILD_SESSION`; vom SDK kommen
>   `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_AGENT_SDK_VERSION` und
>   `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT=markdown`. Diese Namen in einer Session sind also kein Leck
>   der aufrufenden Umgebung. Was `buildEnv` durchlässt, sehen auch die Tools (in der Abnahme
>   `PARALLAX_HOME` des Servers) – deshalb entfernt `buildEnv` jedes geerbte `PARALLAX_*` (ADR-083;
>   Nachprüfung: nur noch `PARALLAX`, `PARALLAX_ENTRY_ID`).

## Punkt 17 – Claude-Auflösung, `--version`, `auth status`

```
$ where claude
C:\Users\<USER>\.local\bin\claude.exe
$ dir %USERPROFILE%\.local\bin
claude.exe  claude.exe.old.1791966999163.6044  claude.exe.old.1792002982454.21564
$ npm prefix -g
C:\Users\<USER>\AppData\Roaming\npm      (kein claude*.cmd, kein node_modules\@anthropic-ai\claude-code)
$ claude --version
2.1.300 (Claude Code)
$ claude auth status            (Default = --json; Exit 0)
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "analyticsDisabled": false,
  "projectsDirectory": "C:\\Users\\<USER>\\.claude\\projects", "configDirectory": "C:\\Users\\<USER>\\.claude",
  "email": "<EMAIL>", "orgId": "<ORG_ID>", "orgName": "<ORG>", "subscriptionType": "max" }
$ claude auth status --text
Login method: Claude Max account
Organization: <ORG>
Email: <EMAIL>
```
- **Konsequenz:** `resolveClaude`: `.local\bin\claude.exe` bevorzugen, `claude.exe.old.*` ignorieren
  (C.7 bestätigt). `.cmd`-Shim-Auflösung ist auf diesem Rechner **nicht verifizierbar** (keine
  npm-Installation) → in WP-11 mit Test-Fixture/Fake-Verzeichnis prüfen. Preflight/„Profil testen“:
  `auth status --json` parsen (`loggedIn`, `authMethod`, `apiProvider`, `subscriptionType`); `email`/`org*`
  nicht loggen.

---

## Beobachtete Message-Typen und Subtypen (alle Fixtures)

| type/subtype | Anzahl | typisiert in 0.3.296? |
|---|---|---|
| `stream_event/content_block_delta/input_json_delta` | 274 | ja |
| `system/thinking_tokens` | 262 | ja |
| `stream_event/content_block_delta/thinking_delta` | 248 | ja |
| `stream_event/content_block_delta/text_delta` | 242 | ja |
| `system/session_state_changed` (`running`, `requires_action`, `idle`) | 94 | ja |
| `command_lifecycle` (`queued`, `started`, `completed`, `cancelled`) | 90 | **nein** |
| `assistant` | 75 | ja |
| `stream_event/content_block_start` / `content_block_stop` | je 72 | ja |
| `system/status` (`requesting`, `null`+`permissionMode`) | 52 | ja |
| `stream_event/message_start` / `message_delta` / `message_stop` | je 49 | ja |
| `user` (tool_result, Interrupt-Texte, Replays mit `isReplay`) | 38 | ja |
| `system/init` | 31 | ja |
| `result/success` | 27 | ja |
| `stream_event/content_block_delta/signature_delta` | 14 | ja |
| `rate_limit_event` | 11 | ja (ohne `unifiedWindows`) |
| `result/error_during_execution` | 4 | ja |
| `system/background_tasks_changed` | 4 | ja |
| `system/session_title_changed` | 3 | **nein** |
| `system/task_started` / `task_updated` / `task_notification` | je 3 | ja |
| `conversation_reset` | 1 | ja |

Nicht beobachtet (in der Union, kein Szenario dafür): `compact_boundary`, `api_retry`, `tool_progress`,
`task_progress`, `prompt_suggestion`, `permission_denied`, `memory_recall`, `notification`,
`informational`, `local_command_output`, `hook_*`, `auth_status`, `tool_use_summary`, `files_persisted`,
`elicitation_complete` u. a. `system/commands_changed` kam zweimal im ersten (verlorenen) Permissions-Lauf
vor, in keinem erhaltenen Fixture. → FakeBackend/Normalizer behandeln unbekannte Typen tolerant.

> **Nachtrag 16.10.2026 (WP-22):** Hauptlauf und Live-Smoke gegen CLI 2.1.300 ohne einen einzigen
> Validierungs-Drop echter SDK-Daten im Server-Log (R3-05); im Live-Smoke `unknownCounts` `{}`.

## Abweichungen 0.3.296 / Laufzeit gegenüber den Plan-Annahmen

| Thema | Plan | Beobachtet (Beleg) | Konsequenz |
|---|---|---|---|
| `/clear` | `new_conversation_id` = neue Session-ID | dritte ID im `init` (`clear-rename#42`, `#65`) | ID aus nächstem `init` |
| Titel nach `/clear` | zurücksetzen | CLI übernimmt `customTitle` (`clear-rename#40`, `#70`) | nicht selbst zurücksetzen |
| „Immer erlauben“ | `updatedPermissions = suggestions` | enthält `setMode acceptEdits` + `localSettings` (`permissions#282`, `#285`) | filtern, Ziel wählbar |
| Regel verhindert Rückfrage | ja | nein bei `blockedPath` (`permissions#162`, `permissions-rules#197`, `#406`) | kein „nie wieder“ versprechen |
| `permissionMode` weggelassen | evtl. `auto` | `default` (`auth-probe#7`) | immer tatsächlichen Modus zeigen |
| Plan-Modus-Modell | Haiku | Sonnet 5.5 bis zur Freigabe (`plan-mode#35`–`#93`) | Modell je Message, Budget |
| Plan-Datei schreiben | Write sichtbar | Write ohne `canUseTool` (`plan-mode#35`) | keine Karte, nur Erkennung |
| `getSessionMessages` | ohne Timestamps | mit `timestamp` (`history#2`) | im Verlaufs-Adapter nutzen |
| Queue-Status | über Replays | `command_lifecycle` (`queue-priority#25`, `#30`) | Replays nicht nötig |
| `stderr`-Callback | ins Log | mit eigenem Spawn nie aufgerufen (sdk.mjs) | Wrapper liest stderr |
| `canUseTool`-Optionen | `decisionReason` | meist `decisionReasonType` (untypisiert), `requiresUserInteraction` | tolerant übernehmen |
| `sleep` in Bash | – | CLI blockiert `sleep N` (`interrupt-requesting#20`) | Tests nicht mit `sleep` |
| Token-Verbrauch | niedrig fünfstellig | ~27 k Tokens Kontext je Request | Budget/Erwartung anpassen |

Untypisierte Zusatzfelder (Auswahl): `init.{memory_paths, messaging_socket_path, powershell_path,
per_turn_effort_active, analytics_disabled}`, Stream-Events `api_message_id`, `thinking_display`,
`status.user_message_uuids`, `result.{subagent_stats, first_request_input_tokens, safety_stops,
request_sent_wall_ms}`, `rate_limit_info.unifiedWindows`, `canUseTool.options.{decisionReasonType,
requiresUserInteraction}`, `assistant.{local_command_run, local_command_source}`,
`tool_use_result.backgroundedToDeliverMessage`, `getContextUsage().autocompactSource`,
`ModelInfo.supportsThinkingOff`, `initializationResult().{pid, current_permission_mode, session_state}`.

> **Nachtrag 16.10.2026 (WP-22), weitere Abweichungen:** `permissionMode` weggelassen → in WP-22
> zuerst `default`, dann `auto` (Punkt 2); `getSessionInfo().customTitle` enthält auch den KI-Titel
> (Punkt 8); `total_cost_usd` nach Resume begann bei 0 (Punkt 14); `result.errors` enthält nach
> Interrupts `[ede_diagnostic] …` (Punkt 10); Tool-Prozesse überleben einen harten Server-Abbruch
> (Punkt 16).

## Fixture-Format (Version 1)

Datei `test/fixtures/sdk/<szenario>.jsonl`, UTF-8, LF, eine JSON-Zeile pro Datensatz. Validierung:
`parseFixture()` in `src/server/backend/fixture.ts` (zod, einzige Quelle; `scripts/record/format.ts`
re-exportiert es), Test `test/fixtures/sdk/fixtures.test.ts`.

**Zeile 1 – Header:**
```json
{"fixtureVersion":1,"scenario":"<szenario = Dateiname>","description":"…","sdkVersion":"0.3.296",
 "cliVersion":"2.1.300","recordedAt":"<ISO>","options":{"cwd":"<SCRATCH>\\work\\…","model":"haiku",
 "permissionMode":"default|plan|(omitted)","settingSources":[…],"systemPrompt":{…},"thinking":{…},
 "toolConfig":{…},"maxTurns":8,"resume":null,"extraArgs":null,"promptSuggestions":false,
 "canUseTool":"recorder policy","spawnClaudeCodeProcess":"…","env":{"set":{…},"removed":[…],
 "pathEntriesRemoved":0,"sessionExtra":{}}}}
```
**Ab Zeile 2 – Events:** `{"seq":<1…n lückenlos>,"tMs":<ms seit Szenariostart, nicht fallend>,
"kind":"<kind>","payload":{…}}`

| kind | payload | Bedeutung für FakeBackend (WP-13) |
|---|---|---|
| `message` | SDKMessage aus dem Iterator, **unverändert** (nur bereinigt) | in Reihenfolge ausgeben |
| `canUseTool` | `{toolName, input, options (ohne signal), signalAborted}` | `canUseTool` aufrufen, auf Entscheidung warten |
| `decision` | `{toolName, toolUseID, result: PermissionResult}` | die im Original gegebene Antwort (Referenz/Assertion) |
| `input` | gepushte `SDKUserMessage` inkl. `uuid`, `priority`, `origin` | vom Test-Treiber erwartete Eingabe |
| `control` | `{method, args, result \| error, ms}` (interrupt, setModel, setPermissionMode, applyFlagSettings) | Antwort auf Control-Aufruf |
| `call` | `{fn, args, result \| error, ms}` (getContextUsage, supportedModels, getSessionInfo, fs-Prüfungen …) | Antwort auf lesende Aufrufe |
| `stderr` | `{source:'pipe'\|'callback', data}` | ins Log |
| `error` | `{where, name, message}` | Iterator-/Szenario-Fehler |
| `abort` | `{source:'canUseTool.signal'\|'guard', …}` | abgebrochene Entscheidung / Guard |
| `mark` | `{label, …}` | Schrittmarke, ignorieren |
| `spawn` | `{pid, command, args, cwd}` | Prozessstart (PID-Erfassung) |
| `exit` | `{pid, code, signal, msSinceClose}` | Prozessende |
| `process` | `{phase:'before-close'\|'after-close'\|'cleanup', rootPid, processes\|survivors\|killed}` | Prozessbaum (nur Namen/PIDs) |

Regeln: unbekannte `kind`s ignorieren; ein `message` hat immer `payload.type`. Bereinigung ersetzt
`<HOME>`, `<SCRATCH>` (Scratch-Wurzel `%TEMP%\parallax-spike-<stamp>`, auch in Projektordner-Kodierung
`C--Users-…`), `<USER>`, `<HOST>`, `<EMAIL>`, `<ORG>`, `<ORG_ID>`, `<ACCOUNT_ID>`, `<TOKEN>`,
`<SIGNATURE>` (Thinking-Signaturen), `<REDACTED>`; Session-/Message-UUIDs bleiben. Gestreamte Blöcke
werden **als Ganzes** bereinigt und auf dieselbe Anzahl Deltas neu verteilt (ein Pfad kann über zwei
`input_json_delta`-Chunks verteilt sein) – die Konkatenation der Deltas entspricht immer dem bereinigten
Block. Pfadangaben in den Fixtures verlieren dadurch die Laufwerks-Schreibweise.

**Fixtures:** `auth-probe` (Text-Turn, Init, Calls), `permissions` (allow/always/deny/deny+interrupt,
accept-all), `permissions-rules` (Wiederholungsabfragen), `ask-user-question`, `plan-mode`
(Feedback-Runde + Freigabe), `clear-rename` (`/rename`, `/clear`), `queue-priority` (`next`/`now`,
Replays), `interrupt` (Tool-Interrupt, Leerlauf-Interrupt), `interrupt-requesting`
(Request-/Stream-Interrupt), `subagent`, `resume`, `history` (nur `call`s, kein Live-Lauf).

## Recorder

- `pnpm record --list` · `pnpm record --stats` · `pnpm record --resanitize [szenario…]` (Fixtures aus
  `.recordings/<stamp>/<szenario>.raw.jsonl` neu bereinigen, ohne Session) ·
  `PARALLAX_LIVE=1 pnpm record <szenario…|all>`.
- Guards: ohne `PARALLAX_LIVE=1` kein Live-Lauf; `claude auth status` muss `claude.ai`/`firstParty`
  melden; jedes Szenario nach `auth-probe` setzt einen erfolgreichen Auth-Probe voraus; Abbruch bei
  `apiKeySource ≠ none`, `assistant.error` aus der Auth-Gruppe, `credits_required`, `rejected`,
  `startup_failure_reason` (setzt `blocked` in `.recordings/spike-state.json`, nur `--unblock` hebt es
  auf) und bei > 2 USD geschätztem Gesamtverbrauch.
- Env: spike-lokales `buildSpikeEnv()` (`scripts/record/env.ts`, Regeln aus C.2 plus Entfernen von
  `ANTHROPIC_API_KEY`/`_AUTH_TOKEN`/`_BASE_URL` und `PARALLAX_LIVE`). Optionen wie im Plan:
  `settingSources ['user','project','local']`, Preset-Systemprompt, `includePartialMessages`,
  `thinking {adaptive, summarized}`, `toolConfig.askUserQuestion.previewFormat 'markdown'` (alle in
  0.3.296 vorhanden), Modell `haiku`, User-Messages mit `origin:{kind:'human'}`.
- Rohdaten in `.recordings/` (git-ignoriert) enthalten persönliche Daten – nie committen.

## Verbrauch

13 Live-Sessions (inkl. einer verlorenen Rohaufzeichnung, siehe WP-01.md), 39 `result`s,
82 `num_turns` (Hauptschleife), **66 API-Antworten** (eindeutige `message.id`, inkl. Subagent).
Nicht sichtbar: Hilfs-Requests der CLI (KI-Titel, Klassifizierer).

| Modell | Input | Output | Cache-Read | Cache-Write | USD (Schätzung) |
|---|---|---|---|---|---|
| claude-haiku-5-5 | 14 776 | 7 689 | 1 691 454 | 278 806 | 0,0763 |
| claude-sonnet-5-5 (Plan-Modus) | 6 | 540 | 63 908 | 33 682 | 0,1465 |
| **Summe** | **14 782** | **8 229** | **1 755 362** | **312 488** | **0,2228** |

Quelle: `result.modelUsage` (kumulativ je Query; `/clear` setzt zurück → Segmente summiert; Resume
abzüglich der übernommenen Vorkosten). `rate_limit_event.unifiedWindows.five_hour.utilization` stieg
während des Spikes von 0 auf 0,01, `seven_day` blieb bei 0,35 (`auth-probe#9`, `resume#16`).

## Vom Spike erzeugte Dateien außerhalb des Repos (nicht gelöscht)

Transkript-Ordner unter `C:\Users\<USER>\.claude\projects\`:
```
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-005104-work-auth-probe        (1 Transkript, auch resume)
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-005949-work-permissions       (1, erster Lauf)
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-010553-work-permissions       (1)
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-010735-work-ask-user-question (1)
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-010825-work-plan-mode         (1)
c--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-011013-work-clear-rename      (2: vor/nach /clear)
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-011132-work-queue-priority    (1)
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-011409-work-permissions-rules (1)
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-011548-work-interrupt         (1, = interrupt-requesting)
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-011820-work-interrupt         (1, verworfen)
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-011952-work-interrupt         (1)
C--Users-<USER>-AppData-Local-Temp-parallax-spike-20261015-012048-work-subagent          (1)
```
Außerdem: Plan-Datei `C:\Users\<USER>\.claude\plans\plan-how-to-create-velvet-quail.md`; Scratch-Ordner
`%TEMP%\parallax-spike-20261015-*` (14, inkl. `.claude\settings.local.json` aus den Regel-Tests);
Task-Ausgaben unter `%TEMP%\claude\C--Users-<USER>-…-parallax-spike-…` (5 Ordner). Der Eintrag in
`~/.claude.json` (Projektliste) wurde von der CLI ergänzt.

## Nicht verifiziert / offen

- `.cmd`-Shim-Auflösung (keine npm-Installation vorhanden) → WP-11.
- `conversation_reset` mit `trigger:'plan_mode_exit'` per SDK (kein Request vorhanden; Fallback C.4).
- Waisen nach **hartem** Server-Abbruch (nur `close()`/EOF getestet).
- `aborted:true` an Assistant-Messages, `task_progress`, `api_retry`, `compact_boundary`,
  `prompt_suggestion`, `permission_denied` (Auto-Modus) – nicht ausgelöst.
- Verhalten mit Auto-Modus als CLI-Default (auf diesem Konto nicht aktiv).

> **Nachtrag 16.10.2026 (WP-22):** „Waisen nach hartem Server-Abbruch“ ist live geprüft (Punkt 16);
> der Auto-Modus wurde während der Abnahme zum CLI-Default dieses Kontos (Punkt 2).
