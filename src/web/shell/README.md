# src/web/shell – App-Shell und Slots (WP-14, verdrahtet in WP-20b)

Layout „Sidebar links + eine Session rechts“ (pane-fähig), Banner, Vollbild-Zustände,
Hinweis-Region, Shortcut-Registry und die `FeatureSlots` für WP-15/16 (architecture §2.3).
`src/web/App.tsx` setzt die Slots mit den echten Komponenten (`APP_SLOTS`, WP-20b).

| Datei | Inhalt |
|---|---|
| `slots.tsx` | `FeatureSlots` (Transcript, DecisionBar, Composer, SidePanel, DecisionCard, Markdown, ToolInputPreview), `FeatureSlotsProvider`, `useFeatureSlots`, `DEFAULT_FEATURE_SLOTS` |
| `placeholders.tsx` | neutrale Platzhalter der Slots (Transkript als Klartext-Liste, nie Markdown/HTML) |
| `AppShell.tsx` | Rahmen: `HostGate` → Sidebar + Banner + `PaneLayout`, `NotificationCenter`, `NewSessionDialog`, `ShortcutHelp` |
| `ShellEffects.tsx` | Theme, Sprache (aus `host.state.settings`), Fenstertitel „(n) Parallax“ |
| `Sidebar.tsx` | Phase-1-Liste: Status-Icon + Text, Titel, Aktivität, Ungelesen; „Wartet auf dich (n)“; Alt+1…9; Knopf „Neue Session“ (`data-action="new-session"`) |
| `SessionPane.tsx`, `SessionHeader.tsx` | eine Session: Kopfzeile (nur Status, ADR-042: Status-Icon + Text, Titel, Badges „n eingereiht“/Kompakt/Retry/Hintergrund/abgelaufen, Ordner, Modell, tatsächlicher Modus, Context-Füllstand mit Tokens im Tooltip; `data-slot="session-header"`, `data-status`), Slots, Laden/`session.unavailable`/gelöscht |
| `PaneLayout.tsx` | eine oder mehrere Panes (Split-View später) |
| `EmptyState.tsx` | Willkommen / „keine Session gewählt“ mit dem Formular „Neue Session“ |
| `NewSessionForm.tsx` | Phase-1-Minimum: Ordnerpfad + zuletzt genutzte Projekte (aus den Summaries) → `session.create {cwd}`, Session wählen, Eingabefeld fokussieren (`focusSessionInput`); unsichere Pfade vorab abgelehnt; `recentProjects` |
| `NewSessionDialog.tsx` | dasselbe Formular als Dialog aus der Sidebar (`openNewSession`, `closeNewSession`) |
| `HostGate.tsx` | „Nicht angemeldet“, „Server beendet“, „nicht erreichbar“ (Countdown), „Verbinde…“, veraltetes Fenster |
| `ShellBanners.tsx` | Verbindung unterbrochen, Setup-Hinweis (`setupIssue`: Fehler des Standardprofils bzw. claude fehlt/abgemeldet/zu alt, übersetzt), Server-Warnungen, Benachrichtigungs-Berechtigung |
| `NotificationPermissionBanner.tsx` | „Benachrichtigungen aktivieren“ (nur per Klick, `enableNotifications`), „Nicht jetzt“ |
| `NotificationCenter.tsx` | Hinweis-Region unten rechts: lokale Hinweise aus `state/notices.ts` – auch die In-App-Benachrichtigungen des Servers (`src/web/notifications`) mit „Session anzeigen“ |
| `SettingsMenu.tsx` | Theme, Sprache, „Benachrichtigungen aktivieren“ (solange nicht gefragt), Tastenkürzel, „Server beenden“ |
| `ShortcutHelp.tsx` | `?`-Hilfe (`openShortcutHelp`, `closeShortcutHelp`) |
| `ConnectionIndicator.tsx` | Verbindungsstatus (Punkt + Text) |
| `shortcuts.ts` | zentrale Registry: `useShortcut` (`scope`/`scopeRef`), `useEscapeHandler((event) => boolean, enabled, { scope?, scopeRef? })`, `isInScope`, `shortcuts`, `installShortcutListener`, `parseShortcut`, `shortcutKeyLabels` – keine Strg+Alt-Kürzel, Alt+Numpad nie |
| `decision-focus.ts` | „Zur Entscheidung“ (architecture §2.3e): `focusDecision(sessionKey, decisionId)`, `useDecisionFocusHandler`, `registerDecisionFocusHandler`, `findDecisionBar` |
| `server-shutdown/` | „Server beenden“ (WP-21), Namespace `serverShutdown` |

Regeln: Kürzel nur über die Registry (keine eigenen `keydown`-Listener auf `window`);
Entscheidungs-Kürzel mit `scopeRef` der eigenen Leiste (die Leiste liegt in
`[data-shortcut-scope="decision-bar"][data-decision-bar="<sessionKey>"]`); Esc über
`useEscapeHandler` mit Scope (neuester Handler zuerst, nur mit Fokus im Scope, offene Dialoge/Menüs
haben Vorrang). `SessionPane` rendert die Slots über `memo`-Wrapper und liest nur schmale Selektoren.
Die Kopfzeile ist nicht bedienbar (Modus/Modell/Context-Picker sitzen im Composer, ADR-042); die
Warteschlange zeigt nur das Transkript plus das Badge (ADR-041).
