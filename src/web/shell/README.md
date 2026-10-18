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
| `ShellEffects.tsx` | Theme, Sprache (aus `host.state.settings`), Fenstertitel „(n) Parallax“ |
| `Sidebar.tsx` | Phase 2 (WP-35, Breite `w-72`): Umschalter flach/gruppiert (`navigation/sidebar-view.ts`); flach = angeheftete zuerst, gruppiert = je Projektordner (`groupSessions`, Schlüssel `windowsPathKey(cwd)` je Host) mit „+“ (`data-action="new-session-here"`) und Kontextmenü „Neue Session in diesem Projekt…“; zweizeilige Einträge (`navigation/SessionRow.tsx`); Archiv-Ansicht über „Archiv (n)“; „Wartet auf dich (n)“ + Alt+N (nächste wartende, zyklisch, `data-action="next-waiting"`), Alt+1…9 (sichtbare Liste); Abo-Limits unten (`navigation/AccountLimits.tsx`); Knopf „Neue Session“ (`data-action="new-session"`) |
| `SessionPane.tsx`, `SessionHeader.tsx` | eine Session: Leiste `data-slot="session-bar"` = Kopfzeile (Status, ADR-042: Status-Icon + Text, Titel, Badges „n eingereiht“/Kompakt/Retry/Hintergrund/abgelaufen, Ordner, Modell, tatsächlicher Modus, CLI-Version, Context-Füllstand mit Tokens im Tooltip; `data-slot="session-header"`, `data-status`) und rechts daneben das „…“-Menü (`navigation/SessionMenu.tsx`, `data-slot="session-menu"`); Titel inline umbenennbar (Doppelklick, F2, `/rename` → `navigation/RenameField.tsx`); Pane-Banner extern/archiviert (`navigation/PaneBanners.tsx`); Slots, Laden/`session.unavailable`/gelöscht |
| `PaneLayout.tsx` | eine oder mehrere Panes (Split-View später) |
| `EmptyState.tsx` | Willkommen / „keine Session gewählt“ mit dem Formular „Neue Session“ |
| `NewSessionForm.tsx` | Phase-1-Minimum: Ordnerpfad + zuletzt genutzte Projekte (aus den Summaries) → `session.create {cwd}`, Session wählen, Eingabefeld fokussieren (`focusSessionInput`); unsichere Pfade vorab abgelehnt; `recentProjects` |
| `NewSessionDialog.tsx` | dasselbe Formular als Dialog aus der Sidebar (`openNewSession`, `closeNewSession`) |
| `HostGate.tsx` | „Nicht angemeldet“, „Server beendet“, „nicht erreichbar“ (Countdown), „Verbinde…“, veraltetes Fenster mit „Neu laden“ + „Server beenden…“ (Inline-Rückfrage, `shutdownServer`, V2-04) |
| `ShellBanners.tsx` | Verbindung unterbrochen, Setup-Hinweis (`setupIssue`: Fehler des Standardprofils bzw. claude fehlt/abgemeldet/zu alt, übersetzt), Server-Warnungen, Benachrichtigungs-Berechtigung |
| `NotificationPermissionBanner.tsx` | „Benachrichtigungen aktivieren“ (nur per Klick, `enableNotifications`), „Nicht jetzt“ |
| `NotificationCenter.tsx` | Hinweis-Region unten rechts: lokale Hinweise aus `state/notices.ts` – auch die In-App-Benachrichtigungen des Servers (`src/web/notifications`) mit „Session anzeigen“ |
| `SettingsMenu.tsx` | Theme, Sprache, „Benachrichtigungen aktivieren“ (solange nicht gefragt), Tastenkürzel, „Server beenden“ |
| `ShortcutHelp.tsx` | `?`-Hilfe (`openShortcutHelp`, `closeShortcutHelp`) |
| `ConnectionIndicator.tsx` | Verbindungsstatus (Punkt + Text) |
| `shortcuts.ts` | zentrale Registry: `useShortcut` (`scope`/`scopeRef`), `useEscapeHandler((event) => boolean, enabled, { scope?, scopeRef? })`, `isInScope`, `shortcuts`, `installShortcutListener`, `parseShortcut`, `shortcutKeyLabels` – keine Strg+Alt-Kürzel, Alt+Numpad nie |
| `decision-focus.ts` | „Zur Entscheidung“ (architecture §2.3e): `focusDecision(sessionKey, decisionId)`, `useDecisionFocusHandler`, `registerDecisionFocusHandler`, `findDecisionBar` |
| `transcript-follow.ts` | eigenes Senden → Transkript ans Ende (V2-06, ADR-074): `followTranscript(sessionKey)` (Composer), `useTranscriptFollowHandler` (Transkript) |
| `requests.ts` | Anfragekanal (Phase-2-Gerüst, ADR-115, Koordinator): `requestShell(request)` → `boolean`, `useShellRequestHandler`/`registerShellRequestHandler`; Arten `newSession` (`cwd?`, `profileId?`), `renameTitle`, `conversations`, `sessionInfo`, `quickSwitcher`, `settings` (`section?`, `SETTINGS_SECTIONS`) – nur aus Nutzeraktionen |
| `navigation/` | Phase 2 (WP-35, eigene README, Namespace `navigation`): `NavigationLayer` (Handler `renameTitle`/`conversations`/`sessionInfo`/`quickSwitcher`, Strg+K, F2), Sidebar-Zeile, Kontextmenü und „…“-Menüs aus einer Aktionsliste (`session-actions.tsx`: Umbenennen, Anheften, neues Fenster, Schlafen legen, externe Konsole, Konsolenbefehl kopieren, Archivieren …), Inline-Umbenennen, Quick-Switcher, Frühere Unterhaltungen, Session-Info, Pane-Banner, Abo-Limits |
| `new-session/` | Phase 2 (WP-36, eigene README): Ordner-Browser und Profilwahl des Dialogs „Neue Session“, Handler `newSession` – bis zum Merge von WP-36 nur der Namespace `newSession` |
| `server-shutdown/` | „Server beenden“ (WP-21), Namespace `serverShutdown` |

Regeln: Kürzel nur über die Registry (keine eigenen `keydown`-Listener auf `window`);
Entscheidungs-Kürzel mit `scopeRef` der eigenen Leiste (die Leiste liegt in
`[data-shortcut-scope="decision-bar"][data-decision-bar="<sessionKey>"]`); Esc über
`useEscapeHandler` mit Scope (neuester Handler zuerst, nur mit Fokus im Scope, offene Dialoge/Menüs
haben Vorrang). `SessionPane` rendert die Slots über `memo`-Wrapper und liest nur schmale Selektoren.
Die Kopfzeile `[data-slot="session-header"]` zeigt nur Status (Modus/Modell/Context-Picker sitzen im
Composer, ADR-042); bedienbar ist dort nur der Titel (Inline-Umbenennen), das „…“-Menü liegt daneben
in `session-bar`, nicht im Header (WP-35). Die Warteschlange zeigt nur das Transkript plus das Badge
(ADR-041).
