# FIX-R4-F2 – Shell/Navigation (Fix-Runde nach R4/V3)

> Paket F2 aus `docs/wp/FIX-R4.md` §2, Worktree `.worktrees/fix-f2`, Branch `fix/r4-f2`, Basis `main` =
> `29f3256`. Befunde: `docs/wp/R4-web.md`, `docs/wp/V3.md`; Regeln ADR-121 … ADR-126,
> architecture §2.3 (h)/(i). Kein Live-`claude`, keine Contract-Änderung.

## 1. Befunde

### SOLLTE

| Befund | Ergebnis | Fix | Test (Gegenprobe ohne Fix rot) |
|---|---|---|---|
| **R4W-02** Datei-Drop neben dem Composer navigiert das Fenster | behoben | `shell/drop-guard.ts` (`installDropGuard`): fensterweite `dragover`/`drop`-Listener (Bubble-Phase, nach den Drop-Zonen); Dateien – und Links außerhalb von Textfeldern – ohne `preventDefault` einer Drop-Zone werden abgewiesen (`preventDefault`, `dropEffect = 'none'`); `ShellEffects` installiert ihn | `shell/drop-guard.test.tsx` (4): Drop auf Transkript abgewiesen, Drop-Zone unberührt (`dropEffect` bleibt `copy`), Links/Text, `ShellEffects` an/ab – rot ohne Fix |
| **R4W-04 / V3-04** Fokus nach Dialogen auf `<body>` | behoben (WP-35-Anteile + ShortcutHelp) | neuer Helfer `useReturnFocus` (`lib/return-focus.ts`, API unten); Quick-Switcher, Frühere Unterhaltungen, Session-Info, Kürzelhilfe (`?`, Nachtrag Koordinator) geben den Fokus zurück, Rückfall über `sessionFocusTarget` (`navigation/focus.ts`: „…“ der Kopfzeile bzw. Sidebar-Zeile, auch von `finishRename` genutzt); Enter im Quick-Switcher fokussiert das Eingabefeld der gewählten Session (`focusSessionInput` aus `NewSessionForm.tsx`); Session-Menüs (`sessionMenuCloseAutoFocus(sessionKey, place)`): endet der Fokus nach dem Schließen auf `<body>` (der „…“-Knopf der Zeile existiert nur bei Hover/Fokus, die angeheftete Zeile wandert), geht er an die Zeile bzw. das „…“ der Kopfzeile | `lib/return-focus.test.tsx` (5, inkl. StrictMode und Gegenprobe-Fall „ohne Hook → body“), `navigation/focus.test.tsx` (Zeile → Strg+K → Esc → Zeile; Enter → Eingabefeld; `/status`/`/resume` aus dem Composer → zurück; Kopfzeilen-Menü → „…“; „…“-Menü per Tastatur → Anheften → Fokus bleibt in der Zeile; Menü schließt mit Fokus auf `<body>` → Zeile bzw. „…“ der Kopfzeile, ein Dialog behält ihn), `ShortcutHelp.test.tsx` (Feld → Kürzelhilfe → Esc → Feld; Nachtrag des Koordinators) – rot ohne Fix |
| **R4W-05** Hinweise hinter Modals, Conversations-Fehler hinter dem Overlay, Hinweis ohne Aktion | behoben | `ConversationsDialog`: Ablehnung als `Alert role="alert"` im Dialog (ADR-126); `NotificationCenter`: `z-[60]` über dem Overlay, `aria-live="off"` (Radix' `hideOthers` lässt `[aria-live]` aus – die Karten bleiben die Live-Regionen), `pointerdown` bleibt in der Region (Klick auf einen Hinweis schließt den Dialog nicht); `ClientNotice.action?: { label, run }` (`state/store.ts`, `NoticeOptions.action`), Knopf in der Karte; `notifications/delivery.ts`: Hinweis „Töne aktivieren“ mit Knopf (`SoundPlayer.unlock`, optional) | `pane.test.tsx` (SESSION_BUSY als `alert` im Dialog, nicht in der Region; nächster Versuch klappt), `focus.test.tsx` (Region ohne `aria-hidden`-Vorfahr bei offenem Dialog, „Schließen“ des Hinweises lässt den Dialog offen), `notices.test.tsx` (+2: Aktion, Region-Attribute), `delivery.test.ts` (+1: Knopf entsperrt, Hinweis weg) – rot ohne Fix |
| **R4W-06 / V3-07** Abo-Limits nach dem Reset | behoben | `limitBars(info, now)` blendet Fenster mit `resetsAt <= now` aus (auch den Rückfall auf das Ereignisfenster); `limitDeadlines` + `useNowUntil` statt `useNow(60 s)`: neu gerendert genau zum Reset (und einen Tag davor, Wechsel Datum → Uhrzeit); de „Reset um {time}“ / „Reset am {date}“ | `navigation-helpers.test.ts` (+2), `navigation/limits.test.tsx` (2, Fake-Timer: Balken verschwindet genau zum Reset ohne neues Ereignis; gestriger Wert nach Neustart unsichtbar) – rot ohne Fix |
| **V3-03** Quick-Switcher-Rangfolge | behoben | `fuzzyFilter(…, options)`: `strict` (Lücken müssen durch Wortanfänge/Folgen bezahlt sein, sonst kein Treffer), `keyPenalty` (frühere Schlüssel gewinnen knappe Gleichstände); Quick-Switcher: mit Suchbegriff nach Treffergüte, wartend nur bei Gleichstand (Basisreihenfolge), Titel vor Pfad/Branch/Profil | `fuzzy.test.ts` (+9: „fake“ in `…-fuer-den-lauf-der-kopfzeile` nur lose, „langer“, „lang“ mit/ohne Penalty), `focus.test.tsx` („landing“ → „Landing page copy“ vor der wartenden Session im Ordner `landing`) – rot ohne Fix |
| **V3-05** Kopfzeile: CLI-Version und Gauge überlappen | behoben | CLI-Version `shrink-0` statt `min-w-0` (ausgeblendet unter `xl` wie bisher); Titel `shrink-[8] min-w-24` (gibt zuerst nach); nur Pfad und Modell schrumpfen (mit Ellipse) | `SessionHeader.test.tsx` (Invariante: jedes Faktum schrumpft nur mit `truncate`, sonst `shrink-0`) – rot ohne Fix; Layout selbst: Live-/Sichtprüfpunkt |

### NIT

| Befund | Ergebnis | Fix / Grund | Test |
|---|---|---|---|
| R4W-08 (Web) Hinweistext Konsolenbefehl | behoben | `navigation.console.copied` sagt (ADR-123), dass geheime Werte nicht im Befehl stehen und die Konsole sie abfragt | bestehender Test (`/two writers/`) |
| R4W-11 Kürzel hinter modalen Dialogen | behoben | `ShortcutRegistry.handleKeyDown`: solange ein Dialog/Alert-Dialog/Menü offen ist (`[role=…][data-state=open]`), feuern nur Kürzel mit `scope`/`scopeRef`, deren Bereich den Fokus hat | `shortcuts.test.ts` (+1), `focus.test.tsx` (Alt+1/Strg+K bei offener Session-Info wirkungslos, danach wieder aktiv) |
| R4W-12 Pfeiltasten im Zeilenmenü bewegen die Liste | behoben | `onListKeyDown` ignoriert `defaultPrevented` und Ziele außerhalb der Liste im DOM (Portale) | `focus.test.tsx` (kein `focusin` auf einer Zeile bei ↓ im „…“-Menü) |
| R4W-13 Roving-Tabindex in Archiv/Gruppen | behoben | „Wiederherstellen“ je Archivzeile und „+“ je Gruppe `tabIndex={-1}` (per Maus wie bisher; Tastatur über „…“/Kontextmenü der Zeile) | `focus.test.tsx` |
| R4W-14 Session-Info mit rohen Enum-Werten | behoben | bekannte `apiKeySource`-Werte (SDK `ApiKeySource`) und MCP-Status übersetzt (`navigation.info.apiKeySources.*`, `…mcpStatus.*`), Unbekanntes roh | `pane.test.tsx` (en/de) |
| R4W-15 `updateSettings` nur `language`/`theme` optimistisch | behoben | jedes definierte Top-Level-Feld des Patches optimistisch (wie der Server: ganz ersetzt), Rücknahme bei Fehler | neu `state/settings.test.ts` (3; Fehlerfall rot ohne Fix) |
| R4W-20 unbenutzte Schlüssel (`navigation`), Galerie | behoben | `navigation.sidebar.{viewMode,groupSessions}`, `navigation.row.{archived,external}` entfernt; `playground/demos.tsx` nutzt keine `shell.newSession.*`/`shell.session.details` mehr (→ `newSession.*`, `shell.session.context`, `navigation.actions.sessionInfo`); Wächter `navigation/i18n/i18n.test.ts`: jeder `navigation`-Schlüssel kommt im Produktionscode vor (Literal oder Template-Präfix), en/de gleich, keine Literal-Attribute | `i18n.test.ts` (3) |
| R4W-21 Profil-Map doppelt | behoben | `useProfilesByHost()` in `state/hooks.ts` (`get(hostId, profileId)`, `size`), genutzt von Sidebar und Quick-Switcher; `profile-colors` bleibt (FIX-R4) | über die Navigationstests |
| R4W-23 `getRename` tot | behoben | entfernt | – |
| V3-12 Kontextmenü ohne Namen, Badge „Fake“ 4,41:1 | behoben | Zeilen-Kontextmenü `aria-label` „Aktionen für „…““, Gruppen-Kontextmenü „Projekt …“; Badge „Fake“ ohne getönte Fläche (`bg-transparent`: Warnfarbe hell auf `--sidebar` ≈ 5,0:1 statt 4,41:1, gerechnet) | `focus.test.tsx` (Menüname); Kontrast: Live-/Sichtprüfpunkt |
| V3-13 Texte `navigation` | behoben (Anteil WP-35) | de `navigation.row.context` „Kontext“ (wie Composer/Kopfzeile), `navigation.info.cwd` „Arbeitsverzeichnis“ (wie Kopfzeile), Session-Info-Rohwerte → R4W-14 | `pane.test.tsx` (de) |
| V3-14 „Archiv (0)“, angeheftete Gruppe | behoben | nach dem Wiederherstellen der letzten archivierten Session zurück zur Liste (Fokus auf die Tab-Stopp-Zeile, falls er verloren ging); gruppiert: Gruppen mit angehefteter Session zuerst (wie flach), dann Aufmerksamkeit, dann Aktivität | `focus.test.tsx`, `session-order.test.ts` |

### Zurückgestellt

- **V3-13 Shutdown-Text** „1 more idle session will be closed“ ohne vorherige Liste: Namensraum
  `serverShutdown` (`shell/server-shutdown/**`, laut `CLAUDE.md` Koordinator/„unverändert“, in FIX-R4
  nicht F2 zugeordnet). Vorschlag: eigener Text ohne „more/weitere“, wenn weder „Arbeitet“ noch
  „Wartet“ gelistet sind.
- **V3-14 Sidebar bei 700 px** (kein Einklappen): Gestaltungsentscheidung, kein Fehler; eigenes
  Paket nötig (Einklapp-Zustand, Kürzel, Sichtprüfung).
- **R4W-19 (optional WP-35)** `lazy()` für Quick-Switcher/Dialoge: nicht F2 zugeordnet (F5), Nutzen
  klein (die Dialoge sind klein; die großen Brocken sind Einstellungen/Profile).
- **V3-04 Fokus nach Anheften – Ursache**: React stellt den Fokus eines verschobenen Knotens selbst
  wieder her (`restoreSelection`, im Test geprüft); der beobachtete Verlust kommt sehr wahrscheinlich
  vom verschwundenen „…“-Trigger. Behoben über `sessionMenuCloseAutoFocus` (oben); der genaue Weg im
  Kontextmenü (Umschalt+F10) bleibt Live-Prüfpunkt.

## 2. Entscheidungen

1. **Fokus-Rückgabe als Hook statt Komponente:** `useReturnFocus(open, fallback?)` liefert nur den
   `onCloseAutoFocus`-Handler; Dialoge behalten ihr Markup. Gemerkt wird beim Übergang
   geschlossen → offen in einem Layout-Effekt (vor dem Fokus-Effekt von Radix; StrictMode-fest).
2. **Hinweis-Region über Modals ohne Änderung an `ui/dialog`:** `aria-live` an der Region (Radix'
   `hideOthers` lässt sie aus), `z-[60]`, `pointerdown` bleibt in der Region – kein Eingriff in den
   Koordinator-Pfad `ui/dialog.tsx`, kein neuer Kanal.
3. **Abgelaufene Limit-Fenster ausblenden statt „0 %“:** Nach dem Reset ist die Auslastung unbekannt
   (andere Geräte/Sessions); das nächste `rate_limit_event` zeigt den echten Wert. Gruppierte Sidebar:
   angeheftet vor Aufmerksamkeit (wie die flache Liste).

## 3. API für F3/F4 (in dieser Runde noch nicht nutzen)

```ts
// src/web/lib/return-focus.ts
useReturnFocus(open: boolean, fallback?: () => HTMLElement | null): (event: Event) => void
// <DialogContent onCloseAutoFocus={useReturnFocus(open, () => …)}> – Komponenten, die nur offen
// gemountet sind, übergeben `true`. Weitere Exporte: focusedElement(), focusElement(el).
```

Kandidaten nach dem Merge: `NewSessionDialog` (V3-04), `composer/HelpDialog` (V3-04), `SettingsPage`
(eigenes Muster `SettingsPage.tsx:94-109`). `fuzzyFilter(…, { strict, keyPenalty })` steht dem
Slash-Menü (V3-02, F4) offen; ohne Optionen ist das Verhalten unverändert.

## 4. Checks

- `pnpm exec tsc -b` grün; `pnpm exec eslint src/web/shell src/web/state src/web/lib src/web/playground
  src/web/notifications src/web/ui/{context-menu,command-list}.tsx --max-warnings=0` grün; Prettier
  auf allen geänderten Dateien.
- Eigene Pfade: `pnpm exec vitest run src/web/{shell,state,lib,playground,notifications}` +
  `ui/{context-menu,command-list}.test.tsx` grün (44 Dateien). Neue Tests: `lib/return-focus.test.tsx`
  (5), `shell/drop-guard.test.tsx` (4), `shell/SessionHeader.test.tsx` (1), `shell/navigation/focus.test.tsx`
  (12), `shell/navigation/limits.test.tsx` (2), `shell/navigation/i18n/i18n.test.ts` (3),
  `state/settings.test.ts` (3); ergänzt: `fuzzy.test.ts` (+9), `navigation-helpers.test.ts` (+2),
  `session-order.test.ts` (geändert: angeheftete Gruppe zuerst), `notices.test.tsx` (+2),
  `delivery.test.ts` (+1), `shortcuts.test.ts` (+1), `ShortcutHelp.test.tsx` (+1), `pane.test.tsx`
  (2 angepasst: Inline-Fehler, übersetzte Session-Info).
- Gegenprobe: die Fixes von Sidebar, Kürzeln, NotificationCenter, Quick-Switcher, Dialogen,
  AccountLimits, Kopfzeile, ShellEffects und `state/settings.ts` per `git stash` zurückgenommen → 19
  der neuen/angepassten Tests rot (u. a. alle Fokus-, Ranking-, Region-, Limit-, Kürzel- und
  Drop-Tests), danach wieder grün. Nicht im happy-dom nachstellbar: Fokusverlust durch das
  Verschieben eines Knotens (React stellt ihn per `restoreSelection` selbst wieder her) – siehe
  „Zurückgestellt“ und Live-Prüfpunkte.
- Vollständig: `pnpm check` grün (tsc, ESLint 0 Warnungen, Vitest **207 Dateien, 3592 Tests**, 511 s);
  `pnpm build` grün, `index` 426,8 kB (vorher 422,3 kB).
- Sichtprüfung ohne Browser: Vite auf Port 5185 (`PARALLAX_DEV_WEB_PORT`), 19 geänderte Module per
  HTTP 200 transformiert (u. a. `aria-live`/`z-[60]` im NotificationCenter, de „Reset um“), Vite
  per eigener PID (`taskkill /T /F`) beendet, Port wieder frei.

## 5. Live-/Sichtprüfpunkte für WP-41

- R4W-02: Screenshot aus dem Explorer auf Transkript/Sidebar/Kopfzeile ziehen → Cursor „nicht
  erlaubt“, kein Wegnavigieren; auf den Composer → Chip wie bisher; Link aus dem Browser auf die
  Sidebar → nichts, in den Composer → Text.
- R4W-04/V3-04: Strg+K aus dem Composer → Esc → Cursor im Composer; Enter → Cursor im Composer der
  neuen Session; Session-Info/Frühere Unterhaltungen aus dem „…“ → Esc → Fokus auf „…“; Anheften
  per Umschalt+F10 und per „…“ → Fokus auf der Zeile.
- R4W-05: Hinweis bei offenem Dialog sichtbar und von NVDA angesagt; „Töne aktivieren“-Knopf in
  einem nicht vom Launcher geöffneten Fenster.
- R4W-06: Limit-Anzeige nach dem Reset (z. B. `fake:ratelimit` mit 60 s) verschwindet ohne neues
  Ereignis.
- V3-05: Kopfzeile mit 98-Zeichen-Titel bei 1280×800 – keine Überlappung; V3-12: Badge „Fake“ hell.
- R4W-11: Einstellungen offen → Alt+2/Strg+K ohne Wirkung.

## 6. Wünsche an den Koordinator

- `src/web/shell/README.md` (mehrere Owner): Zeilen für `drop-guard.ts` (R4W-02, in `ShellEffects`)
  und `NotificationCenter` (über Modals, `ClientNotice.action`), `ShortcutHelp` (Fokus zurück).
- architecture §2.3 (i): „ein Hinweis kann eine Aktion tragen“ ist umgesetzt (`NoticeOptions.action`);
  Satz zur Technik (`aria-live`-Region, `z-[60]`) optional.
- `focusSessionInput` (heute `shell/NewSessionForm.tsx`, F3) nach `src/web/lib` verschieben (ADR-126
  „reine Helfer nach lib“); der Quick-Switcher importiert ihn aus `../NewSessionForm`.
- Kern-Schlüssel `shell.newSession.{title,cwdLabel,cwdPlaceholder,submit}` und
  `shell.session.details` sind jetzt auch in der Galerie unbenutzt → entfernen (`src/web/i18n/**`).
- V3-13 Shutdown-Text (siehe „Zurückgestellt“).
- Optional ein gemeinsamer i18n-Wächter für alle Namensräume nach dem Muster von
  `shell/navigation/i18n/i18n.test.ts`.

## 7. Stolperstein

- Ein PowerShell-`[System.IO.File]::WriteAllText` mit relativem Pfad schrieb einmal in den
  Haupt-Checkout (Prozess-Arbeitsverzeichnis ≠ `cd`); sofort bemerkt, per `git checkout --` auf den
  sauberen Stand zurückgesetzt (`git status` des Haupt-Checkouts danach leer). Danach nur noch
  Read/Edit/Write.
