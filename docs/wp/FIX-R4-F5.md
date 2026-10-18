# FIX-R4-F5 – App/E2E (Ergebnis)

> Fix-Runde nach R4/V3, Paket **F5** laut `docs/wp/FIX-R4.md` §2 (Welle Fb, nach dem Merge von K und
> F1 … F4). Worktree `.worktrees/fix-f5`, Branch `fix/r4-f5`, Basis `main` = `a617e0a`. Besitz-Pfade:
> `e2e/**`, `playwright.config.ts`, `src/web/{App,main}.tsx`, `src/web/App.test.tsx`, dieses Dokument.
> Kein Live-`claude` (FakeBackend), kein HKCU, nie `%LOCALAPPDATA%\Parallax`. Logs der Läufe in
> `%TEMP%\claude\parallax-fix-f5\`.

## 1. Befunde

### Behoben

| Befund | Umsetzung | Test (Gegenprobe) |
|---|---|---|
| **R4W-10** fester 700-ms-Wait in `setPresence` | Das Init-Script `recordNotifications` (`e2e/support/presence.ts`) ersetzt `WebSocket` durch eine Unterklasse, die sich die Präsenz des zuletzt **gesendeten** `clientHello`/`presence`-Frames merkt (`window.__e2ePresence`). `setPresence` wartet per `expect.poll`, bis genau diese Präsenz gesendet ist; der Server liest die Frames eines Sockets in Reihenfolge – jeder spätere Befehl der Seite läuft mit der neuen Präsenz. Keine feste Wartezeit; die sechs Aufrufer bleiben unverändert | `notifications.spec.ts` (2), `phase2-sessions.spec.ts` (Statuskette), `phase2-settings.spec.ts` (3× `setPresence`) grün; ohne gesendeten Frame läuft `setPresence` in den Poll-Timeout (Meldung „presence … sent“) |
| **R4W-19** Einstellungsseite und Profil-Editor im Start-Chunk | `App.tsx`: `SettingsPage` und `ProfilesSettings` als `lazy()` hinter `memo`-Wrappern mit eigenem `Suspense` (Muster `features/transcript/slots.tsx`); `App.tsx` importiert die beiden Features nicht mehr statisch. Fallback der Seite `null` (modaler Dialog fester Größe – er erscheint ganz, kein halber Dialog, kein Overlay-Flackern; der Öffner behält bis dahin den Fokus, die Seite gibt ihn beim Schließen dorthin zurück); Fallback des Bereichs „Profile“ ein Skelett (`role="status"`, `aria-busy`, „Loading…“) im selben Raster wie `ProfilesSettings` im Panel fester Höhe – nichts darum herum springt. Der Profil-Chunk wird beim Laden der Seite mitgeholt (der Bereich ist einen Klick entfernt, zeigt das Skelett also selten). Die Identitätsprüfung gegen den Platzhalter (`SettingsMenu.tsx`, `SettingsPage.tsx`) bleibt gültig | `App.test.tsx`: Slots sind Lazy-Wrapper (weder Komponente noch Platzhalter), `PREFERENCES_SLOTS` hat genau `SettingsPage` (Wächter für neue Slots); Lazy-Seite zeigt den angefragten Bereich, Esc → `onClose`; echter Profil-Editor hinter dem Lazy-Slot meldet den Entwurf an die Lazy-Seite (Punkt am Reiter, Bereichswechsel, Esc fragt, „Verwerfen und schließen“, kein `profile.save`). Gegenprobe: Wrapper ohne Prop-Weitergabe → dieser Test rot. Build §3 |
| **R4W-27** E2E-Kleinigkeiten | (1) „Nicht stören“: Positivkontrolle – der In-App-Hinweis spielt den Chime, „Fertig“ den Pop (`expect.poll`); der feste 1-s-Wait entfällt: das Fenster entscheidet Toast und Ton im selben Schritt, der den Hinweis zeigt (`notifications/delivery.ts` `deliver`), ist der Hinweis da, bleibt ein fehlender Toast/Ton aus. (2) Einstellungen gelten erst als gespeichert, wenn der Server sie hat: `serverSettings(server)` (`support/server.ts`, `host.state` eines frischen Node-Clients) nach jedem Schalter/Feld/Radio (Toast „Berechtigung“, „Nicht stören“, Leerlauf-Schlaf an/45 min, 4 abgelehnt → 45 bleibt, Design, Sprache). (3) Status-Rekorder mit `attributeOldValue` (Wert nach Record i = `oldValue` von Record i + 1). (4) Selektoren ohne englische Texte: Schalter über `[data-event] td` bzw. `[data-setting] [role=switch]`, Radios über `value`, Sidebar `nav[data-view]`, Zahnrad `[data-action="settings"]`, Ordnerliste über `data-path`, Archiv-Zähler `/\(1\)$/`; „zbr“ prüft die erste Option statt einer genauen Anzahl (Pfad-Treffer über das Zufallssuffix möglich, Titel rangiert zuerst, V3-03). (5) `declare global { interface Window }` in `support/dom.ts` statt 7× `as unknown as` (+1 in `fixtures.ts`). (6) R9: `tok-e2e-secret` steht in keiner Zeile des Server-Logs | die betroffenen Fälle grün (§3) |
| **R4W-28** Handler-Test nicht vollständig erzwungen | `EVERY_REQUEST: { [K in ShellRequestKind]: ShellRequestOf<K> }`, der Test iteriert darüber; `renameTitle` prüft zusätzlich das fokussierte Titelfeld und Esc | Gegenprobe: Eintrag `renameTitle` entfernt → `tsc` TS2741 |
| E2E-Anpassung **R4W-03** (F4 §4) | `phase2-composer.spec.ts`: kein Klick auf die Read-Zeile; genau ein `image-thumb`, Zeile zugeklappt (`aria-expanded="false"`), Name „Enlarge image fake-shot.png“, Lightbox „Image: fake-shot.png“, `lightbox-save` mit `download="fake-shot.png"` | grün |
| E2E-Anpassung **V3-14** (F2) | Basislauf auf `a617e0a`: `phase2-navigation.spec.ts:138` rot – nach dem Wiederherstellen der letzten archivierten Session kehrt die Sidebar jetzt selbst zur Liste zurück, der Knopf „Back to the sessions“ ist weg. Der Fall prüft das neue Verhalten (`data-view="flat"`, Umschalter verschwindet, Zeile sichtbar) | grün |

### Neue E2E-Fälle

| Befund | Datei / Fall | Inhalt |
|---|---|---|
| **R4W-01** | `phase2-settings.spec.ts` „profile draft …“ | neues Profil, Env-Zeile `DRAFT_TOKEN` = Geheimwert → Punkt `data-unsaved` am Reiter → „Allgemein“ → zurück: Entwurf da, Wert maskiert; Esc im Feld → `settings-close-confirm`, Fokus auf „Weiter bearbeiten“, Enter → Fokus zurück im Feld; Esc → „Verwerfen und schließen“ → Seite zu, Fokus auf dem Zahnrad; neu geöffnet: gleiche Profilzahl, kein Entwurf |
| **R4W-02** | `phase2-composer.spec.ts` „a file dropped next to the composer …“ | `dragenter`/`dragover`/`drop` mit einer PNG-Datei auf Transkript, Sidebar und Kopfzeile → abgebrochen (Drop-Schutz), URL und Verbindung unverändert, kein Chip; auf dem Composer → Chip „fertig“. `dropEffect` ist mit synthetischen Events nicht beobachtbar (Chromium ignoriert das Setzen an einem per Konstruktor erzeugten `DataTransfer`) – das prüft `shell/drop-guard.test.tsx`, der echte Drag aus dem Explorer ist Live-Punkt |
| **R4W-04 / V3-04** | `phase2-navigation.spec.ts` „focus comes back after Esc …“ (eigener Server) | Strg+K aus dem Eingabefeld → Esc → Eingabefeld; fokussierte Zeile → Strg+K → Esc → Zeile; `/status` und `/help` → Esc → Eingabefeld; Session-Info aus „…“ → Esc → „…“; „Neue Session“ → Esc → Knopf; Strg+K → Enter auf eine andere Session → deren Eingabefeld. Zusätzlich im Kürzel-Fall: Strg+K „zbr“ + Enter → Eingabefeld von „zebra“ |
| **V3-02** | `phase2-composer.spec.ts` Slash-Fall | `/vim` getippt → Menü zu, Enter **ohne Esc** → Terminal-Hinweis mit „/vim“, Feld bleibt `/vim`, nichts gesendet (ersetzt den bisherigen Schritt mit Esc) |
| V3-11 (F1, optional) | `phase2-sessions.spec.ts` „git branch of a fresh repository …“ | `git init --initial-branch=e2e-fresh` (git über `resolveExecutable`, ohne geerbte `GIT_*`), Session, ein Turn → `row-branch` „e2e-fresh“ (Rückfall `branch --show-current`); ohne git auf dem PATH übersprungen |

E2E gesamt: **45** Fälle (41 + 4 neue Tests; V3-02 steckt im bestehenden Slash-Fall), `e2e/live`
nicht mitgezählt.

### Instabiler Test (gefunden und behoben)

**F5-FLAKE-1:** Im ersten Lauf parallel zu `pnpm test` scheiterte der unveränderte Fall
`notifications.spec.ts:75` („in-app hint …“) mit `launcher code failed: failed`. Ursache: die E2E-Hilfen
`loginUrl()`/`deviceCookie()` (`support/server.ts`) riefen `requestLauncherCode` mit dem
Launcher-Standard `HEALTH_TIMEOUT_MS` = 2 s auf – ein Budget für einen Ping auf einer ruhigen Maschine;
unter Volllast kam die Antwort später, der Grund wurde verworfen (Server-Log ohne Fehler). Behoben ohne
Wiederholen und ohne verschärfte Grenzen: die Tests holen den Code mit dem Budget jeder anderen
Server-Antwort (30 s wie `nodeCommand`), die Fehlermeldung nennt den Grund aus `requestLauncherCode`
(Fehlercode bzw. `HTTP <status>`).
Betrifft jeden Test (jedes `app.open()`); durch `serverSettings` (R4W-27) gibt es mehr solche Anfragen.
Danach beide Abnahmeläufe grün (§3).

### Zurückgestellt

| Befund | Grund |
|---|---|
| R4W-19 Ziel „`index` < 360 kB“ | erreicht 378,0 kB (−57,8 kB; Start gesamt −94,9 kB). Der Rest sind vor allem die Wörterbücher aller Namensräume in en **und** de (Quelltext ≈ 54 kB de + 56 kB en, R2W-21, Koordinator `src/web/i18n/**`) und der Ordner-Browser (bleibt im Start-Chunk, „Neue Session“ braucht ihn). Optional WP-35-Dialoge (F2: Nutzen klein) |
| R4W-27 übrige Texte | Texte, die selbst geprüft werden, bleiben (Hinweistexte „– needs permission“, „Only available …“, „Current port …“, deutsche Überschrift nach dem Sprachwechsel); `getByLabel('Name')` im Profil-Fall (kein Test-Attribut am Feld, fremder Pfad) |
| feste Wartezeiten in Phase-1-Dateien | `session.spec.ts:67`, `transcript.spec.ts` (6×): Beobachtungsfenster „nichts ändert sich“ während eines Streams bzw. nach einer Taste, keine Synchronisation; nicht Teil von R4W-10/-27 |

## 2. Entscheidungen

1. **Präsenz über den gesendeten Frame:** gewartet wird auf das, was der Server tatsächlich bekommt
   (letzter `clientHello`/`presence`-Frame des Fensters), nicht auf den Zustand im Store; die
   `WebSocket`-Unterklasse folgt dem Muster der `Notification`-/`AudioContext`-Hüllen.
2. **Lazy-Slots in `App.tsx`, nicht in den Feature-`index.ts`:** so steht der Schnitt an einer
   Stelle (Besitz F5); `PREFERENCES_SLOTS` wird nicht mehr gespreizt, ein Wächter im App-Test
   verlangt, dass ein neuer Slot dort bewusst verdrahtet wird. Kein Fallback für die Seite (Dialog
   fester Größe), Skelett für den Bereich „Profile“, dessen Chunk mit der Seite geholt wird.
3. **„Gespeichert“ = vom Server bestätigt:** ein kurzlebiger Node-Client liest `host.state` (er war
   nie fokussiert und ist deshalb nie Ziel einer Benachrichtigung).

## 3. Checks

| Schritt | Ergebnis |
|---|---|
| `pnpm e2e` Basislauf auf `a617e0a` (vor F5) | 40/41 – rot nur `phase2-navigation.spec.ts:138` (V3-14, §1), 7,6 min |
| `pnpm exec tsc -b`, `eslint e2e src/web/App*.tsx src/web/main.tsx playwright.config.ts --max-warnings=0`, Prettier | grün (je Etappe) |
| `pnpm exec vitest run src/web/App.test.tsx` | 34 Tests grün |
| Gegenproben `App.test.tsx` | R4W-28: Eintrag `renameTitle` entfernt → `tsc` TS2741; R4W-19: Lazy-Wrapper ohne Prop-Weitergabe → der R4W-01-Fall rot (`data-unsaved` null). Danach wiederhergestellt |
| Gegenprobe E2E-Drop-Fall | **nicht ausgeführt:** die dafür nötige vorübergehende Abschaltung des Drop-Schutzes in `shell/ShellEffects.tsx` (fremder Pfad) hat das Berechtigungssystem abgelehnt; die Gegenprobe auf Unit-Ebene hat F2 (`drop-guard.test.tsx`) |
| `pnpm check` (vor den Commits) | grün: typecheck, ESLint, Vitest **212 Dateien / 3700 Tests** (Vitest 244 s, gesamt 797 s) |
| `pnpm build` | grün, keine Chunk-Warnung (Tabelle unten) |
| `pnpm e2e` Lauf 1 ohne Last (`fe6ad3a`) | 45/45 in 7,0 min |
| `pnpm e2e` parallel zu `pnpm test` (`fe6ad3a`) | **44/45** – F5-FLAKE-1 (§1), behoben in `57b4487`; `pnpm test` daneben 212/3700 grün (399 s) |
| **Abnahme** `pnpm e2e` parallel zu `pnpm test` (Endstand) | **45/45 in 10,1 min** (610 s); `pnpm test` daneben **212 Dateien / 3700 Tests** grün (423 s) |
| **Abnahme** `pnpm e2e` ohne Last (Endstand) | **45/45 in 7,0 min** (423 s inkl. Build-Prüfung) |
| Server-Logs der Läufe (`test-results/server-w*.log` + `server.log` der eigenen Server, je 17 Dateien, gesichert unter `%TEMP%\claude\parallax-fix-f5\run{1,3,4}-logs`) | je Lauf nur die erwarteten 4× `request rejected` (warn, `auth.spec.ts`), **keine Zeile ≥ error**; weder `tok-e2e-secret` noch `draft-secret` in einem Log |
| Aufräumen | CIM-Abfrage (`node`, `msedge`, `git`, `powershell` mit `fix-f5`/`parallax-e2e`/`playwright` in der Befehlszeile): keine; keine `%TEMP%\parallax-e2e-*`-Ordner |

**Chunks (`dist/web/assets`, Bytes, roh):**

| Chunk | vorher (`a617e0a`) | nachher (Endstand) |
|---|---|---|
| `index-*.js` | 435 717 | 377 953 (−57 764) |
| `vendor-*.js` (nur `$initial`-Module) | 312 067 | 274 827 (−37 240) |
| `react-*.js` | 218 809 | 218 809 |
| `index-*.css` | 71 709 | 71 785 |
| **Start gesamt** | **1 038 302** | **943 374** (−94 928) |
| `preferences-*.js` (lazy, neu) | – | 55 777 |
| `profiles-*.js` (lazy, neu) | – | 41 384 |
| `bell-*.js`, `zod-range-*.js` (gemeinsam genutzt, neu) | – | 363, 125 |

Der Start-Chunk enthält `settings-page` und `profile-editor` nicht mehr (`folder-browser` bleibt,
„Neue Session“ nutzt ihn).

Commits: `491e521` (App: Lazy-Slots, Handler-Test), `fe6ad3a` (E2E), `57b4487` (F5-FLAKE-1), danach
dieses Dokument.

## 4. Nahtfehler

Keine Fehler in fremdem Code gefunden; kein Eingriff außerhalb der Besitz-Pfade. Der einzige rote
Basisfall (`phase2-navigation.spec.ts:138`) war gewolltes neues Verhalten (V3-14, F2).

## 5. Live-Prüfpunkte für WP-41

- **R4W-02:** Screenshot aus dem Explorer auf Transkript, Sidebar und Kopfzeile ziehen – Cursor „nicht
  erlaubt“, kein Wegnavigieren; auf den Composer – Chip (der synthetische E2E-Drop sieht den Cursor nicht).
- **R4W-19:** Erstes Öffnen der Einstellungen im App-Fenster (Zahnrad → „Einstellungen…“ und `/settings`):
  keine spürbare Verzögerung, kein halber Dialog; „Profile“ direkt danach ohne Skelett-Flackern;
  Esc gibt den Fokus an Zahnrad bzw. Eingabefeld zurück. DevTools „Network“: `preferences-*.js` und
  `profiles-*.js` erst beim Öffnen.
- **R4W-04/V3-04:** wie E2E im echten App-Fenster (Fokusring sichtbar am Ziel).
- **R4W-01:** Profil mit Env-Secret anfangen, Bereich wechseln, X und Klick daneben (E2E prüft Esc).

## 6. Wünsche an den Koordinator

- `src/web/README.md` / `src/web/shell/README.md`: „`App.tsx` lädt `SettingsPage` und `ProfilesSettings`
  lazy (R4W-19), `PREFERENCES_SLOTS` wird nicht gespreizt“; architecture §2.3 (j) um die beiden
  Lazy-Chunks ergänzen.
- R2W-21: de-Wörterbücher (bzw. die Namensräume `preferences`/`profiles`) lazy – nötig für `index` < 360 kB.
- Folge-Idee: eine Fehlergrenze für Lazy-Slots (Transkript, Einstellungen, Profile): schlägt das Laden
  eines Chunks fehl (Server weg, neuer Build), fällt heute der ganze React-Baum.
- Wunsch aus `e2e/support/dom.ts` bleibt: eigenes `e2e/tsconfig.json` mit `lib: ["ES2024", "DOM"]`.
- `docs/wp/FLAKES.md`: F5-FLAKE-1 (Anmeldecode der E2E-Hilfen mit 2-s-Ping-Budget, behoben in `57b4487`)
  eintragen.
