# FIX-41-F1 – Fix-Paket F1 Server (Ergebnis)

> Auftrag: `docs/wp/FIX-41.md` §2, Zeile **F1 Server** (Befunde WP41-04, WP41-08 aus `docs/wp/WP-41.md`
> §2.3). Basis `main` = `881a539`, Branch `fix/41-f1` (Worktree `.worktrees/fix-41-f1`). Normativ:
> ADR-021, ADR-109, ADR-128; Nachtrag nach Freigabe des Koordinators: **ADR-129** (Gleichstands-Regel
> des Benachrichtigungsziels, Fokus-Gedächtnis im Hub; für diese Änderung auch `src/server/sync/hub.ts`
> freigegeben). Kein Live-`claude`, keine Desktop-Bedienung – nur Unit-/Engine-Tests mit FakeBackend.

## 1. Befunde

| Befund | Stand | Fix (Fundstellen) | Test (Gegenprobe ohne Fix rot) |
|---|---|---|---|
| **WP41-08** (NIT, ADR-128) | behoben | `claude/env.ts`: mit `CLAUDECODE` im Basis-Env (case-insensitiv) entfernt `buildEnvReport` für jedes Ziel außer `terminal` jetzt `PSExecutionPolicyPreference` (neue Liste `CLAUDE_SESSION_TOOL_SHELL_VARS`, Teilmenge von `TERMINAL_TOOL_SHELL_VARS`), Grund `tool_shell`, dieselbe Persistenz-Ausnahme (bleibt, wenn HKCU/HKLM `Environment` denselben Wert hat). `terminal` unverändert (alle Tool-Shell-Variablen); ohne `CLAUDECODE` unverändert. Neues Report-Feld `reasons: Map<name, EnvRemovalReason>` (Regel je Name aus `removed`/`keptPersistent`), damit der Grund prüfbar ist. Doc-Kommentare (Dateikopf, `TERMINAL_TOOL_SHELL_VARS`, `envRemovalReason`, `target`) und `src/server/claude/README.md` angepasst | `env.test.ts` „ADR-128 …“: SDK-Ziel (Default und `sdk`) und „Profil testen“/Preflight (`entryId: null`) entfernen sie mit Grund `tool_shell`, `GIT_EDITOR`/`GIT_TERMINAL_PROMPT`/`GIT_ASKPASS`/`GCM_INTERACTIVE`/`COREPACK_ENABLE_AUTO_PIN`/`NO_COLOR`/`PYTHONIOENCODING`/`NoDefaultCurrentDirectoryInExePath`/`MCP_TIMEOUT` bleiben; drei Schreibweisen (Variable und Marker); ohne `CLAUDECODE` bleibt sie (beide Ziele); persistent gleicher Wert → `keptPersistent` + Grund `tool_shell`, anderer Wert → entfernt; Profil kann sie über `${env:…}` bewusst setzen. Dazu „reports every removed tool-shell variable with the reason tool_shell“ (Terminal). **Gegenprobe:** alte Regel (nur `terminal`) → 7 Tests rot |
| **WP41-04** (NIT) – Log | behoben | `sessions/notifier.ts` (rein): `chooseChannelWithReason` liefert Kanal + Grund (`ChannelReason`: `viewing_focused`, `focused_elsewhere`, `last_focused`, `focus_tie`, `never_focused`, `no_client_native`, `no_client`) + Gleichstands-Stufe (`TieBreak`, s. u.); `routeNotification` = Ereignis-Art + Plan (null = nichts zugestellt) + Grund + Stufe + Einstellungsfilter (`do_not_disturb`/`toast_off`); `planNotification`/`chooseChannel` delegieren; `routeChannel` (`in_app`/`system`/`native`/`native_in_app`/`none`), `presenceSummary`. `sessions/manager.ts` `factsChanged`: genau eine `debug`-Zeile `notification route` je Benachrichtigungs-Ereignis (auch wenn nichts zugestellt wird) mit `entryId`, `kind`, `channel`, `clientId` (oder null), `reason`, `tieBreak`, `filter`, `presence` (`count`; je Client `clientId`, `focused`, `visible`, `systemNotifications` (null = nicht gemeldet), `viewing` (zeigt den Eintrag), `everFocused` (`lastFocusAt` gesetzt), `connectedRank` (1 = zuletzt verbunden)). Kein Titel (kann Prompt-Text sein), keine Texte, keine Secrets | `notifier.test.ts` „chooseChannelWithReason/routeNotification/presenceSummary“ (Tabelle aller Gründe und Stufen; Kanal identisch mit `chooseChannel`; Filter; „nichts zugestellt“ wird gemeldet); `engine.integration.test.ts` „WP41-04: one debug line per notification …“ (pino-Logger mit Puffer: App-Fenster nie fokussiert + später verbundener versteckter Hilfsclient → Zeile mit Ziel, `reason: never_focused`, `tieBreak: visible`, vollständiger Präsenz-Zusammenfassung; danach fokussierter Betrachter → Zeile mit `channel: none`, `viewing_focused`; Zahl der zugestellten Zeilen = Zahl der `notify`; kein `fake:bash` in den Zeilen). **Gegenprobe:** Log-Aufruf deaktiviert → Engine-Test rot |
| **WP41-04** – Ursache (ADR-129, Notifier) | behoben | `notifier.ts` `notificationTarget` (Ziel ohne fokussiertes sichtbares Fenster): (a) jüngstes `lastFocusAt` wie bisher; bei Gleichstand bzw. „nie fokussiert“ (b) `systemNotifications !== false` vor `false`, (c) `visible` vor unsichtbar, (d) zuletzt verbunden. Eine Stufe greift nur, wenn sie die Gruppe trennt (nicht alle/keiner passt). `tieBreak` nennt die Stufe, die einen Client übrig ließ (`notifications`/`visible`/`connected`; null ohne Gleichstand). `focused_elsewhere` unverändert (`lastFocusedWindow`: jüngster Fokus, dann zuletzt verbunden) | `notifier.test.ts`: Zeilen je Stufe (b entscheidet; b lässt zwei, c entscheidet; b+c lassen zwei, d entscheidet; keiner kann Web Notifications → b trennt nicht; Fokus schlägt alle Stufen; mehrere fokussierte Fenster unverändert), „WP-41 A4 (ADR-129)“ (sichtbares App-Fenster schlägt später verbundene versteckte Hilfsclients), `routeNotification` nennt die Stufe; Engine-Test (`notify` an das App-Fenster). **Gegenprobe:** Stufen b/c abgeschaltet → 7 Notifier-Tests + Engine-Test rot |
| **WP41-04** – Ursache (ADR-129, Hub) | behoben | `sync/hub.ts`: `focusMemory` (`Map<ClientId, Date>`, Reihenfolge = Alter des letzten Fokus, höchstens `HUB_LIMITS.focusMemory` = 256, älteste zuerst raus). Jede fokussierte Presence und jedes fokussierte Hello setzt `now()` und merkt es; ein unfokussiertes Hello übernimmt den gemerkten Wert des `clientId` statt `null` | `hub.test.ts` „presence: last focus across reconnects (ADR-129, WP41-04)“: unfokussierter Reconnect behält den Fokus (auch nach Blur), unbekanntes Fenster `null`; fokussierte Presence/Hello merkt `now()`; Obergrenze: 257 Fenster → ältester Fokus vergessen, ein erneut fokussiertes Fenster bleibt. **Gegenprobe:** Hello wieder `null` → 3 Tests rot; Verdrängung abgeschaltet → Obergrenzen-Test rot |

## 2. Analyse WP41-04

Vor dem Fix wählte `chooseChannel` ohne fokussiertes, sichtbares Fenster den Client mit dem jüngsten
`lastFocusAt`; bei Gleichstand – auch „nie fokussiert“ (`null` = −∞) – den **zuletzt verbundenen**. Der
Hub pflegte `lastFocusAt` **je Verbindung**: `handleHello` setzte `focused ? now() : null` – ein Fenster,
das sich unfokussiert (neu oder wieder, z. B. nach Server-Neustart, WS-Abbruch, Standby) verband, hatte
keine Fokus-Historie. Ein Blur lässt den Wert stehen (richtig). Das Web meldet beim Hello
`document.hasFocus()`; ein vom Launcher aus einem Hintergrundprozess gestartetes Edge-Fenster bekommt
unter Windows oft keinen Vordergrund (Foreground-Lock) – erst recht mit „Fokus-Attrappe vorn“.

**Wahrscheinliche Ursache des Live-Befunds:** In A4 hatten App-Fenster (sichtbar, nie fokussiert) und
die Hilfsclients `px.mjs`/`watch.mjs` (unsichtbar, unfokussiert, später verbunden) alle `lastFocusAt =
null` → Gleichstand → das `notify` (`system`) ging an den zuletzt verbundenen Hilfsclient, der nichts
anzeigt. Nach Fokus/Blur des App-Fensters (a4i) hatte es einen `lastFocusAt` und gewann. Live nicht
belegt; die Logzeile zeigt es bei der Nachprüfung (§5).

**Umgesetzt (ADR-129):** Stufe (c) lässt in diesem Szenario das sichtbare App-Fenster gewinnen; das
Fokus-Gedächtnis des Hubs verhindert, dass ein Reconnect die Fokus-Historie löscht. Grenze: Chromium
meldet ganz verdeckte Fenster ggf. als `hidden` (Occlusion) – dann entscheidet bei sonst gleichen
Clients weiter (d).

## 3. Entscheidungen

1. **WP41-08:** Grund sichtbar machen über ein neues Report-Feld `reasons` (Map, nicht Record – kein
   Prototyp-Risiko bei exotischen Env-Namen) statt einer zweiten Klassifizierungsfunktion; `removed`/
   `keptPersistent` unverändert, kein Aufrufer bricht (`integration.ts`, `profileIssues.ts`,
   `scripts/record/env.ts` lesen nur `env`/`issues`/`removed`/`set`; `scripts/preflight.ts` nutzt
   `buildEnv` nicht direkt).
2. **WP41-04 Log:** jedes Benachrichtigungs-Ereignis (`notificationFor` ≠ null) erzeugt eine Zeile, auch
   wenn nichts zugestellt wird (`channel: none`). Für „nichts zugestellt“ gilt die Schwelle des Ziels
   (fokussiertes Fenster: `doneMinSeconds`, sonst 0). Grund und Stufe getrennt (`reason` bleibt
   `focus_tie`/`never_focused`, `tieBreak` sagt, welche Stufe b/c/d den Ausschlag gab). Präsenz mit
   `connectedRank` statt Zeitstempeln.
3. **ADR-129:** eine Stufe filtert nur, wenn sie trennt (sonst bliebe bei „keiner kann Web
   Notifications“ niemand übrig); `tieBreak` = letzte wirksame Stufe. Fokus-Gedächtnis ohne Frist, nur
   mit Obergrenze 256 (LRU nach letztem Fokus) – Fenster-IDs sind je Fenster/Tab, 256 reicht weit; kein
   Zeitgeber nötig.

## 4. Checks

| Schritt | Ergebnis |
|---|---|
| `pnpm check` (Commit 1, `f5863b6`) | grün: typecheck ✓, lint ✓, Vitest 212 Dateien / 3731 Tests |
| `pnpm check` (Commit 2, ADR-129) | grün: typecheck ✓, lint ✓, Vitest 212 Dateien / **3741** Tests (273 s) |
| Gegenproben | WP41-08: alte Regel → 7 rot; Log aus → Engine-Test rot; ADR-129 Stufen b/c aus → 7 Notifier-Tests + Engine-Test rot; Hub-Hello `null` → 3 Hub-Tests rot; Verdrängung aus → Obergrenzen-Test rot |

## 5. Live-Prüfpunkte (Nutzer-Checkliste WP-41 §2.6)

- **WP41-08:** Server aus einer Claude-Code-Shell starten (`pnpm start`), eine Session starten; im
  SDK-`claude` (bzw. einem von ihm gestarteten Hook/MCP-Server) ist `PSExecutionPolicyPreference` leer;
  `GIT_EDITOR` u. a. dürfen dort stehen. Aus einer normalen Shell gestartet: unverändert.
- **WP41-04:** Server mit `--log-level=debug` (oder `PARALLAX_LOG_LEVEL=debug`) starten, A4 wiederholen
  (App-Fenster unfokussiert, Hilfsclients unsichtbar verbunden). Erwartet: Popup im App-Fenster schon
  beim ersten Versuch; in `PARALLAX_HOME\logs\parallax.*.log` je Benachrichtigung genau eine Zeile
  `notification route` mit dem App-Fenster als `clientId`, `reason: never_focused`, `tieBreak: visible`
  (bzw. `last_focused`, wenn es schon einmal fokussiert war). Zusätzlich: Server neu starten, App-Fenster
  verbindet sich unfokussiert wieder → `last_focused` (Fokus-Gedächtnis).

## 6. Wünsche an den Koordinator

- **README** `src/server/sessions/README.md`, Zeile `notifier.ts`: ergänzen um
  „`chooseChannelWithReason` (`ChannelChoice`, `ChannelReason`, `TieBreak`), `routeNotification`
  (`NotificationRoute`, `NotificationFilter`), `routeChannel` (`RouteChannel`), `presenceSummary`
  (`ClientPresenceSummary`) – Grund, Gleichstands-Stufe und Präsenz für die `debug`-Zeile
  `notification route` der Engine (WP41-04); Ziel bei Gleichstand: Web Notifications → sichtbar → zuletzt
  verbunden (ADR-129)“.
- **README** `src/server/sync/README.md` (Hub): „`lastFocusAt` je `clientId` über Reconnects gemerkt
  (`HUB_LIMITS.focusMemory` = 256, ADR-129)“.
- **Doku:** `docs/architecture.md` §5 „Präsenz“ (Gleichstands-Regel, Fokus-Gedächtnis) und ADR-129-Text
  (Koordinator); ggf. in `docs/progress.md` vermerken, dass `BuildEnvReport.reasons` neu ist
  (serverintern, keine Contract-Änderung).
