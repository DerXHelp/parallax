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

**Probe 12.11.2026 (live, Haiku, 0,0143 USD, Nutzer-Freigabe):** je ein Turn mit `Write` ohne Remote
Control in vier Env-Varianten – Basis wie Parallax (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`), zusätzlich
`CLAUDE_CODE_SDK_READS_SESSION_STATE=1`, `CLAUDE_CODE_CLASSIFIER_SUMMARY=1`, `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=1`
einzeln und zusammen. **In keiner Variante** kamen `task_summary` oder `post_turn_summary` (auch die
Aufzeichnungen in `test/fixtures/sdk` haben sie nicht). Laut Code laufen Live-Satz und Turn-Fazit nur, wenn
ein Metadaten-Abnehmer da ist – die Bridge (Remote Control). `CLAUDE_CODE_CLASSIFIER_SUMMARY` schaltet nur
zwischen Heuristik und Modell um. **Folge:** 2 und 3 gibt es nur bei verbundener Remote Control; ohne sie
braucht Parallax einen eigenen Rückfall (Live-Satz aus dem laufenden Werkzeugaufruf wie `ToolCallRow`, Fazit
aus dem letzten Assistenten-Text). `away_summary` (4) ließ sich so nicht auslösen (braucht eine
„weg“-Situation), bleibt offen.

**Durchgang mit dem Nutzer (12.11.2026):**
- **2 + 3:** zweite, ruhige Zeile unter dem Session-Namen in der Seitenleiste (arbeitet: Live-Satz; fertig:
  Fazit; braucht dich: hervorgehoben); Englisch ist in Ordnung. Ohne Remote Control Rückfall aus Parallax-Daten
  (laufender Werkzeugaufruf, erste Zeile der letzten Antwort).
- **4:** Stufe 1 (WP-65): Karte „Seit du zuletzt hier warst“ aus Parallax-Daten (Turns, geänderte Dateien,
  Freigaben, Kosten, letztes Fazit, Sprung zur letzten Stelle), gemessen am letzten Blick in Parallax.
  **Ausbaustufe** (Nutzerwunsch): Verfolgen und Antworten in der Claude-App zählt als „gesehen“ (Prompts/
  Freigaben aus der App sicher erkennbar; reines Mitlesen: Signal noch zu klären, z. B. `mark_read`,
  App-Client-Anmeldung an der Bridge).
- **5:** automatischer Titel nach dem ersten Turn, derselbe in Parallax, claude-Transkript und App; eigene
  Umbenennung wird nie überschrieben; „Titel neu erzeugen“ im Session-Menü; nach `/clear`/frischem Kontext
  automatisch neu, solange der Titel nicht selbst vergeben wurde. **Probe live (12.11.2026, ≈ 0,005 USD):**
  `generateSessionTitle(prompt, {persist})` → „Login-Fehlschlag nach Token-Ablauf“ (Sprache des Prompts,
  1,1 s; gleiche Beschreibung ein zweites Mal 0 ms), Kosten ≈ 0,00014 USD je Titel (gemessen über die
  Nutzungsabfrage), `persist:true` schreibt `{"type":"ai-title","aiTitle":…}` ins claude-Transkript.
- **6 (Vorbereitung):** Die experimentelle Nutzungsabfrage liefert `session` (Kosten, Dauer, Zeilen
  +/−, Tokens je Modell), `subscription_type`, `rate_limits` je Fenster (`utilization`, `resets_at`,
  Dollar-Felder; viele Fenster mit Codenamen, meist `null`) und `extra_usage`.
- **6 (entschieden):** Limit-Leiste immer gefüllt: Abfrage etwa alle 5 min über eine laufende Session
  (solange eine läuft), Auslastung je Fenster, Reset-Zeit im Tooltip; tolerant parsen, bei Fehler ausblenden
  (heutiges Verhalten), Probe in `pnpm cli-check`. **Keine** Zeilenzahlen (Nutzer: interessiert nicht).
- **7 (entschieden):** Knopf „In den Hintergrund“ an jedem laufenden Bash-Aufruf und an der laufenden
  Agent-Karte (`backgroundTasks(toolUseId)`), „Alles in den Hintergrund“ neben Stop im Composer
  (`backgroundTasks()`), Tastenkürzel Strg+B.

## 2. Steuerung im Arbeitsfluss

| # | Möglichkeit | Schnittstelle | Nutzen | Aufwand |
|---|---|---|---|---|
| 7 | **„In den Hintergrund“** für einen laufenden Bash-Befehl oder Subagenten (Strg+B) | öffentlich: `backgroundTasks(toolUseId?)` | langer Build blockiert den Turn nicht mehr | klein |
| 8 | **Seitenfrage** (`/btw`): kurze Frage, ohne den Kontext der Session zu belasten | intern: `askSideQuestion(question, {history})` | Rückfrage an eine laufende Session, ohne sie zu stören | mittel |
| 9 | **Zurückspulen / Abzweigen** ab einer Nachricht, inkl. Dateien | öffentlich: `rewindFiles(userMessageId, {dryRun})` + `enableFileCheckpointing`; `resumeSessionAt`, `forkSession` | Fehlversuch rückgängig machen, Variante ausprobieren | groß (Checkpointing bisher bewusst aus) |
| 10 | Ausweichmodell bei Überlast | öffentlich: Option `fallbackModel` | weniger Abbrüche bei Überlastung | klein |
| 11 | Bereits gesendete Nachricht aus der CLI-Warteschlange zurückholen | intern (Laufzeit, nicht in `sdk.d.ts`): `cancelAsyncMessage(uuid)` → `cancelled` | ergänzt das heutige Entfernen vor dem Senden (`runtime.ts`) | klein |

**Durchgang mit dem Nutzer (12.11.2026):**
- **8 (entschieden, WP-66):** `/btw` bzw. Umschalter im Composer, Karte „Seitenfrage · nicht im Kontext“ im
  Transkript mit Nachfragen, „Kurz fragen…“ aus dem Kontextmenü der Seitenleiste (Popover), von Parallax
  gespeichert und löschbar. **Probe live (Haiku, ≈ 0,0042 USD):** während eines laufenden Bash-Aufrufs Antwort
  nach 1,1 s, Turn läuft ungestört weiter; Nachfrage mit `history` funktioniert; **keine Werkzeuge**; ≈ 0,0004 USD je
  Frage (zählt ins kumulierte `total_cost_usd`, darum keine eigene Kostenanzeige je Karte); nichts im Hauptgespräch
  und im claude-Transkript; Fortschritt als `system/control_request_progress`.
- **9 (abgelehnt, vorerst):** Zurückspulen/Abzweigen – Nutzer: „habe ich nie benutzt und sehe keinen Einsatzzweck
  dafür erstmal“. Kein Checkpointing (`enableFileCheckpointing` bleibt aus). Falls später gewünscht: Abzweigen zuerst,
  „Ab hier neu“ mit Datei-Vorschau und Warnung, wenn eine parallele Session dieselben Dateien angefasst hat.
- **10 (entschieden):** nichts in Parallax bauen. Parallax lädt `~/.claude/settings.json`; ein Eintrag
  `"fallbackModel": ["sonnet"]` gilt damit für Parallax-Sessions und das Terminal (Auswertung im Headless-Betrieb
  nicht live geprüft).
- **11 (entschieden, WP-66):** „Zurückholen“ an jeder wartenden Nachricht → `cancelAsyncMessage(uuid)`, Text zurück
  ins Eingabefeld; `cancelled:false` (schon übernommen, z. B. in den laufenden Turn gefaltet) → Hinweis.

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
