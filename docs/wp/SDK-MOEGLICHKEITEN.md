# SDK-Möglichkeiten: was Parallax noch nicht nutzt

- **Anlass (12.11.2026, Nutzer):** „Check nochmal das SDK. Es gibt sicherlich noch weitere Features, die
  wir dadurch implementieren können, neben Remote Control.“
- **Quellen:** `@anthropic-ai/claude-agent-sdk` 0.3.322 (`sdk.d.ts`, `sdk.mjs`), `claude` 2.1.322
  (Beschreibungen der Steuerbefehle im gebündelten Code), Spike `docs/wp/MACHBARKEIT-REMOTE-CONTROL.md`
  (dort live gesehene Meldungen). Abgleich mit `src/server/backend/**` und `src/server/sessions/**`.
- **Stand Parallax:** Von rund 60 `Query`-Methoden nutzt Parallax 10 (`interrupt`, `setPermissionMode`,
  `setModel`, `applyFlagSettings`, `renameSession`, `stopTask`, `supportedCommands`, `supportedModels`,
  `getContextUsage`, `readFile`). Alle öffentlichen Nachrichtentypen verarbeitet der Normalizer; drei
  interne Meldungen, die der Spike live gesehen hat, ignoriert er (`task_summary`, `post_turn_summary`,
  `bridge_state`).
- **„Öffentlich“** = in `sdk.d.ts` typisiert. **„Intern“** = in der SDK-Laufzeit vorhanden, aber
  `@internal`/nicht typisiert; kann sich mit CLI-Updates ändern → nur mit Laufzeitprüfung, sauberem
  Rückfall und einer Probe in `pnpm cli-check` (WP-62) nutzen.

## 1. Übersicht und Mission Control

| # | Möglichkeit | Schnittstelle | Nutzen | Aufwand |
|---|---|---|---|---|
| 1 | **Remote Control** inkl. Freigaben, Stop, Modell vom Handy, Session-Link | intern: `enableRemoteControl`, Meldung `system/bridge_state` | Sessions in der Claude-App sehen und steuern | groß (fremde Turns), Spike läuft |
| 2 | **Live-Satz je Session**: „Writing handy.txt“ während des Turns | intern: Meldung `system/task_summary {detail}` (gedrosselter Klassifikator; `null` = Leerlauf) | Seitenleiste zeigt auf einen Blick, was jede Session gerade tut | klein |
| 3 | **Turn-Fazit**: `status_category`, `status_detail` („replied … as requested“), `needs_action` | intern: Meldung `system/post_turn_summary` | Zeile „fertig / blockiert / braucht dich“ je Session, ohne das Transkript zu öffnen | klein |
| 4 | „Während du weg warst“ | intern: Meldung `system/away_summary` | Zusammenfassung beim Zurückkommen | klein |
| 5 | Automatischer Session-Titel | intern: `generateSessionTitle(description, {persist})` | sprechende Namen statt erstem Prompt | klein |
| 6 | Limits und Kosten jederzeit aktuell | experimentell: `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` (`get_usage`) | Limit-Leiste schon vor der ersten Warnung gefüllt | klein, instabil |

Offen für 2–4: ob das CLI die Meldungen auch ohne Remote Control sendet (im Spike war die Bridge an;
Parallax setzt `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` ohnehin). Klärt ein Fixture-Lauf.

## 2. Steuerung im Arbeitsfluss

| # | Möglichkeit | Schnittstelle | Nutzen | Aufwand |
|---|---|---|---|---|
| 7 | **„In den Hintergrund“** für einen laufenden Bash-Befehl oder Subagenten (Strg+B) | öffentlich: `backgroundTasks(toolUseId?)` | langer Build blockiert den Turn nicht mehr | klein |
| 8 | **Seitenfrage** (`/btw`): kurze Frage, ohne den Kontext der Session zu belasten | intern: `askSideQuestion(question, {history})` | Rückfrage an eine laufende Session, ohne sie zu stören | mittel |
| 9 | **Zurückspulen / Abzweigen** ab einer Nachricht, inkl. Dateien | öffentlich: `rewindFiles(userMessageId, {dryRun})` + `enableFileCheckpointing`; `resumeSessionAt`, `forkSession` | Fehlversuch rückgängig machen, Variante ausprobieren | groß (Checkpointing bisher bewusst aus) |
| 10 | Ausweichmodell bei Überlast | öffentlich: Option `fallbackModel` | weniger Abbrüche bei Überlastung | klein |
| 11 | Bereits gesendete Nachricht aus der CLI-Warteschlange zurückholen | öffentlich: `cancelAsyncMessage(uuid)` | ergänzt das heutige Entfernen vor dem Senden (`runtime.ts`) | klein |

## 3. Session-Infos als Daten statt Terminal-Dialog

Das CLI liefert die Inhalte seiner Terminal-Dialoge als Daten, „for a host that draws the dialog with
its own widgets“:

| # | Dialog | Schnittstelle |
|---|---|---|
| 12 | `/status` (Version, Konto, Provider, Modell, Server, Einstellungen) | intern: `getStatus()` |
| 13 | `/memory` (CLAUDE.md-Dateien, Schalter) | intern: `getMemoryDialog()` |
| 14 | `/skills` (Quelle, Token-Schätzung, Zustand) | intern: `getSkillsDialog()` |
| 15 | `/hooks` | intern: `getHooksListing()` |
| 16 | `/permissions` (Regeln mit Quelle, Sitzungsfreigaben) | intern: `listPermissionRules()` |
| 17 | MCP-Server: Status, an/aus, neu verbinden | öffentlich: `mcpServerStatus()`, `toggleMcpServer()`, `reconnectMcpServer()` |
| 18 | Plugins/Skills neu laden | öffentlich: `reloadPlugins()`, `reloadSkills()` |
| 19 | `/export` als Text | intern: `exportConversation()` |
| 20 | Ausgabe einer Hintergrund-Shell (letzte 8 KiB) | intern: `getTaskOutput()` (heute liest Parallax die `.output`-Datei selbst) |

Nutzen: ein Info-Bereich je Session („Warum hat Claude diese Regel? Welche Skills kosten wie viel
Kontext? Welcher MCP-Server hängt?“), ohne Terminal.

## 4. Sessions erweitern

| # | Möglichkeit | Schnittstelle | Nutzen | Aufwand |
|---|---|---|---|---|
| 21 | **Parallax-eigene Werkzeuge** für jede Session (In-Process-MCP-Server) | öffentlich: `createSdkMcpServer`, `tool()`, Option `mcpServers` | Claude kann z. B. dich benachrichtigen, eine Datei im Parallax-Viewer öffnen oder anderen Parallax-Sessions Aufgaben/Ergebnisse geben (Orchestrierung über Sessions hinweg) | mittel bis groß |
| 22 | Vollständige Subagent-Transkripte | öffentlich: Option `forwardSubagentText` | Agent-Karte zeigt Text und Thinking des Subagenten, nicht nur Werkzeuge | mittel |
| 23 | Dialoge, die heute still den Default nehmen (z. B. `refusal_fallback_prompt`: Modell lehnt ab → Ausweichmodell?) | öffentlich: `onUserDialog`, `supportedDialogKinds` | Nutzer entscheidet statt stiller Vorgabe | mittel |
| 24 | Schnellerer Session-Start mit vorgewärmtem Prozess | intern: `claimSession` (`--await-claim`) | neue Session antwortet sofort | mittel |
| 25 | Anmelden aus der Parallax-Oberfläche, wenn der Login abläuft | intern: `claudeAuthenticate`, `claudeOAuthCallback`, `claudeOAuthWaitForCompletion` | kein Terminal nötig (passt zu `credential_expires_at`, WP61-04) | mittel |
| 26 | Eigener Plan-Ablauf | öffentlich: Option `planModeInstructions` | Plan-Modus auf Parallax-Plan-Komfort abgestimmt | klein |
| 27 | Hook-Läufe sichtbar | öffentlich: Option `includeHookEvents` | Hooks im Transkript nachvollziehen | klein |
| 28 | Effort/Output-Style dauerhaft in die Einstellungen schreiben | öffentlich: `updateSettings()` | Auswahl gilt auch im Terminal | klein |
| 29 | Token-Budget je Aufgabe | alpha: Option `taskBudget` | Claude teilt sich lange Aufgaben ein | klein, alpha |

## 5. Empfehlung (Reihenfolge)

1. **Remote Control** (WP-64, nach dem Spike) – vom Nutzer als essentiell eingestuft.
2. **Paket „Übersicht“** (2, 3, 4, 5, 7): klein, großer Gewinn für viele parallele Sessions. Live-Satz und
   Turn-Fazit in der Seitenleiste, „In den Hintergrund“, Auto-Titel. Passt zu WP-63 (Seitenleiste).
3. **Info-Bereich je Session** (12–20): ein WP, rein lesend, geringes Risiko.
4. **Parallax-Werkzeuge per MCP** (21): eigenes Design-WP; öffnet Orchestrierung über Sessions hinweg.
5. Danach nach Bedarf: Zurückspulen/Abzweigen (9), Seitenfrage (8), vorgewärmte Prozesse (24), Login (25).

Für jede interne Schnittstelle gehört eine Probe in `pnpm cli-check`, damit ein `claude`-Update sie
nicht unbemerkt bricht.
