# src/web/shell – App-Shell und Slots (WP-14, verdrahtet in WP-20b)

Layout „Sidebar links + eine Session rechts“ (pane-fähig), Banner, Vollbild-Zustände,
Hinweis-Region, Shortcut-Registry und die `FeatureSlots` für WP-15/16 (architecture §2.3).
`src/web/App.tsx` setzt die Slots mit den echten Komponenten (`APP_SLOTS`, WP-20b). Phase 2:
Navigation (Sidebar, Quick-Switcher, Kopfzeile, Fenster) von WP-35 (`navigation/`,
`docs/wp/WP-35.md`), Querverbindungen über den Anfragekanal `requests.ts`.

| Datei | Inhalt |
|---|---|
| `slots.tsx` | `FeatureSlots` (Transcript, DecisionBar, Composer, SidePanel, DecisionCard, Markdown, ToolInputPreview), `FeatureSlotsProvider`, `useFeatureSlots`, `DEFAULT_FEATURE_SLOTS` |
| `placeholders.tsx` | neutrale Platzhalter der Slots (Transkript als Klartext-Liste, nie Markdown/HTML) |
| `AppShell.tsx` | Rahmen: `HostGate` → Sidebar + Banner + `PaneLayout`, `NotificationCenter`, `NewSessionDialog`, `NavigationLayer` (Phase 2), `ShortcutHelp` |
| `ShellEffects.tsx` | Theme, Sprache (aus `host.state.settings`), Fenstertitel „(n) Parallax“, fensterweiter Drop-Schutz (`installDropGuard`, R4W-02) |
| `drop-guard.ts` | `installDropGuard(target?)` → Entfernen-Funktion: `dragover`/`drop` am Fenster (Bubble-Phase, nach den Drop-Zonen); Dateien – und Links außerhalb von Textfeldern –, die keine Drop-Zone per `preventDefault` angenommen hat, werden abgewiesen (`dropEffect = 'none'`), damit Edge das Fenster nicht wegnavigiert (R4W-02) |
| `Sidebar.tsx` | Phase 2 (WP-35, Breite `w-72`): Umschalter flach/gruppiert (`navigation/sidebar-view.ts`); flach = angeheftete zuerst, gruppiert = je Projektordner (`groupSessions`, Schlüssel `windowsPathKey(cwd)` je Host; Gruppen mit angehefteter Session zuerst, V3-14) mit „+“ (`data-action="new-session-here"`, kein Tab-Stopp) und Kontextmenü „Neue Session in diesem Projekt…“; zweizeilige Einträge (`navigation/SessionRow.tsx`); Archiv-Ansicht über „Archiv (n)“ (nach dem Wiederherstellen der letzten zurück zur Liste); „Wartet auf dich (n)“ + Alt+N (nächste wartende, zyklisch, `data-action="next-waiting"`), Alt+1…9 (sichtbare Liste); Abo-Limits unten (`navigation/AccountLimits.tsx`); Knopf „Neue Session“ (`data-action="new-session"`) |
| `SessionPane.tsx`, `SessionHeader.tsx` | eine Session: Leiste `data-slot="session-bar"` = Kopfzeile (Status, ADR-042: Status-Icon + Text, Titel, Badges „n eingereiht“/Kompakt/Retry/Hintergrund/abgelaufen, Ordner, Modell, tatsächlicher Modus, CLI-Version, Context-Füllstand mit Tokens im Tooltip; `data-slot="session-header"`, `data-status`) und rechts daneben das „…“-Menü (`navigation/SessionMenu.tsx`, `data-slot="session-menu"`); Titel inline umbenennbar (Doppelklick, F2, `/rename` → `navigation/RenameField.tsx`); der Titel gibt zuerst nach, unter den Fakten kürzen nur Pfad und Modell (Ellipse), CLI-Version, Modus und Context bleiben `shrink-0` (V3-05); Pane-Banner extern/archiviert (`navigation/PaneBanners.tsx`); Slots, Laden/`session.unavailable`/gelöscht |
| `PaneLayout.tsx` | eine oder mehrere Panes (Split-View später) |
| `EmptyState.tsx` | Willkommen / „keine Session gewählt“ mit dem Formular „Neue Session“ (inline) |
| `NewSessionForm.tsx` | Phase 2 (WP-36): Pfadfeld + „Durchsuchen…“ (Ordner-Browser), zuletzt genutzte Projekte (bis 8, aus den Summaries), Profilwahl (Default vorausgewählt) mit den Vorgaben des Profils → `session.create {cwd, profileId}`, Session wählen, Eingabefeld fokussieren (`focusSessionInput`); unsichere Pfade vorab abgelehnt; `chosenProfile` |
| `NewSessionDialog.tsx` | dasselbe Formular als Dialog; Handler der Anfrage `newSession` (`useShellRequestHandler`), `openNewSession(prefill?)` (`{cwd?, profileId?}`, auch direkt als `onClick`), `closeNewSession`; Formular je Öffnung neu (Vorbelegung); Esc/X/Klick daneben geben den Fokus an den Öffner zurück, nach „Session anlegen“ bekommt ihn das Eingabefeld der neuen Session (V3-04) |
| `HostFacts.tsx` | `HostFacts` (`data-slot="host-info"`: Claude Code des Standardprofils mit Version/Pfad, Agent SDK, Parallax, Datenordner, FakeBackend) – eine Quelle für das Einstellungsmenü (`SettingsMenu.tsx`) und den Bereich „Über“ der Einstellungsseite (`features/preferences`, ADR-126; R4W-22) |
| `HostGate.tsx` | „Nicht angemeldet“, „Server beendet“, „nicht erreichbar“ (Countdown), „Verbinde…“, veraltetes Fenster mit „Neu laden“ + „Server beenden…“ (Inline-Rückfrage, `shutdownServer`, V2-04) |
| `ShellBanners.tsx` | Verbindung unterbrochen, Setup-Hinweis (`setupIssue`: Fehler des Standardprofils bzw. claude fehlt/abgemeldet/zu alt, übersetzt), Server-Warnungen, Benachrichtigungs-Berechtigung |
| `NotificationPermissionBanner.tsx` | „Benachrichtigungen aktivieren“ (nur per Klick, `enableNotifications`), „Nicht jetzt“ |
| `NotificationCenter.tsx` | Hinweis-Region unten rechts: lokale Hinweise aus `state/notices.ts` – auch die In-App-Benachrichtigungen des Servers (`src/web/notifications`) mit „Session anzeigen“; optional ein Knopf je Hinweis (`ClientNotice.action`, `data-notice-action`, z. B. „Töne aktivieren“); über modalen Dialogen (ADR-126, R4W-05): `z-[60]` über dem Overlay, `aria-live="off"` (Radix' `hideOthers` lässt die Region aus, die Karten sind die Live-Regionen), `pointerdown` bleibt in der Region (ein Klick auf einen Hinweis schließt den Dialog nicht) |
| `SettingsMenu.tsx` | Theme, Sprache, „Benachrichtigungen aktivieren“ (solange nicht gefragt), Tastenkürzel, „Server beenden“, Server-Infos über `HostFacts.tsx`; Phase 2 (WP-38): Eintrag „Einstellungen…“ (`data-action="open-settings"`, nur mit verdrahtetem Slot `SettingsPage`), Handler der Anfrage `settings` (`section?`) – eine Anfrage bei offener Seite wechselt nur `section`, die Seite wird nie neu montiert (ein ungespeicherter Profil-Entwurf bleibt, R4W-01 c) |
| `ShortcutHelp.tsx` | `?`-Hilfe (`openShortcutHelp`, `closeShortcutHelp`, `HELP_KEYS`); ohne Trigger: gibt den Fokus beim Schließen dorthin zurück, wo er vorher war (`useReturnFocus`, V3-04) |
| `ConnectionIndicator.tsx` | Verbindungsstatus (Punkt + Text) |
| `shortcuts.ts` | zentrale Registry: `useShortcut` (`scope`/`scopeRef`), `useEscapeHandler((event) => boolean, enabled, { scope?, scopeRef? })`, `isInScope`, `shortcuts`, `installShortcutListener`, `parseShortcut`, `shortcutKeyLabels` – keine Strg+Alt-Kürzel, Alt+Numpad nie; solange ein Dialog oder Menü offen ist, feuern nur Kürzel mit `scope`/`scopeRef`, deren Bereich den Fokus hat (R4W-11) |
| `decision-focus.ts` | „Zur Entscheidung“ (architecture §2.3e): `focusDecision(sessionKey, decisionId)`, `useDecisionFocusHandler`, `registerDecisionFocusHandler`, `findDecisionBar` |
| `transcript-follow.ts` | eigenes Senden → Transkript ans Ende (V2-06, ADR-074): `followTranscript(sessionKey)` (Composer), `useTranscriptFollowHandler` (Transkript) |
| `requests.ts` | Anfragekanal (Phase-2-Gerüst, ADR-115, Koordinator): `requestShell(request)` → `boolean`, `useShellRequestHandler`/`registerShellRequestHandler`; Arten `newSession` (`cwd?`, `profileId?`), `renameTitle`, `conversations`, `sessionInfo`, `quickSwitcher`, `settings` (`section?`, `SETTINGS_SECTIONS`) – nur aus Nutzeraktionen |
| `navigation/` | Phase 2 (WP-35, eigene README, Namespace `navigation`): `NavigationLayer` (Handler `renameTitle`/`conversations`/`sessionInfo`/`quickSwitcher`, Strg+K, F2), Sidebar-Zeile, Kontextmenü und „…“-Menüs aus einer Aktionsliste (`session-actions.tsx`: Umbenennen, Anheften, neues Fenster, Schlafen legen, externe Konsole, Konsolenbefehl kopieren, Archivieren …), Inline-Umbenennen, Quick-Switcher (Rangfolge nach Treffergüte, V3-03; Enter fokussiert das Eingabefeld der Session), Frühere Unterhaltungen, Session-Info, Pane-Banner, Abo-Limits; Fokus-Rückfall `focus.ts` (`sessionFocusTarget`: „…“ der Kopfzeile bzw. Sidebar-Zeile) und `sessionMenuCloseAutoFocus` – der Fokus endet nach Menüs und Dialogen nie auf `<body>` (R4W-04/V3-04) |
| `new-session/` | Phase 2 (WP-36, eigene README): `FolderBrowser` (Server-API `fs.listDirectory`), `ProfileSelect`, Profil-Status/-Issues, `recentProjects`, Namespace `newSession`; `FolderBrowser` und Profil-Status nutzt auch der Profil-Editor (`features/profiles`) |
| `server-shutdown/` | „Server beenden“ (WP-21), Namespace `serverShutdown` |

Regeln: Kürzel nur über die Registry (keine eigenen `keydown`-Listener auf `window`);
Entscheidungs-Kürzel mit `scopeRef` der eigenen Leiste (die Leiste liegt in
`[data-shortcut-scope="decision-bar"][data-decision-bar="<sessionKey>"]`); Esc über
`useEscapeHandler` mit Scope (neuester Handler zuerst, nur mit Fokus im Scope, offene Dialoge/Menüs
haben Vorrang). Dialoge ohne Trigger geben den Fokus beim Schließen zurück (`useReturnFocus` aus
`src/web/lib/return-focus.ts`, R4W-04). `SessionPane` rendert die Slots über `memo`-Wrapper und liest nur schmale Selektoren.
Die Kopfzeile `[data-slot="session-header"]` zeigt nur Status (Modus/Modell/Context-Picker sitzen im
Composer, ADR-042); bedienbar ist dort nur der Titel (Inline-Umbenennen), das „…“-Menü liegt daneben
in `session-bar`, nicht im Header (WP-35). Die Warteschlange zeigt nur das Transkript plus das Badge
(ADR-041).
