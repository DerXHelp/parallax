# FIX-41-F1 – Fix-Paket F1 Server (Ergebnis)

> Auftrag: `docs/wp/FIX-41.md` §2, Zeile **F1 Server** (Befunde WP41-04, WP41-08 aus `docs/wp/WP-41.md`
> §2.3). Basis `main` = `881a539`, Branch `fix/41-f1` (Worktree `.worktrees/fix-41-f1`). Normativ:
> ADR-021, ADR-109, ADR-128. Kein Live-`claude`, keine Desktop-Bedienung – nur Unit-/Engine-Tests mit
> FakeBackend.

## 1. Befunde

| Befund | Stand | Fix (Fundstellen) | Test (Gegenprobe ohne Fix rot) |
|---|---|---|---|
| **WP41-08** (NIT, ADR-128) | behoben | `claude/env.ts`: mit `CLAUDECODE` im Basis-Env (case-insensitiv) entfernt `buildEnvReport` für jedes Ziel außer `terminal` jetzt `PSExecutionPolicyPreference` (neue Liste `CLAUDE_SESSION_TOOL_SHELL_VARS`, Teilmenge von `TERMINAL_TOOL_SHELL_VARS`), Grund `tool_shell`, dieselbe Persistenz-Ausnahme (bleibt, wenn HKCU/HKLM `Environment` denselben Wert hat). `terminal` unverändert (alle Tool-Shell-Variablen); ohne `CLAUDECODE` unverändert. Neues Report-Feld `reasons: Map<name, EnvRemovalReason>` (Regel je Name aus `removed`/`keptPersistent`), damit der Grund prüfbar ist. Doc-Kommentare (Dateikopf, `TERMINAL_TOOL_SHELL_VARS`, `envRemovalReason`, `target`) und `src/server/claude/README.md` angepasst | `env.test.ts` „ADR-128 …“: SDK-Ziel (Default und `sdk`) und „Profil testen“/Preflight (`entryId: null`) entfernen sie mit Grund `tool_shell`, `GIT_EDITOR`/`GIT_TERMINAL_PROMPT`/`GIT_ASKPASS`/`GCM_INTERACTIVE`/`COREPACK_ENABLE_AUTO_PIN`/`NO_COLOR`/`PYTHONIOENCODING`/`NoDefaultCurrentDirectoryInExePath`/`MCP_TIMEOUT` bleiben; drei Schreibweisen (Variable und Marker); ohne `CLAUDECODE` bleibt sie (beide Ziele); persistent gleicher Wert → `keptPersistent` + Grund `tool_shell`, anderer Wert → entfernt; Profil kann sie über `${env:…}` bewusst setzen. Dazu „reports every removed tool-shell variable with the reason tool_shell“ (Terminal). **Gegenprobe:** alte Regel (nur `terminal`) → 7 Tests rot |
| **WP41-04** (NIT) | behoben (Log); Ursache: wahrscheinlicher Fehler gefunden, Fix als Wunsch §5 | `sessions/notifier.ts` (rein): `chooseChannelWithReason` liefert Kanal + Grund (`ChannelReason`: `viewing_focused`, `focused_elsewhere`, `last_focused`, `focus_tie`, `never_focused`, `no_client_native`, `no_client`); `routeNotification` = Ereignis-Art + Plan (null = nichts zugestellt) + Grund + Einstellungsfilter (`do_not_disturb`/`toast_off`); `planNotification`/`chooseChannel` delegieren (Verhalten unverändert); `routeChannel` (`in_app`/`system`/`native`/`native_in_app`/`none`), `presenceSummary`. `sessions/manager.ts` `factsChanged`: genau eine `debug`-Zeile `notification route` je Benachrichtigungs-Ereignis (auch wenn nichts zugestellt wird) mit `entryId`, `kind`, `channel`, `clientId` (oder null), `reason`, `filter`, `presence` (`count`; je Client `clientId`, `focused`, `visible`, `systemNotifications` (null = nicht gemeldet), `viewing` (zeigt den Eintrag), `everFocused` (`lastFocusAt` gesetzt), `connectedRank` (1 = zuletzt verbunden)). Kein Titel (kann Prompt-Text sein), keine Texte, keine Secrets | `notifier.test.ts` „chooseChannelWithReason/routeNotification/presenceSummary (WP41-04)“ (Tabelle aller Gründe; Kanal identisch mit `chooseChannel`; Szenario WP-41 A4; Filter; „nichts zugestellt“ wird gemeldet); `engine.integration.test.ts` „WP41-04: one debug line per notification …“ (pino-Logger mit Puffer: App-Fenster nie fokussiert + später verbundener versteckter Hilfsclient → `notify` an den Hilfsclient, Zeile mit `reason: never_focused`, vollständiger Präsenz-Zusammenfassung; danach fokussierter Betrachter → Zeile mit `channel: none`, `viewing_focused`; Zahl der zugestellten Zeilen = Zahl der `notify`; kein `fake:bash` in den Zeilen). **Gegenprobe:** Log-Aufruf deaktiviert → Engine-Test rot |

## 2. Analyse WP41-04 (Hub nur gelesen)

`chooseChannel` wählt ohne fokussiertes, sichtbares Fenster den Client mit dem jüngsten `lastFocusAt`;
bei Gleichstand – auch „nie fokussiert“ (`null` = −∞) – den **zuletzt verbundenen**. Der Hub
(`src/server/sync/hub.ts`) pflegt `lastFocusAt` **je Verbindung**:

- `handleHello` (Z. 736): `conn.lastFocusAt = message.presence.focused ? now() : null` – ein Fenster,
  das sich unfokussiert (neu oder wieder) verbindet, hat keine Fokus-Historie; ein Reconnect (Server-
  Neustart, WS-Abbruch, Standby) löscht sie.
- `presence` (Z. 791): nur `focused: true` setzt `lastFocusAt = now()`; ein Blur lässt den Wert stehen
  (richtig).
- Das Web meldet beim Hello `document.hasFocus()` (Presence-Tracking startet vor der Verbindung,
  `state/bootstrap.ts`). Ein vom Launcher aus einem Hintergrundprozess gestartetes Edge-Fenster bekommt
  unter Windows oft keinen Vordergrund (Foreground-Lock) – erst recht mit „Fokus-Attrappe vorn“.

**Wahrscheinliche Ursache des Live-Befunds:** In A4 hatten App-Fenster (sichtbar, seit seiner Verbindung
nie fokussiert) und die beiden Hilfsclients `px.mjs`/`watch.mjs` (unsichtbar, unfokussiert, später
verbunden) alle `lastFocusAt = null` → Gleichstand → das `notify` (`system`) ging an den zuletzt
verbundenen Hilfsclient, der nichts anzeigt. Nach Fokus/Blur des App-Fensters (a4i) hatte es einen
`lastFocusAt` und gewann. Genau dieses Szenario reproduzieren `notifier.test.ts` „WP-41 A4 …“ und der
Engine-Test (Zeile mit `reason: never_focused`, alle `everFocused: false`, Hilfsclient
`connectedRank: 1`). Live nicht belegt – die neue Logzeile zeigt es bei der Nachprüfung (§4).

Fix-Vorschläge (Verhalten, daher nicht in diesem Paket umgesetzt):

1. **Hub (Wunsch, Koordinator):** `lastFocusAt` je `clientId` über Verbindungen hinweg merken (z. B.
   `Map<ClientId, Date>`, bei jeder fokussierten Presence aktualisiert, begrenzt/mit Alter verworfen);
   im Hello `focused ? now() : (gemerkt ?? null)`. Behebt den Verlust beim Reconnect (Server-Neustart,
   Standby), nicht aber das nie fokussierte, neu gestartete Fenster.
2. **Notifier (Entscheidung Koordinator, ADR-Ergänzung zu A.9/ADR-109):** Gleichstand/nie fokussiert
   nicht nur nach `connectedAt` auflösen, sondern zuerst sichtbare (`visible: true`) Clients bevorzugen,
   dann solche mit `systemNotifications !== false`, dann zuletzt verbunden. Damit hätte in A4 das
   App-Fenster gewonnen. Umsetzung klein (`lastFocused` in `notifier.ts` + Tabellenzeilen), wenn
   freigegeben. Hinweis: Chromium meldet verdeckte Fenster ggf. als `hidden` (Occlusion), dann greift
   die Regel nicht.

## 3. Entscheidungen

1. **WP41-08:** Grund sichtbar machen über ein neues Report-Feld `reasons` (Map, nicht Record – kein
   Prototyp-Risiko bei exotischen Env-Namen) statt einer zweiten Klassifizierungsfunktion; `removed`/
   `keptPersistent` unverändert, kein Aufrufer bricht (`integration.ts`, `profileIssues.ts`,
   `scripts/record/env.ts` lesen nur `env`/`issues`/`removed`/`set`; `scripts/preflight.ts` nutzt
   `buildEnv` nicht direkt).
2. **WP41-04:** geloggt wird jedes Benachrichtigungs-Ereignis (`notificationFor` ≠ null), auch wenn
   nichts zugestellt wird (`channel: none`) – sonst fehlt genau der Fall „warum kam nichts?“. Für „nichts
   zugestellt“ gilt die Schwelle des Ziels (fokussiertes Fenster: `doneMinSeconds`, sonst 0); kurze
   „done“ unter der Schwelle sind kein Ereignis und erzeugen keine Zeile. Zugestellte Benachrichtigungen
   unverändert (`planNotification` = `routeNotification(...).planned`).
3. **WP41-04:** Präsenz-Zusammenfassung mit `connectedRank` statt Zeitstempeln (knapp, erklärt den
   Gleichstand) und `viewing` (erklärt `viewing_focused`); `clientId` je Client, damit das Ziel zuzuordnen
   ist (zufällige IDs, keine Secrets).

## 4. Checks

| Schritt | Ergebnis |
|---|---|
| `pnpm check` | grün: typecheck ✓, lint ✓, Vitest 212 Dateien / **3731** Tests (266 s) |
| gezielt `vitest run` `claude/env`, `scripts/record/env`, `profileIssues`, `integration`, `sessions/notifier`, `sessions/engine.integration` | grün (255 + 110 Tests) |
| Gegenproben | WP41-08: alte Regel → 7 rot; WP41-04: Log aus → Engine-Test rot |

## 5. Live-Prüfpunkte (Nutzer-Checkliste WP-41 §2.6)

- **WP41-08:** Server aus einer Claude-Code-Shell starten (`pnpm start`), eine Session starten; im
  SDK-`claude` (bzw. einem von ihm gestarteten Hook/MCP-Server) ist `PSExecutionPolicyPreference` leer;
  `GIT_EDITOR` u. a. dürfen dort stehen. Aus einer normalen Shell gestartet: unverändert.
- **WP41-04:** Server mit `--log-level=debug` (oder `PARALLAX_LOG_LEVEL=debug`) starten, A4 wiederholen
  (App-Fenster unfokussiert, ggf. Hilfsclients verbunden). In `PARALLAX_HOME\logs\parallax.*.log` je
  Benachrichtigung genau eine Zeile `notification route`: Ziel-`clientId`, `channel`, `reason`; erwartet
  bei ausbleibendem Popup `reason: never_focused` mit Hilfsclient als Ziel (bestätigt §2), nach
  Fokus/Blur `last_focused` mit dem App-Fenster.

## 6. Wünsche an den Koordinator

- **Hub** (`sync/hub.ts`): `lastFocusAt` je `clientId` über Reconnects merken (§2 Vorschlag 1).
- **Entscheidung** zur Gleichstands-Regel des Notifiers (§2 Vorschlag 2); bei Freigabe kleine Umsetzung
  in `sessions/notifier.ts`.
- **README** `src/server/sessions/README.md`, Zeile `notifier.ts`: ergänzen um
  „`chooseChannelWithReason` (`ChannelChoice`, `ChannelReason`), `routeNotification`
  (`NotificationRoute`, `NotificationFilter`), `routeChannel` (`RouteChannel`), `presenceSummary`
  (`ClientPresenceSummary`) – Grund und Präsenz für die `debug`-Zeile `notification route` der Engine
  (WP41-04)“. Zeile `manager.ts` (falls dort Logs aufgeführt sind): „je Benachrichtigungs-Ereignis eine
  `debug`-Zeile `notification route`“.
- **ADR-128 / Contract-Changelog:** keine Contract-Änderung; ggf. in `docs/progress.md` vermerken, dass
  `BuildEnvReport.reasons` neu ist (Server-intern).
