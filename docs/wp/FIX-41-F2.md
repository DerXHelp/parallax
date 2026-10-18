# FIX-41-F2 – Web (Fix-Runde nach der Live-Abnahme WP-41)

> Paket F2 aus `docs/wp/FIX-41.md` §2, Worktree `.worktrees/fix-41-f2`, Branch `fix/41-f2`, Basis `main` =
> `881a539`. Befunde: `docs/wp/WP-41.md` §2.3 (WP41-01, -02, -05, -06, -07). Kein Live-`claude`, keine
> Desktop-Bedienung, keine Contract-Änderung, keine neue Abhängigkeit.

## 1. Befunde

### SOLLTE

| Befund | Ergebnis | Fix | Test (Gegenprobe ohne Fix rot) |
|---|---|---|---|
| **WP41-01** Töne erst nach einer Geste, obwohl das App-Fenster Audio ohne Geste erlaubt (ADR-120 wirkungslos) | behoben | `notifications/sounds.ts`: ein **einmaliger Versuch beim ersten gesperrten Ton** – der `AudioContext` entsteht, ist er (Chromium mit `--autoplay-policy=no-user-gesture-required`) schon bei der Erzeugung `running` oder läuft er nach `resume()`, gilt `ready` sofort (synchron, bevor `playSound` das erste Mal wartet – so stimmt auch `silent` der eigenen Web-Notification) und die Unlock-Listener werden benachrichtigt (der Hinweis „Töne aktivieren“ verschwindet bzw. erscheint gar nicht). Bleibt er `suspended`, gilt das alte Verhalten (gesperrt, Hinweis, Entsperren bei der ersten Interaktion; der Kontext wird wiederverwendet). Wo der Browser es sagt (`navigator.getAutoplayPolicy?.('audiocontext')`, Firefox), entscheidet das schon `installAudioUnlock` ohne Kontext (`'allowed'` → `ready`, sonst kein Versuch). Kein Kontext beim Start; ADR-122 unverändert | `sounds.test.ts` (+4: App-Fenster – `running` bei der Erzeugung → `ready` synchron, Listener genau einmal, gespielt; Spec-Reihenfolge `suspended` → `resume()` → gespielt; Browser verlangt eine Geste → zweimal `locked`, ein Kontext, ein `resume()`, nach der Geste gespielt im selben Kontext; `getAutoplayPolicy` `'allowed-muted'`/`'allowed'`), `delivery.test.ts` (+2: App-Fenster ohne Klick → Ton gespielt, kein Hinweis, Toast `silent`; Browser mit Geste → Hinweis, kein Oszillator, Toast nicht `silent`, Zeigerdruck entfernt den Hinweis) – 6 rot ohne Fix; `testing.ts`: `FakeAudioContext.initialState`, `resumeCalls` |
| **WP41-02** Pfad-Ende abgeschnitten: Geschwister-Projekte unter einem langen Ordner nicht unterscheidbar | behoben | `lib/path-display.ts`: `splitPathTail(path, count = 2)` → `{ head, separator, last }` (lineare Suche, keine Regex; `head + separator + last === pathTail`). Neu `shell/navigation/PathTail.tsx`: `head` kürzt mit Ellipse (`min-w-0 truncate`, `data-slot="path-head"`), das letzte Segment steht in einem eigenen Element (`path-last`, `shrink-0 max-w-full truncate` – nur breiter als die ganze Box wird es selbst gekürzt). Genutzt in Sidebar-Zeile (`row-path`), Kopfzeile (`header-path`) und Quick-Switcher (`switcher-path`); der volle Pfad bleibt im Tooltip, `textContent` bleibt `pathTail` | `lib/path-display.test.ts` (neu, 3: Live-Pfad, Laufwerkswurzel, abschließender Trenner, ein Segment, leer, Invariante), `navigation/PathTail.test.tsx` (neu, 2), `SessionHeader.test.tsx` (+1: Live-Pfad `…\a\p1`, letztes Segment eigenes Element mit `shrink-0`), `navigation.test.tsx` (Zeile und Quick-Switcher: `path-head`/`path-last`) – 3 rot ohne Fix |

### NIT

| Befund | Ergebnis | Fix | Test (Gegenprobe ohne Fix rot) |
|---|---|---|---|
| **WP41-05** Abo-Limits je Profil statt je Konto | behoben | `navigation/AccountLimits.tsx`: `accountLimits(hostState, now)` gruppiert Profile nach Konto – Schlüssel `configDir` getrimmt, leer/`null` = Standardordner (`null`), sonst `windowsPathKey` aus `@shared/paths` (case-insensitiv, Trenner/abschließender Trenner egal); je Konto der neueste Bericht (`RateLimitInfo.at`). Ein Block je Konto (`data-account-profiles`), Farbpunkte und Namen aller Profile des Kontos; `role="group"` + `aria-label` nur bei mehreren Konten: `navigation.limits.profile` (ein Profil) bzw. neu `navigation.limits.profiles` („Profiles {names}“ / „Profile {names}“) | `limits.test.tsx` (+2: zwei Profile im Standardordner → ein Block mit dem neueren Wert, keine Gruppe; drei Konten mit `C:\Users\user\.claude-work` und `c:/users/USER/.claude-work/` → Labels „Profiles Work, Work fast“/„Profile Private“, neueste Werte, de) – 2 rot ohne Fix; `pane.test.tsx` (Abo-Limits im Szenario `navigation`): „Work“ bekommt im Test einen eigenen `configDir`, sonst teilt es den Standardordner mit „Standard“ und zählt richtigerweise als dasselbe Konto |
| **WP41-06** „Profil testen“ legt `.claude.json`/`backups\` im `configDir` an | behoben (Hinweis, kein Verhalten geändert) | `features/profiles/components/ProfileEditor.tsx`: unter dem `configDir`-Hinweis, sobald ein Ordner eingetragen ist, `profiles.fields.configDirWrites` (en/de: Claude Code richtet den Ordner selbst ein; schon „Profil testen“ legt `.claude.json` und `backups` an, falls sie fehlen), Teil der `aria-describedby`-Beschreibung des Felds; Notiz in `features/profiles/README.md` | `ProfilesSettings.test.tsx` (+1: Hinweis erscheint mit Ordner, ist Teil der Feldbeschreibung, verschwindet beim Leeren, kommt beim Tippen wieder) – rot ohne Fix |
| **WP41-07** Prompt im Moment des Handoffs; wiederhergestellter Entwurf mit Cursor am Anfang | behoben | (a) neu `shell/navigation/handoff.ts`: Zähler je Session „Handoff unterwegs“ (`openExternalConsole`/`trackHandoff`, `useHandoffPending`, `isHandoffPending`) vom Klick bis zur Antwort von `session.openExternal` – Sitzungsmenüs (`session-actions.tsx`, Eintrag dann deaktiviert) und der Terminal-Hinweis des Composers zählen gleich. Der Composer (Feature → Shell, ADR-126) sendet in der Zeit nichts: Knopf deaktiviert, Enter/`submit`/`sendMessage` ohne Wirkung, Text bleibt. (b) `Composer.tsx`: `restoreDraft` setzt den Cursor ans Ende des zurückgekehrten Texts; ein neu montiertes Feld mit Entwurf (z. B. nach „Zurückholen“) setzt ihn in einem Mount-Layout-Effekt ans Ende (Chromium lässt ihn bei einem von React beim Mount gesetzten Wert am Anfang) | `Composer.test.tsx` (+2: Handoff unterwegs → Knopf aus, Enter sendet nichts, Text bleibt, danach sendet Enter; `SESSION_EXTERNAL` abgelehnt → nach dem Zurückholen neues Feld mit dem Text, Cursor am Ende, weiterer Text hängt sich an – mit Chromium-Nachbildung des Cursors im neuen Feld, `emulateChromiumNewFieldCaret`; dazu Cursor-Prüfung im bestehenden SESSION_BUSY-Test), `navigation/handoff.test.ts` (neu, 2: Zählen über Antwort/Ablehnung zweier Klicks, Hook) – beide Composer-Tests rot ohne Fix |

### Zurückgestellt

– keiner.

## 2. Entscheidungen

1. **WP41-01: Versuch beim ersten gesperrten Ton statt Kontext beim Start.** Ein `AudioContext` beim
   Start erzeugte in einem normalen Browser-Tab bei jedem Laden die Chromium-Konsolenwarnung „The
   AudioContext was not allowed to start“ (Warnung, kein Fehler – das E2E sammelt nur Fehler). Der
   Versuch kommt deshalb erst, wenn wirklich ein Ton gespielt werden soll, und genau einmal je
   Seitenleben (`probed`); danach der bisherige Weg. `getAutoplayPolicy` wird genutzt, wo vorhanden
   (nicht in TS-lib.dom, daher ein lokales Interface ohne `any`).
2. **WP41-02: eine Komponente `PathTail` in `shell/navigation`, der reine Helfer in `lib`.** Kopfzeile
   (`shell/SessionHeader.tsx`) importiert `./navigation/PathTail` (innerhalb der Shell); Features
   nutzen den Pfad nicht. `data-slot`s und `textContent` bleiben, damit E2E-Selektoren halten.
3. **WP41-07: gemeinsamer Handoff-Zustand in der Shell statt lokalem Composer-Zustand.** Der Handoff
   aus dem Sitzungsmenü war für den Composer unsichtbar (der Live-Befund kam genau daher); ein kleiner
   Zustand in `shell/navigation/handoff.ts`, den Menü und Composer-Hinweis gleich nutzen. Der Server
   veröffentlicht `external` vor der Bestätigung (Sync-README), die Lücke ist also nur die Laufzeit des
   Befehls (~150 ms).
4. **WP41-05: Konto-Schlüssel ohne Auflösen des Standardpfads.** `null`/leer = Standardordner; ein
   ausdrücklich eingetragener Standardpfad (`%USERPROFILE%\.claude`) zählt als eigenes Konto, weil das
   Web den Home-Ordner nicht kennt (Follow-up unten).

## 3. Checks

- `pnpm check` grün: `tsc -b` ok, `eslint . --max-warnings=0` ok, Vitest **215 Dateien / 3721 Tests**
  bestanden (davon 19 neu: `sounds` +4, `delivery` +2, `path-display` +3, `PathTail` +2,
  `SessionHeader` +1, `limits` +2, `ProfilesSettings` +1, `Composer` +2, `handoff` +2; angepasst:
  `navigation.test.tsx`, `pane.test.tsx`, ein bestehender `sounds`- und ein `Composer`-Test).
- `pnpm build` ok. `pnpm e2e` nicht gelaufen (voller Lauf durch den Koordinator nach dem Merge).
- Gegenproben (Fix per `git stash push -- <datei>` entfernt, Tests rot, danach wiederhergestellt):
  WP41-01 6 rot, WP41-02 3 rot, WP41-05 2 rot, WP41-06 1 rot, WP41-07 2 rot.
- Prettier: geänderte Dateien, die vorher sauber waren, formatiert; `ProfileEditor.tsx`,
  `ProfilesSettings.test.tsx` und die `profiles`-Wörterbücher waren schon vorher nicht
  Prettier-sauber und bleiben unformatiert (sonst fremde Zeilen im Diff).

## 4. Live-Prüfpunkte (Nutzer-Checkliste WP-41 §2.6)

1. **WP41-01 (A22):** App frisch mit `pnpm start` öffnen (Edge-App-Fenster), **nicht** hineinklicken,
   Fenster in den Hintergrund, eine Session fertig werden oder fragen lassen → genau ein Ton, kein
   Hinweis „Töne aktivieren“. Gegenprobe in einem normalen Edge-Tab (ohne App-Modus): Hinweis wie
   bisher, ein Klick entsperrt; in der Konsole höchstens eine Warnung zum AudioContext beim ersten Ton.
2. **WP41-02:** zwei Sessions in `…\<langer Ordner>\p1` und `…\<langer Ordner>\p2`, Sidebar schmal
   ziehen → `p1`/`p2` bleiben in Sidebar-Zeile, Kopfzeile und Strg+K sichtbar, der Ordner davor endet
   mit „…“; Tooltip zeigt den vollen Pfad.
3. **WP41-05:** zwei Profile mit demselben `configDir` (auch mit anderer Groß-/Kleinschreibung oder
   abschließendem `\`) → ein Limit-Block „Profile A, B“; ein Profil mit anderem Ordner → eigener Block.
4. **WP41-06:** Profil-Editor, Ordner eintragen → Hinweis zu `.claude.json`/`backups` erscheint
   (en/de).
5. **WP41-07:** Kopfzeilen-Menü „In externer Konsole öffnen“ und sofort Enter im Composer → nichts
   gesendet, Text bleibt; nach „Zurückholen“ steht der Cursor eines wiederhergestellten Entwurfs am
   Ende, weiterer Text hängt sich an.

## 5. Wünsche an den Koordinator

- **Sidebar, gruppierte Ansicht:** Die Gruppenüberschrift (`src/web/shell/Sidebar.tsx`,
  `GroupSection`: `group.label` in einem `truncate`-Span) kürzt ebenfalls am Ende – gleiches Problem wie
  WP41-02 bei Geschwister-Ordnern. Vorschlag: dort `PathTail` (`./navigation/PathTail`) nutzen. Nicht
  im F2-Pfad, daher nicht geändert.
- **Playground-Szenario `navigation`** (`src/web/playground/navigation-scenario.ts`, nicht im F2-Pfad):
  Die Profile „Standard“ und „Work“ haben beide `configDir: null` und zeigen nach WP41-05 nur noch einen
  Limit-Block (gleiches Konto). Für die Mehr-Konten-Ansicht im Playground „Work“ einen eigenen Ordner
  geben, z. B. `configDir: 'C:\\Users\\user\\.claude-work'` (wie das dritte Beispielprofil in
  `@shared/samples`); `pane.test.tsx` setzt ihn bis dahin im Test selbst.
- **READMEs:** `src/web/shell/README.md` könnte bei `SessionHeader.tsx` den Pfad über
  `navigation/PathTail` nennen (nicht geändert, Koordinator-Pfad). Gepflegt: `src/web/lib/README.md`
  (`splitPathTail`), `shell/navigation/README.md` (`PathTail.tsx`, `handoff.ts`, `AccountLimits`),
  `notifications/README.md` (Autoplay-Regel), `features/profiles/README.md`, `features/composer/README.md`.
- **E2E:** kein Selektor-Bruch erwartet – `row-path`/`header-path` behalten `data-slot` und Text
  (`toHaveText(pathTail(…))` in `phase2-sessions`/`phase2-new-session` gilt weiter); neu sind
  `switcher-path`, `path-head`, `path-last`, `data-account-profiles`, `config-dir-writes`. Das
  Kopfzeilen-Menü „openExternal“ (`phase2-lifecycle`) ist nur während der laufenden Übergabe
  deaktiviert. `pnpm e2e` habe ich nicht laufen lassen (voller Lauf durch den Koordinator nach dem Merge).
- **Shared:** keine Änderung nötig.

## 6. Follow-ups

- WP41-05: Wenn der Server den aufgelösten Konfigurationsordner je Profil liefert (oder `null` für den
  Standard normalisiert), gehört ein ausdrücklich eingetragener Standardpfad zum Standardkonto.
- WP41-01: Der erste Ton in einem normalen Browser-Tab erzeugt einmal die Chromium-Warnung zum
  AudioContext (bewusst, s. Entscheidung 1).
