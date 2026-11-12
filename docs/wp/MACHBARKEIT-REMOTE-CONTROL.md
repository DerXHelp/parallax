# Machbarkeit: Remote Control für Parallax-Sessions

- **Anlass (12.11.2026, Nutzer):** Mit `"remoteControlAtStartup": true` in der User-`settings.json` sind
  Sessions, die Parallax startet, trotzdem nicht in claude.ai bzw. der Claude-App sichtbar. Der Nutzer
  hält das für „essentiell wichtig“ (Punkt 6 aus Nutzer-Feedback 1, `docs/wp/WP-63.md`). Zusatzfrage:
  Was bietet die Bridge sonst noch?
- **Quellen:** `@anthropic-ai/claude-agent-sdk` 0.3.322 (`sdk.mjs`, `sdk.d.ts`, `bridge.d.ts`) und das
  installierte `claude` 2.1.322 (gebündelter JS-Code in `claude.exe`). Nur Code gelesen, **noch kein
  Live-Lauf**. Alle genannten Schnittstellen sind `@internal` bzw. `@alpha`, also undokumentiert.

## 1. Befund: Warum die Einstellung nicht greift

- Parallax lädt die User-Einstellungen (`SETTING_SOURCES = ['user','project','local']`,
  `backend/sdkOptions.ts`). Die Einstellung kommt beim CLI also an.
- `remoteControlAtStartup` wertet aber nur die interaktive Oberfläche (TUI) selbst aus. Ein headless
  Host (SDK, VS Code, Desktop) muss die Bridge **selbst einschalten**. Dafür meldet das CLI in
  `get_settings` interne Felder „so IDE hosts can mirror TUI behavior“:
  `remote_control_auto_enable` (Einstellung → Policy-Default → Rollout),
  `remote_control_auto_on_by_default`, `remote_control_auto_connect_default`,
  `remote_control_policy_lock_reason`.
- Repo-Einstellungen (`project`/`local`) können Remote Control nur ausschalten, nie einschalten. Das CLI
  meldet das als Warnung.

## 2. Mechanismus: Steuerbefehl `remote_control`

- Die SDK-Laufzeit hat die (nicht typisierte) Methode
  `query.enableRemoteControl(enabled, name?, { reattachSessionId?, keepSessionOnExit?, workSecret?, refreshWorkSecret? })`.
  Sie sendet `control_request {subtype:'remote_control', enabled, name, reattach_session_id,
  keep_session_on_exit, work_secret}`.
- Der CLI-Prozess (headless, `print.ts`) ruft dann `initReplBridge(...)` mit `remoteControlOrigin:'sdk'`
  auf. Das ist dieselbe Bridge wie `/remote-control` im Terminal, angemeldet mit dem **eigenen Login des
  CLI** (Abo). Parallax fasst keine Tokens an.
- Antwort: `{ session_url, connect_url, environment_id, bridge_epoch, bridge_session_id }`.
  `session_url` ist der Link zur Session in claude.ai bzw. der App.
- Fehler beim Einschalten (Fehlercodes im Control-Error): `remote_control_auth` (neu anmelden),
  `remote_control_terminal`, `remote_control_ended_elsewhere`, `remote_control_policy_disabled`.
  In einer Remote-Session selbst wird das Einschalten abgelehnt.
- Verbindungszustände (intern): `ready`, `connected`, `failed`, `policy_disabled`, Wiederverbindung nach
  `failed` → `connected`. Ob und wie das CLI sie dem Host als Nachricht meldet, klärt der Spike.

## 3. Verhalten bei eingeschalteter Bridge (laut Code)

- **Prompts vom Handy:** Das CLI reiht sie selbst in seine Warteschlange ein und startet den Turn. Für
  Parallax ist das ein Turn, den es **nicht selbst gestartet** hat.
- **Freigaben und Rückfragen** (`can_use_tool`, `request_user_dialog`) gehen an beide Seiten, offene
  werden beim Einschalten nachgereicht. Wer zuerst antwortet, gewinnt; die andere Seite bekommt einen
  `control_cancel_request`. In Parallax kommt das als Abbruchsignal im `canUseTool`-Callback an
  (`broker.ts`, `signal_aborted`).
- **Vom Handy steuerbar:** Interrupt, Stop je Task, Hintergrund-Tasks, Modell, Thinking, Permission-Modus,
  Effort/Ultracode (`apply_flag_settings`), Umbenennen.
- **Fortsetzung:** `reattach_session_id` hängt einen neuen Prozess an dieselbe claude.ai-Session (nach
  Schlaf oder Neustart); `keep_session_on_exit` lässt die Session beim Prozessende stehen statt sie zu
  archivieren.

## 4. Was Parallax dafür braucht (grob, für ein WP)

1. **SDK-Grenze (Backend):** `enableRemoteControl` per Laufzeitprüfung aufrufen (Methode vorhanden?),
   Antwort mit zod prüfen; fehlt sie (anderes SDK/CLI), sauber „nicht verfügbar“ melden.
2. **Engine:** Turns ohne eigenen Prompt (Status, Kosten, Queue). Prompt-Text vom Handy sichtbar machen:
   `--replay-user-messages` (bisher bewusst nicht gesetzt, F.9) oder ein anderes Signal, klärt der Spike.
   Entscheidungen, die in der App beantwortet wurden, als „in der Claude-App beantwortet“ statt
   „abgebrochen“ zeigen.
3. **Lebenszyklus:** `bridge_session_id` je Konversation speichern und beim Wiederanlauf als
   `reattachSessionId` übergeben. Schlaf bei Leerlauf (ADR-105) trennt die Bridge: Remote-Sessions vom
   Schlaf ausnehmen oder Schlaf bewusst zulassen (Nutzerfrage).
4. **UI:** Anzeige je Session (verbunden/getrennt/Fehler), Link bzw. QR-Code „In der Claude-App öffnen“,
   globale Einstellung (Default aus `remote_control_auto_enable`, also der `settings.json` des Nutzers),
   Schalter je Session.
5. **Contracts:** neue Felder (Bridge-Zustand, `session_url`), neue Befehle; Contract-Freigabe nötig.
6. **`pnpm cli-check` (WP-62):** Probe „Remote Control einschalten“ ins CLI-Profil aufnehmen, damit ein
   CLI-Update die interne Schnittstelle nicht unbemerkt bricht.

## 5. Weitere Möglichkeiten durch die Bridge (Zusatzfrage)

| Möglichkeit | Nutzen für Parallax | Stand |
|---|---|---|
| Freigaben, Rückfragen, Plan vom Handy beantworten | unterwegs weiterarbeiten lassen | im Code belegt |
| Push aufs Handy bei wartender Freigabe (`inputNeededNotifEnabled`), proaktive Pushes (`agentPushNotifEnabled`) | ergänzt die Desktop-Benachrichtigungen | Einstellung belegt; ob sie bei SDK-Bridge greift: Spike |
| Stop, Modell, Effort, Permission-Modus, Umbenennen vom Handy | volle Steuerung unterwegs | im Code belegt |
| Session-Link `session_url` | Knopf/QR-Code in Parallax, Session direkt auf dem Handy öffnen | im Code belegt |
| Gleiche claude.ai-Session über Schlaf/Neustart (`reattach_session_id`) | keine doppelten Einträge in der App | im Code belegt |
| Nur ansehen statt steuern (`autoUploadSessions`, Spiegel ohne Eingabe) | vorsichtige Variante | Einstellung belegt, Wirkung bei SDK offen |
| Sessions als Gegenüber für andere Claude-Sessions (Cross-Session-Nachrichten, `crossSessionInbound`) | Parallax-Sessions von anderen Rechnern ansprechbar | Hinweise im Code, ungeprüft |
| Schlafende Sessions vom Handy wecken (`work_secret`-Pfad: Host als „Environment“, holt Arbeit ab) | Handy startet Arbeit, auch wenn der Prozess schläft | Umgebungs-API nicht öffentlich im SDK, später |

Nebenbefund (keine Bridge, gleiche Fundstelle): Die `Query` hat weitere interne Methoden, die Parallax
nutzen könnte, z. B. `generateSessionTitle`, `askSideQuestion` (Seitenfrage ohne Kontext zu belasten),
`getPlan`, `exportConversation`, `getSettings`, `claudeAuthenticate` (Login aus der UI). Alle intern, also
nur mit Absicherung über `pnpm cli-check`.

## 6. Risiken

- **Undokumentiert:** `enableRemoteControl` fehlt in den öffentlichen Typen; CLI-Updates können es
  ändern. Gegenmittel: Laufzeitprüfung, sauberer Rückfall, Probe in `pnpm cli-check`.
- **Fremde Turns** sind für die Engine neu (Queue, Status, Stop) und der größte Umbau.
- **Viele Sessions** erscheinen alle in der App; Benennung über `name` (Parallax-Titel).
- **Konto-/Org-Policy** kann Remote Control sperren (`remote_control_policy_lock_reason`) – dann nur
  Hinweis anzeigen.

## 7. Nächste Schritte

1. **Spike live (Freigabe nötig):** kleines Skript im Scratch-Ordner mit dem SDK aus `node_modules`,
   Haiku, Abo, eigenes Temp-Arbeitsverzeichnis, ≤ 0,10 USD. Prüft: Antwort von `enableRemoteControl`,
   Sichtbarkeit in der App (Nutzer schaut aufs Handy), Prompt vom Handy (was kommt auf stdout an), Freigabe
   vom Handy (Abbruchsignal), Zustandsmeldungen, `reattachSessionId`. Ergebnis hier in §8.
2. **WP-64 „Remote Control“** auf `feature/ux-feedback` nach WP-63 (gleiche Engine-Dateien:
   `sessions/commands.ts`, `runtime.ts`, `entryState.ts`), mit Contract-Freigabe nach dem Spike.

## 8. Spike-Ergebnis (12.11.2026, live, Nutzer-Freigabe)

Aufbau: Skript im Scratch-Ordner mit dem SDK aus `node_modules` (0.3.322), `claude` 2.1.322, Haiku, Abo,
leeres Temp-Arbeitsverzeichnis, Env nach den Regeln von `buildEnv` (u. a. `CLAUDE_CODE_BRIDGE_SESSION_ID`
der aufrufenden Session entfernt), `settingSources` wie Parallax, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`.
Phase A: einschalten, Tests am Handy. Phase B: Prozess neu (`resume`) mit `reattachSessionId` und
`--replay-user-messages`, am Ende `enableRemoteControl(false)`. Kosten zusammen **0,0182 USD**, keine
Prozessreste.

| Prüfpunkt | Ergebnis |
|---|---|
| `enableRemoteControl` im headless SDK-Modus | **funktioniert**: Antwort nach ≈ 1 s, `{session_url: "https://claude.ai/code/session_…", connect_url, environment_id: "", bridge_epoch: 1, bridge_session_id: "cse_…"}` |
| Zustandsmeldungen an den Host | `system/bridge_state {state:"ready"}`, dann `{state:"connected", bridge_epoch:1}` |
| Vorgabe aus den Einstellungen | `getSettings().effective.remoteControlAtStartup = true` (Nutzerwert); `remote_control_auto_enable` liefert dieses CLI nicht |
| Prompt vom Handy | das CLI startet den Turn selbst. **Ohne** Replay: kein `user`-Echo, aber `command_lifecycle` (`queued`/`started`/`completed`) mit einer `command_uuid`, die Parallax nicht kennt. **Mit** `--replay-user-messages`: `user` mit `isReplay:true` und **`origin:{kind:"human"}`** (lokale Prompts ohne `origin`) |
| Freigabe vom Handy (`Write`) | erteilt am Handy; im Host wird `canUseTool` per `AbortSignal` abgebrochen (`AbortError`, 7 s nach der Anfrage), danach läuft das Werkzeug, `tool_result` folgt. „Wer zuerst antwortet, gewinnt“ bestätigt |
| Neustart mit `reattachSessionId` | **gleiche** `bridge_session_id`/`session_url` → derselbe Eintrag in der App; Prompt vom Handy danach funktioniert |
| Ausschalten | `enableRemoteControl(false)` → ohne Fehler |
| Nebenbei gesehen | `system/task_summary {detail:"Writing handy.txt"}` während des Turns, `system/post_turn_summary {status_category:"completed", status_detail:"handy.txt created with content 'hallo'", needs_action:""}` nach jedem Turn (siehe `docs/wp/SDK-MOEGLICHKEITEN.md`) |
| Beobachtung Nutzer | Phase B lief in derselben App-Session (Wiederanbindung bestätigt). Sofortige Sichtbarkeit und Push bei wartender Freigabe nicht beobachtet → Live-Abnahme WP-64 |
| Entscheidung Nutzer | Remote-Control-Sessions schlafen nicht (12.11.2026) |

**Folgerungen für WP-64:**
- Technisch alles Nötige bestätigt. Parallax setzt künftig `--replay-user-messages` (nur bei
  Remote Control oder generell, Entscheidung im WP; Auswirkung auf F.9/Queue prüfen) und zeigt Prompts mit
  `origin.kind === "human"` ohne eigene `command_uuid` als „vom Handy“.
- Fremde Turns erkennt die Engine an `command_lifecycle` mit unbekannter `command_uuid`; Status „arbeitet“
  folgt aus `session_state_changed`, das Parallax schon auswertet.
- Eine Entscheidung, deren `canUseTool` per Signal endet, während Remote Control verbunden ist, heißt in
  der UI „in der Claude-App beantwortet“.
- `bridge_session_id` je Konversation speichern, beim Wiederanlauf `reattachSessionId`; `keepSessionOnExit`
  an, damit Schlaf und Neustart die Session in der App nicht archivieren.
- Probe für `pnpm cli-check`: Methode vorhanden, Antwort-Schema, `bridge_state connected`, Ausschalten.
