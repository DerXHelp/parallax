# WP-20b – Web-Verdrahtung

Welle 2, Worktree `wp-20b` (Branch `wp/20b`, Basis main `2299eb0`), parallel zu WP-20a (Server-
Verdrahtung) und dem Engine-Review; danach WP-20c (E2E in Edge gegen den echten Server).
Besitz-Pfade: `src/web/App.tsx`, `src/web/main.tsx`, `src/web/shell/**`, `src/web/state/**` (nur
Verdrahtung/Präsenz/Benachrichtigungen), `src/web/i18n/**`, neu `src/web/notifications/**`,
zugehörige Tests/READMEs, dieses Dokument.

## 1. Auftrag (sinngemäß)

Die gemergten Web-Bausteine (Shell/State/i18n/UI aus WP-14, Transkript WP-15, Entscheidungen +
Composer WP-16, Menü „Server beenden“ WP-21) in der App zusammensetzen:

- **Slots:** `TRANSCRIPT_SLOTS` und `{DecisionBar, DecisionCard, SidePanel: PlanSidePanel,
  Composer}` in `APP_SLOTS`; Namespace `serverShutdown` in `src/web/i18n/index.ts` registrieren,
  das lokale `useShutdownT` ablösen.
- **Echte Verbindung:** `getConnection('local')` mit WebSocket-Transport (gleicher Origin, im Dev
  über den Vite-Proxy), Auth-Bootstrap (`#code=` → `POST /api/auth` → `replaceState`), Banner für
  Verbindung, Fehler und Setup (claude fehlt, nicht eingeloggt, Store-Warnungen) mit übersetzten
  Fehlercodes.
- **Neue Session (Phase-1-Minimum):** Formular im Empty State bzw. über einen Knopf in der Sidebar:
  Ordnerpfad + zuletzt genutzte Projekte, „Session anlegen“, danach die Session wählen. Kein
  Ordner-Browser.
- **Kopfzeile:** Titel, Status (Icon + Text), Modus/Modell als kompakter Status (bedienbar ist der
  Composer, ADR-042), Warteschlangen-Badge (ADR-041), Context-Anzeige.
- **Benachrichtigungen Phase 1:** Präsenz korrekt senden; Server-`notify` im fokussierten Fenster als
  In-App-Hinweis (Notices-API), sonst als Web Notification mit Klick → Fenster/Session fokussieren;
  Berechtigung nur auf Klick („Benachrichtigungen aktivieren“); „wartet auf dich“ und „fertig“;
  Fenstertitel „(n) Parallax“.
- Playground bleibt funktionsfähig; Tests mit FakeHost/Memory-Transport (Slots, Auth-Bootstrap,
  Neue Session → Befehl, Kanalwahl, Kopfzeile); Sichttest im Playground (der Server von WP-20a war
  noch nicht verdrahtet).
- Abnahme: `pnpm check` 2× grün, `pnpm build` ohne Chunk-Warnung, Sichttest dark/light, en/de ohne
  Konsolenfehler, Diff nur in Besitz-Pfaden.

## 2. Ergebnis

**Status:** fertig (15.10.2026). Checks und Bundle: §2.8.

### 2.1 Slots und Einstieg

- `src/web/App.tsx`: `APP_SLOTS = { ...TRANSCRIPT_SLOTS, DecisionBar, DecisionCard, SidePanel:
  PlanSidePanel, Composer }` (Modul-Konstante). Transkript und `ToolInputPreview` bleiben Lazy-Chunks
  von WP-15; `DecisionBar`, `DecisionCard`, `PlanSidePanel`, `Composer` liegen im Start-Chunk.
- `src/web/main.tsx`: App → `bootApp()` (unverändert die erste Aktion vor dem Render); Playground →
  zusätzlich `startNotificationDelivery()`, damit `notify` der FakeHost-Szenarien wie in der App
  erscheint.
- `src/web/state/bootstrap.ts`: `bootApp({ fetch?, createSocket?, notifier?, reload? })` in dieser
  Reihenfolge: Code aus dem Hash (`consumeAuthCode` → `history.replaceState`), Auswahl aus
  `#session=`, Präsenz, Benachrichtigungs-Zustellung, Verbindung `local`
  (`ws://<location.host>/api/ws`; im Dev proxyt Vite `/api` inkl. WebSocket auf 4712). Features
  erreichen sie über `getConnection('local')`/`sendCommand` (Registry, unverändert).

### 2.2 i18n

- `serverShutdown` (WP-21-Dateien `shell/server-shutdown/i18n/{en,de}.ts`) statisch in
  `src/web/i18n/index.ts` registriert; `ServerShutdownDialog`/`SettingsMenu` rufen
  `t('serverShutdown.<key>')`; `shell/server-shutdown/i18n/index.ts` (`useShutdownT`,
  `translateShutdown`) gelöscht. Der Vollständigkeitstest der Wörterbücher deckt den Namespace jetzt
  mit ab.
- Neue Shell-Schlüssel (en/de): `shell.sidebar.newSession`, `shell.session.context`,
  `contextTokens`, `contextSource.{sdk,estimate}`, `shell.newSession.{description,hint}`,
  `shell.setup.preflight`, `shell.notifications.toastBody`,
  `shell.notifications.permission.{title,description,enable,later,granted,denied}`.
  Geändert: `shell.newSession.submit` „Create session“/„Session anlegen“ (vorher „Session
  starten“ – `session.create` ohne Prompt startet kein `claude`, die erste Nachricht tut es),
  `starting` „Creating…“/„Wird angelegt…“.

### 2.3 Verbindung, Auth, Banner

- Auth-Bootstrap, Reconnect, „Nicht angemeldet“/„Server beendet“/„nicht erreichbar“ waren in WP-14
  fertig; neu getestet über `bootApp` (`state/bootstrap.test.ts`: Code aus der URL, POST →
  Status → WS-URL, `clientHello` mit Präsenz, abgelehnter Code ohne WS, Präsenz nach Blur,
  Zustellung einer Benachrichtigung).
- **Fix `state/auth.ts`:** `POST /api/auth` mit 5xx gilt als „nicht erreichbar“ (Code bleibt für den
  nächsten Versuch), nur 4xx als abgelehnt. Vorher verwarf eine 502 des Vite-Proxys (Server noch
  nicht oben) den Code und zeigte später „Anmeldelink ungültig“. Test in `auth.test.ts`.
- `ShellBanners`: Setup-Hinweis mit `setupIssue(profile.claude)` – Serverfehler des Standardprofils,
  sonst abgeleitet: `not_found` → `CLAUDE_NOT_FOUND`, `logged_out` → `CLAUDE_NOT_LOGGED_IN`, Auth
  `error` → `CLAUDE_AUTH_FAILED`, `too_old` → `CLAUDE_VERSION_TOO_OLD` (dann auch ohne
  `setupRequired`, Ton `info`); dazu „Details: pnpm preflight“. Store-Warnungen (`warnings`) und
  Verbindungsbanner unverändert; neu das Berechtigungs-Banner (§2.6).

### 2.4 Neue Session

- `shell/NewSessionForm.tsx` (aus `EmptyState.tsx` herausgelöst): Ordnerpfad (Text) + bis zu fünf
  zuletzt genutzte Projekte (`recentProjects`: aus den Summaries nach Aktivität, case-insensitiv
  dedupliziert – der Contract hat keine eigene Liste), Hinweistext, unsichere Pfade vorab
  (`windowsPathIssue` → `PATH_REJECTED`), Serverfehler übersetzt inline (`CWD_NOT_FOUND` …), Knopf
  nur mit offener Verbindung. Nach dem `ack`: Session wählen (`#session=`), Feld leeren,
  `focusSessionInput(sessionKey)` – das Eingabefeld der neuen Session bekommt den Fokus
  (Nutzeraktion; wartet bis zu 20 Frames auf das Pane).
- `shell/NewSessionDialog.tsx`: dasselbe Formular als Dialog, geöffnet vom Sidebar-Knopf „Neue
  Session“ (`data-action="new-session"`, Stift-Icon neben den Einstellungen); nach dem Anlegen
  schließt er ohne Fokus-Rückgabe an den Knopf (`onCloseAutoFocus` verhindert, damit der Composer
  den Fokus behält). Empty State zeigt das Formular weiter inline.

### 2.5 Kopfzeile (`SessionHeader`)

Nur Status (ADR-042): Status-Icon + Text, Titel, Badges (Kompaktierung, Retry, „n eingereiht“ =
einzige Queue-Anzeige neben dem Transkript, ADR-041; Hintergrund; neu „n abgelaufene
Entscheidung(en)“ außer bei `needs-resume`), Ordner (Tooltip voller Pfad), Modell, tatsächlicher
Modus (Bypass rot) und **neu der Context-Füllstand** als nicht bedienbares `Gauge` (`role="meter"`,
70/85 %, Tooltip „720K von 1M Tokens · geschätzt/gemessen“; ohne Gauge ausgeblendet, ab `sm`).
Test-Attribute: `data-slot="session-header"` + `data-status`, `header-status`, `header-queued`,
`header-mode`, `header-model`, `header-context`.

### 2.6 Benachrichtigungen (`src/web/notifications/`)

- **Präsenz** (WP-14, unverändert, jetzt getestet): `startPresenceTracking` (Fokus über
  `focus`/`blur` + `document.hasFocus()`, Sichtbarkeit über `visibilitychange`), `viewingEntryId`
  aus der Auswahl, `typing` vom Composer (`reportTyping`, 5 s), gesendet im `clientHello` und nach
  jeder Änderung (250 ms entprellt).
- **Zustellung** `startNotificationDelivery({ store?, notifier?, focusWindow? })` (außerhalb von
  React, gestartet von `bootApp`): Jede `notify`-Nachricht (bleibt bis `notify.clear` in
  `ClientState.notifications`) wird genau einmal gezeigt. Kanal `chooseDeliveryChannel`: Fenster im
  Blick (fokussiert + sichtbar) → In-App-Hinweis über `showNotice` (ID `notify:<id>`, Ton je Art,
  10 s, „Session anzeigen“); sonst Web Notification (`tag = sessionKey`, Titel „‹Titel› – Plan
  prüfen“ …, Text „Klicken, um die Session anzuzeigen.“; Klick → `window.focus()`, Session wählen,
  schließen); ohne Berechtigung bleibt es in-app. Der Server wählt das Fenster (`delivery`), die
  Darstellung folgt der Präsenz beim Eintreffen – im Normalfall identisch, bei einem Wettlauf
  (Fenster gerade fokussiert/verlassen) die richtige. `notify.clear` zieht Hinweis und Toast zurück;
  das Anzeigen einer Session erledigt ihre Benachrichtigungen; ein neuer Toast derselben Session
  ersetzt den alten (dessen Handle wird nicht mehr geschlossen).
- **Berechtigung nur auf Klick:** Banner „Benachrichtigen, wenn eine Session dich braucht“ mit
  „Benachrichtigungen aktivieren“ / „Nicht jetzt“ (gemerkt in `parallax.notifications.permissionHint`),
  solange `Notification.permission === 'default'`; danach Hinweis „aktiv“ bzw. „blockiert – in den
  Website-Einstellungen erlauben“. Im Einstellungsmenü bleibt der Eintrag, solange nicht gefragt.
  Neu gelesen bei Fensterfokus.
- **`NotificationCenter`** zeigt nur noch die Notices-Region (lokale Hinweise + In-App-Kanal, max. 4
  sichtbar); die frühere eigene Darstellung der Server-Benachrichtigungen ist entfallen.
- Ereignisse: alles, was der Server sendet (`permission`, `question`, `plan`, `done`, `error`,
  `rate_limit`); Phase-1-Pflicht „wartet auf dich“ + „fertig“. Fenstertitel „(n) Parallax“ (WP-14).

### 2.7 Tests

- `App.test.tsx` (22): Shell wie bisher (Liste, Titel, Sprache/Theme, Reconnect, nicht angemeldet,
  Setup-Hinweis mit übersetztem Code + preflight, Alt+1/?), **verdrahtete Slots** (`APP_SLOTS` =
  WP-15/16-Komponenten; Transkript-Region mit Nachricht, Entscheidungsleiste „+2 weitere“ in
  `[data-decision-bar]`, Composer; Prompt per Enter → `session.sendPrompt`), **Neue Session** (Empty
  State → `session.create` + Auswahl + Fokus im Eingabefeld; unsicherer Pfad; Serverfehler
  `CWD_NOT_FOUND` inline; Dialog aus der Sidebar mit zuletzt genutzten Projekten), **Kopfzeile**
  (Status, „2 queued“, Modus, Modell, Context-Meter 72 % gelb, keine Knöpfe; ohne Gauge, abgelaufene
  Entscheidung), **Benachrichtigungen** (`notify` in-app mit „Session anzeigen“ → Auswahl,
  `notify.clear` zieht zurück, Berechtigung nur per Klick, „Nicht jetzt“ dauerhaft + Menüeintrag).
- `notifications/channel.test.ts`, `notifications/delivery.test.ts` (Kanalwahl Fokus vs. nicht,
  Rückfall ohne Berechtigung, Toast-Klick, einmalig, `notify.clear`, Auswahl erledigt, ersetzter
  Toast), `state/bootstrap.test.ts` (5), `state/presence.test.ts` (2), `state/auth.test.ts` (+1),
  `ServerShutdownDialog.test.tsx` (Namespace registriert).

### 2.8 Checks und Bundle

`pnpm check` 2× grün (siehe Bericht), `pnpm build` grün ohne Chunk-Warnung: Start-Chunks `index`
225,3 kB (vorher 150,5 kB – `DecisionBar`, `Composer`, `PlanSidePanel`, Wörterbuch `serverShutdown`),
`react` 218,8 kB, `vendor` 259,6 kB (vorher 235,6 kB); `TranscriptView` 32,5 kB, `MarkdownRenderer`
142 kB und Shiki bleiben lazy (R2W-21). Sichttest Playground (`PARALLAX_DEV_WEB_PORT=5178`,
`shell-overview`, `shell-decisions`, `shell-setup`; Dialog „Neue Session“ → angelegt, gewählt,
Composer fokussiert; Einstellungsmenü; Berechtigungs-Klick → im automatisierten Edge „blockiert“
mit Hinweis): dunkel/hell, en/de ohne Konsolenfehler. Die App unter `/` ohne Server: Code aus der URL
entfernt, `#session=` bleibt, „Server nicht erreichbar“ mit Countdown (einzige Konsolenmeldung: 502
des Vite-Proxys, erwartet). Gegen den echten Server nicht geprüft – WP-20a war noch nicht verdrahtet,
und der Dev-Server erlaubt nur die Origin `127.0.0.1:5173` (ADR-030).

### 2.9 Entscheidungen

1. **Server-Benachrichtigungen laufen über die Notices-API bzw. Web Notifications**, ausgeliefert von
   einem Modul außerhalb von React (keine Doppelauslieferung durch StrictMode/Remounts); die
   Darstellung folgt der Präsenz beim Eintreffen.
2. **„Neue Session“ als Formular im Empty State und als Dialog aus der Sidebar**; Knopf „Session
   anlegen“; danach Auswahl + Fokus im Composer der neuen Session (DOM-Suche im Pane, keine
   Feature-Abhängigkeit der Shell).
3. **Kopfzeile bleibt Status**: Context als nicht bedienbares Meter; Badge für abgelaufene
   Entscheidungen.

### 2.10 Schnittstellen – was der Server liefern muss (WP-20a)

- HTTP: `POST /api/auth`, `GET /api/auth/status` (§5.1), Seite + Assets, WS `/api/ws`.
- Handshake `hello` → `clientHello` (mit `presence`) → `host.state` → `summaries.snapshot`; Präsenz
  per `presence` an den `SessionSource` (`onPresenceChanged`, Hub WP-10 vorhanden).
- `host.state`: `setupRequired`, `profiles[].claude` (`state`, `auth.state`, `versionStatus`,
  `error`), `defaultProfileId`, `warnings`, `settings`.
- Summaries mit `status` (inkl. `queuedPrompts`, Entscheidungszähler, `unread`), `permissionMode`,
  `model`/`modelSetting`, `context`, `cwd`, `title`.
- Befehle, die die UI nutzt: `session.create {cwd}` (ohne Prompt; `summary.upsert` vor oder mit dem
  `ack`, Ergebnis `entryId`), `session.sendPrompt` (erste Nachricht startet den Eintrag),
  `session.interrupt`, `decision.respond`, `session.resume`, `session.setModel`,
  `session.setPermissionMode`, `session.setEffort`, `session.setFastMode`, `session.refreshModels`,
  `session.getContext`, `transcript.loadEarlier`, `settings.update`, `server.shutdown` (`ack`, dann
  Close 4503).
- `notify {id (eindeutig), kind, entryId, title, delivery}` (Kanal aus `sessions/notifier.ts`) und
  `notify.clear {entryId}`.

### 2.11 Gefundene Fehler / Hinweise

- `state/auth.ts`: 5xx beim Code-Tausch verwarf den Code (behoben, §2.3).
- `shell/ShortcutHelp.tsx`: Offen-Zustand ist modulweit und überlebte ein Unmount – in Tests blieb
  der Dialog über Testgrenzen offen (`aria-hidden` auf allem anderen); `closeShortcutHelp()`
  ergänzt.
- Features: keine Fehler gefunden, nichts in `src/web/features/**` geändert.

### 2.12 Follow-ups

- **WP-20c (E2E, Edge, FakeBackend):** R2W-07 (a)–(f); zusätzlich Auth mit `#code=` (Dev-Log bzw.
  Launcher-Code) → Cookie → WS; „Neue Session“ → erste Nachricht startet; Kopfzeile „n eingereiht“
  bei `next` während der Arbeit; Benachrichtigungen: Kontext mit `permissions: ['notifications']`
  (sonst Banner oder „Nicht jetzt“ klicken), `window.Notification` per `addInitScript` aufzeichnen,
  zweites Fenster/Blur für den `system`-Kanal, `notify.clear` nach Antwort in anderem Fenster;
  „Server beenden“ → „Server beendet“; Reload mit offener Karte; Dev nur mit Vite auf 5173 oder
  gegen den Build.
- **Selektoren/Test-IDs:** `[data-action="new-session"]`, `[data-slot="new-session-dialog"]`,
  `[data-slot="new-session-form"]` (Feld `name="cwd"`, Knopf „Create session“),
  `[data-recent-project="<pfad>"]`, `[data-slot="empty-state"]`, `[data-slot="session-header"]`
  (`data-status`), `header-status|header-queued|header-mode|header-model|header-context`,
  `[data-slot="notification-center"]` (Region „Notifications“), `[data-notice="notify:<id>"]`
  (`data-tone`), `[data-slot="notification-permission"]`, `[data-slot="setup-hint"]`,
  `[data-session-key]`, `[data-session-row]`, `[data-slot="connection-indicator"][data-status]`;
  aus WP-15/16: `[data-decision-bar]`, `[data-slot="decision-bar"]`, `[data-decision-id]`,
  `[data-slot="composer"][data-mode]`, `[data-slot="plan-panel"]`.
- Phase 2: Töne, Einstellungen je Ereignis, nativer Toast ohne Fenster, Ordner-Browser,
  Profilwahl; `de`-Wörterbücher lazy (Start-Chunk).

### 2.13 Stolpersteine

- PowerShell-Ersetzungen mit typografischen Anführungszeichen („“ ”) in der Befehlszeile wurden
  falsch kodiert und zerstörten `en.ts`/`de.ts` – Texte mit Nicht-ASCII nur über das Edit-Werkzeug
  ändern.
- `pnpm exec prettier` über `pnpm.ps1` reicht Datei-Arrays als einen String weiter – Bash nutzen.
