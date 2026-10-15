# src/web/shell – App-Shell und Slots (WP-14)

Layout „Sidebar links + eine Session rechts“ (pane-fähig), Banner, Vollbild-Zustände,
Benachrichtigungen, Shortcut-Registry und die `FeatureSlots` für WP-15/16 (architecture §2.3).
**In Welle 1b read-only**; WP-20 setzt die Slots in `src/web/App.tsx`.

| Datei | Inhalt |
|---|---|
| `slots.tsx` | `FeatureSlots` (Transcript, DecisionBar, Composer, SidePanel, DecisionCard, Markdown, ToolInputPreview), `FeatureSlotsProvider`, `useFeatureSlots`, `DEFAULT_FEATURE_SLOTS` |
| `placeholders.tsx` | neutrale Platzhalter der Slots (Transkript als Klartext-Liste, nie Markdown/HTML) |
| `AppShell.tsx` | Rahmen: `HostGate` → Sidebar + Banner + `PaneLayout`, `NotificationCenter`, `ShortcutHelp` |
| `ShellEffects.tsx` | Theme, Sprache (aus `host.state.settings`), Fenstertitel „(n) Parallax“ |
| `Sidebar.tsx` | Phase-1-Liste: Status-Icon + Text, Titel, Aktivität, Ungelesen; „Wartet auf dich (n)“; Alt+1…9 |
| `SessionPane.tsx`, `SessionHeader.tsx` | eine Session: Kopfzeile, Slots, Laden/`session.unavailable`/gelöscht |
| `PaneLayout.tsx` | eine oder mehrere Panes (Split-View später) |
| `EmptyState.tsx` | Willkommen / „keine Session gewählt“, `NewSessionForm` (Ordner + Start, Phase-1-Minimum) |
| `HostGate.tsx` | „Nicht angemeldet“, „Server beendet“, „nicht erreichbar“ (Countdown), „Verbinde…“, veraltetes Fenster |
| `ShellBanners.tsx` | Verbindung unterbrochen, Setup-Hinweis (Platzhalter für den Setup-Screen), Server-Warnungen |
| `NotificationCenter.tsx` | `notify` in-app bzw. als Web Notification (falls erlaubt) |
| `SettingsMenu.tsx` | Theme, Sprache, Tastenkürzel |
| `ShortcutHelp.tsx` | `?`-Hilfe (`openShortcutHelp`) |
| `ConnectionIndicator.tsx` | Verbindungsstatus (Punkt + Text) |
| `shortcuts.ts` | zentrale Registry: `useShortcut`, `useEscapeHandler`, `shortcuts`, `installShortcutListener`, `parseShortcut`, `shortcutKeyLabels` – keine Strg+Alt-Kürzel |

Regeln: Kürzel nur über die Registry (keine eigenen `keydown`-Listener auf `window`);
Entscheidungs-Kürzel mit `scope: 'decision-bar'` (die Leiste liegt in
`[data-shortcut-scope="decision-bar"]`); Esc über `useEscapeHandler` (neuester Handler zuerst,
offene Dialoge/Menüs haben Vorrang).
