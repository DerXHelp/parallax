# FIX-E2E-EDGE157 – zwei E2E-Fälle rot seit dem Edge-Update 155 → 157

> Koordinator, 11.11.2026. Worktree `.worktrees/fix-e2e-edge157`, Branch `fix/e2e-edge157`, Basis `main`
> = `53d23c6` (Merge `feature/question-tabs`). Fehler der produktiven Basis → `fix/<name>` von `main`
> (CLAUDE.md „Git“), Merge nach `main` durch den Koordinator.

## 1. Befund (Koordinator)

`pnpm e2e` auf `main` (`53d23c6`): 43/45 grün, 2 rot. Gezielte Wiederholung
(`--repeat-each=3`): 4 von 6 rot. **Derselbe Stand vor dem Merge (`73381c6`) ist ebenso rot (5 von 6)** –
der Merge der Frage-Tabs ist nicht die Ursache. Letzter grüner Volllauf: 19.10.2026 (45/45). Seitdem hat
sich Edge selbst aktualisiert: **155.0.4283.62 (WP-41) → 157.0.4341.46 (jetzt)**. Die Läufe liefen
sequenziell und ohne Fremdlast.

| Fall | Fehler |
|---|---|
| `e2e/phase2-lifecycle.spec.ts:34` „earlier conversation: after /clear …“ | Klick auf das Kopfzeilen-Menü „…“ (`[data-slot="session-menu"]`, `support/app.ts:197`) öffnet kein `role="menu"` (Timeout 15 s). Screenshot: der Knopf hat den Fokusrahmen, das Menü bleibt zu. Teils auch `locator.click` auf `[data-action="conversations"]` im Timeout. |
| `e2e/phase2-navigation.spec.ts:157` „focus comes back after Esc …“ | `Escape` schließt den Dialog „Neue Session“ (`[data-slot="new-session-dialog"]`) nicht (`toBeHidden`, Zeile 209). |

Artefakte (Screenshots, Traces, Server-Logs, WS-Frames, Logs der drei Läufe):
`C:\Users\XHelp\AppData\Local\Temp\claude\d9d013913ce447a5\c0a8ce4a-0208-43dc-a63d-f34e46e01510\scratchpad\e2e-edge157\`
(`main-e2e.log`, `rerun.log`, `rerun-old.log`, Ordner je Fall mit `trace.zip`).

Beobachtung: Andere Fälle mit Radix-Menüs/Dialogen (z. B. `phase2-navigation.spec.ts:91` Kontextmenü,
Umbenennen) liefen grün – das Fehlerbild ist nicht durchgängig, aber gut reproduzierbar.

## 2. Auftrag

1. **Ursache klären** (Traces, gezielte Wiederholungen, ggf. Diagnose-Ausgaben im Test, die danach wieder
   entfernt werden). Kernfrage: **Betrifft das die App im echten Edge 157** (z. B. Radix-`DropdownMenu`
   öffnet auf `pointerdown`, Esc-Handling bei Fokus in einem bestimmten Element, Timing nach Render/Fokus-
   Wechsel) **oder nur die Automatisierung** (Playwright-Klick/Tastatur gegen Edge 157, Test-Annahmen)?
2. **An der Ursache beheben:**
   - App-Fehler → Fix in der App mit Unit-Test (happy-dom), wo sinnvoll, plus grüner E2E-Fall.
   - Test-Fehler → Test bzw. `e2e/support` robust machen: auf Zustände/Ereignisse warten statt feste
     Wartezeiten; **keine Retries**, keine abgeschwächten Prüfungen, kein `force: true` als Ausweg.
3. Prüfen, ob dieselbe Ursache weitere Stellen trifft (andere Menüs/Dialoge, `support/app.ts`-Helfer) und
   diese mit beheben.

**Besitz-Pfade:** `e2e/**` (ohne `e2e/live/**`), diese Datei. Falls die Ursache in der App liegt:
minimal und begründet in `src/web/shell/**`, `src/web/ui/**`, `src/web/features/**` (im Ergebnis
auflisten). **Tabu:** `src/shared/**`, `src/server/**`, `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, Root-Configs (Wunsch → Bericht). Parallel läuft das SDK-Upgrade
(`.worktrees/sdk-0.3.322`) – dort nichts anfassen; es kann Last erzeugen (ebenfalls Playwright/Edge),
Ergebnisse unter Last im Ergebnis kennzeichnen.

**Regeln:** Kein Live-`claude` (nur FakeBackend). **Keine Desktop-Bedienung** per Skript (keine Klicks,
Tastatur, Fenster-Fokus, Bildschirmfotos, UI Automation außerhalb von Playwright; Nutzer-Regel
18.10.2026). Lange Läufe (`pnpm check`, `pnpm e2e`) im Hintergrund mit Ausgabe in Dateien. Gestartete
Prozesse am Ende beenden. Nie `%LOCALAPPDATA%\Parallax` anfassen.

## 3. Abnahme

- Beide Fälle: `pnpm exec playwright test e2e/phase2-lifecycle.spec.ts:34 e2e/phase2-navigation.spec.ts:157 --repeat-each=10` grün.
- `pnpm e2e` zweimal vollständig grün (45/45).
- `pnpm check` und `pnpm build` grün.
- Edge-Version im Ergebnis nennen (`(Get-Item 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe').VersionInfo.ProductVersion`).

**Commit:** lokal auf `fix/e2e-edge157` (Deutsch, mehrere `-m`, kein Heredoc), nicht pushen, nicht mergen.
Bericht im Format aus `CLAUDE.md`.

## 4. Ergebnis

### 4.1 Kurzfassung

- **Ursache:** ein geschlossenes Radix-Menü („…“ der Kopfzeile) bleibt während seiner Exit-Animation
  (`data-[state=closed]:animate-out`, tw-animate-css 150 ms, Beginn erst mit den nächsten Frames)
  gemountet und ist bis dahin eine **vollwertige Ebene im Layer-Stack von Radix**
  (`DismissableLayer`): Outside-`pointerdown`-Listener, Escape-Listener der obersten Ebene,
  `FocusScope` mit Fokus-Rückgabe beim Unmount. Die Tests handelten 30–80 ms nach dem Schließen des
  Menüs und trafen diese noch aktive Ebene.
- **Edge-Update ist nicht die Ursache.** Gegenprobe mit dem alten Edge-Binary, das noch auf der Platte
  liegt (`…\Edge\Application\155.0.4283.62\msedge.exe`), und mit Playwrights Chromium 156: dieselben
  Fehler (Tabelle 4.4). Seit dem letzten grünen Lauf (19.10.) gab es keine Änderung an Code,
  Lockfile (zuletzt 16.10.) oder Windows (letztes Update/Neustart 15.10.). Was das Timing seitdem
  verschoben hat, ließ sich nicht klären (offene Frage); die Fenster sind Millisekunden lang.
- **App im echten Edge 157: praktisch nicht betroffen.** Das Fenster ist ~150 ms + 1–2 Frames nach dem
  Schließen eines Menüs; ein Mensch erreicht es nicht. Diagnose „menschliches Tempo“ (Info-Dialog 1 s
  offen, Esc, 300 ms, Klick auf „…“): die Exit-Animation läuft während des offenen Dialogs ab, das
  Menü ist weg, „…“ öffnet normal (2/2).
- **Fix (nur Tests, `e2e/support/app.ts`):** `chooseMenuItem(item)` klickt den Eintrag und wartet, bis
  **kein Menü mehr da ist** (`[role="menu"]` → 0, Zustand statt Wartezeit); `headerAction`/`rowAction`
  als Kurzform; die Öffner `headerMenu`/`rowMenu`/`openSettings` starten erst ohne verbliebenes Menü.
  Keine Retries, keine festen Wartezeiten, kein `force`, keine Prüfung abgeschwächt.
- **Beifang:** `transcript.spec.ts` (b) wurde in den Volläufen rot (eigene Ursache: virtua holt einen
  zu früh gesetzten Scroll-Offset ans Ende zurück) – Test wartet jetzt auf eine ruhende Liste statt
  fester 300/500 ms (4.3).

### 4.2 Mechanismus (Diagnose mit Ereignis-Rekorder im Test, danach entfernt)

Rekorder per Init-Script: `pointerdown`/`keydown`/`focusin`, `animationstart/end/cancel`,
Mutationen (`role=menu|dialog`, `data-state`, Inline-`pointer-events`), Registrierung von
`keydown`-Capture- und `pointerdown`-Listenern auf `document`, Sonden (MessageChannel, `setTimeout(0)`,
`requestAnimationFrame`) nach jeder Eingabe. Zeiten in ms (Edge 157):

1. **„Session info“ gewählt** → Menü `data-state=closed`, bleibt gemountet (Presence wartet auf
   `animationend exit`); der Info-Dialog öffnet. `animationstart exit` erst ~20 ms später (nach dem
   Esc des Tests).
2. **Esc schließt den Info-Dialog** → das schließende Menü ist wieder oberste Ebene; sein
   Outside-`pointerdown` wird nach dem nächsten Frame neu scharf (~15 ms).
   **Chromium führt nach einer Eingabe normale Tasks (MessageChannel, `setTimeout(0)`) erst nach dem
   nächsten Frame aus** – gemessen in 155 und 157 (z. B. Eingabe 2779,5 → rAF 2791,9 → Tasks 2792,7).
3. **Fall Lebenszyklus (`:34`):** Klick auf „…“ 30–45 ms nach Esc. `onPointerDown` des Triggers öffnet
   dasselbe, noch gemountete Menü; derselbe `pointerdown` erreicht danach den `document`-Listener des
   schließenden Menüs → „außerhalb“ → `onDismiss` → zu (offen 2342,2 → zu 2344,4, `pointerup` erst
   2345,5). Daher: Knopf fokussiert, kein Menü. Variante (repeat1/2): Playwright sah das wieder
   schließende, leere Menü (`SessionMenu` baut Einträge nur bei `open`) → Klick auf
   `[data-action="conversations"]` lief ins Timeout. Der Trigger trug dabei
   `data-radix-popper-align` – das setzt Radix nur, solange ein Popper-Inhalt gemountet ist.
4. **Fall Navigation (`:157`):** „Neue Session“ ~70 ms nach Esc. Oberste Ebene wird der neue Dialog
   erst durch ein Re-Render, das Radix aus einem Effect anstößt (`dispatchUpdate` → `setState` →
   React-Default-Lane → Scheduler-Task) – nach Punkt 2 erst nach dem nächsten Frame. Esc kam 1–4 ms
   nach „sichtbar“ und landete beim Escape-Listener des **schließenden Menüs** (`preventDefault`,
   `onDismiss` ohne Wirkung); der Dialog blieb offen (Diagnose 3/3: `keydown … defaultPrevented=true`,
   Dialog offen).
5. **Variante nur in 155 beobachtet:** Esc schloss den Dialog, der Fokus ging an „Neue Session“ – dann
   endete die Exit-Animation, das Menü wurde entfernt und sein `FocusScope` gab den Fokus an „…“
   zurück → `toBeFocused(newSession)` rot.

Gegenprobe ohne alte Ebene: ein frisch geöffneter Dialog nimmt Esc sofort an (3/3) – mit leerem
Layer-Stack gilt die neue Ebene bei Radix sofort als oberste (`index -1 === size - 1`).

### 4.3 Fix und weitere Stellen

`e2e/support/app.ts`: `chooseMenuItem`, `openMenu` (Vorbedingung „kein Menü“), `headerAction`,
`rowAction`; `openSettingsPage` wählt per `chooseMenuItem`. Umgestellt sind **alle** Menü-Auswahlen
der E2E-Fälle (außer `e2e/live`):

| Stelle | Vorher | Wirkung |
|---|---|---|
| `phase2-lifecycle.spec.ts` `sessionIdOf`, `conversations` ×2, `openExternal` | Klick, sofort weiter | `:34` behoben |
| `phase2-navigation.spec.ts:157` „Session info“ | dito | Esc/Fokus behoben |
| `phase2-navigation.spec.ts:91` pin/archive, `:260` openWindow; `phase2-new-session.spec.ts:22` newSessionHere | dito (Kontextmenü) | gleiche Lücke, bisher grün |
| `openSettingsPage` (Einstellungen, Neue Session/Profile) | dito | die Seite öffnet ohnehin erst beim Unmount des Menüs (`SettingsMenu`) |
| `shutdown.spec.ts` „Stop server…“ ×2 | dito | Dialog/Fokus erst nach dem Menü geprüft |
| `decisions.spec.ts:47` „Deny with a reason…“ | dito | `toBeFocused` prüft jetzt den **Endzustand** nach dem Menü (WP-20c Fix 2: Fokus bleibt im Formular) |
| `decisions.spec.ts:96` Plan-Modus „Manual“ | dito | der Klick auf „Implement“ folgt jetzt **nach** der Fokus-Rückgabe an „▾“ – genau das Szenario der WP-20c-Regression 1, vorher je nach Timing gar nicht erreicht |
| `smoke.spec.ts` `choose` | wartete schon auf `toHaveCount(0)` | nutzt den gemeinsamen Helfer |

`e2e/README.md` (Zeile `support/app.ts`) beschreibt die Regel.

**Beifang: `transcript.spec.ts` (b) „loading earlier items … keeps the reading position“** – in den
ersten beiden Volläufen nach dem Menü-Fix je 1× rot, isoliert 1/3 rot (`boundingBox` des Ankers
„message 37“ im Timeout). Andere Ursache, gleiche Klasse („Test handelt, bevor die UI steht“):
nach dem Reload scrollt das Transkript per `scrollToIndex` ans Ende; virtua hält diesen Scroll
aktiv, solange Zeilen vermessen werden, und scrollt bei jeder Größenänderung zurück ans Ende, bis
150 ms ohne Änderung vergehen. Diagnose 4/4: `scrollTop = 700` stand zwei Frames später wieder bei
≈ 4700 (Ende); nach der festen Wartezeit von 300 ms war der „Anker“ eine Nachricht vom Ende, nach dem
Nachladen nicht mehr gerendert. Fix im Test: `settle(list)` wartet, bis Scrollhöhe und -offset
`SETTLE_MS` (300 ms = 2 × virtuas 150 ms) unverändert sind – jede Änderung startet neu, also ein
Zustand; prüft, dass die Liste wirklich bei ≈ 700 steht; „nachgeladen“ = die Liste wächst nach oben
(`scrollHeight`), dann wieder `settle`. Die beiden festen Wartezeiten (300/500 ms) sind weg; die
Prüfung (Anker bleibt bis auf ±80 px stehen) ist unverändert, der erwartete Versatz ist der
tatsächlich gescrollte (`top − 200`). Danach 6/6 grün isoliert.
Für Menschen: ein Mausrad-Scroll in diesem Fenster (≤ 150 ms nach der letzten Vermessung) würde
vermutlich ebenso zurückgeholt (virtua bricht den Scroll nur per Zeitgeber oder neuem Scroll ab;
nicht live geprüft) – virtua-Verhalten, kein Edge-Thema (Follow-up WP-37, optional).

### 4.4 Läufe

Edge-Version (`msedge.exe`, ProductVersion): **157.0.4341.46**. Zum Vergleich das noch vorhandene
Binary 155.0.4283.62 und Playwrights Chromium 156.0.8078.4 (`ms-playwright\chromium-1248`, schon
installiert, kein Download) über eine temporäre Config (`executablePath`, danach gelöscht). Alle Läufe
mit `PARALLAX_E2E_SKIP_BUILD=1` auf frischem Build, 3 Worker. Während der Läufe war die Maschine nicht
leer (CPU-Last einmal gemessen ~45 %, parallel das SDK-Paket möglich) – **Ergebnisse unter möglicher
Fremdlast**.

| Lauf | Browser | `:34` Lebenszyklus | `:157` Navigation |
|---|---|---|---|
| vorher, `--repeat-each=5` | Edge 157 | 5/5 rot | 0/5 rot |
| vorher, `--repeat-each=5` | Edge 155 | 5/5 rot | 3/5 rot (2× Esc, 1× Fokus) |
| vorher, `--repeat-each=5` | Chromium 156 | 5/5 rot | 1/5 rot |
| Diagnose „Menü nach Esc des Info-Dialogs“ | Edge 157 / 155 | 4/4 bzw. 4/4 sofort wieder zu | – |
| **nachher, `--repeat-each=10` (Abnahme)** | Edge 157 | **10/10 grün** | **10/10 grün** |
| nachher, `--repeat-each=5` | Edge 155 / Chromium 156 | 5/5 / 5/5 grün | 5/5 / 5/5 grün |

- `transcript.spec.ts` (b): vorher isoliert 1/3 rot (und in 2/2 Volläufen), Diagnose 4/4 „Offset
  zurück ans Ende“; nachher isoliert `--repeat-each=6` **6/6 grün**.
- **`pnpm e2e` (Endstand):** zweimal **45/45 grün** (je 2,8 min). Davor zwei Volläufe mit nur dem
  Menü-Fix: je 44/45 (rot nur `transcript.spec.ts` (b), siehe 4.3).
- `pnpm build` grün; `pnpm check` grün (typecheck, lint, 3794 Tests in 215 Dateien).

### 4.5 Wünsche / Follow-ups (Koordinator)

- `e2e/live/live.spec.ts` (nicht in meinem Besitz): `chooseManualMode` klickt `menuitemradio` und
  macht sofort weiter – beim nächsten Live-Smoke auf `chooseMenuItem` umstellen.
- Optional App (`src/web/ui/dropdown-menu.tsx`, Koordinator): `DropdownMenuContent` könnte einen
  `pointerdown` auf den **eigenen Trigger** in `onPointerDownOutside` ignorieren (wie Radix' Popover),
  dann öffnet ein Klick auf „…“ auch während der Exit-Animation. Escape-Annahme und Fokus-Rückgabe einer
  schließenden Ebene sind Radix-Interna; für Menschen ohne Wirkung – daher hier nicht geändert.
- Optional WP-37 (`TranscriptView`): virtuas `scrollToIndex` ans Ende nimmt in den ersten
  ~150 ms nach der letzten Vermessung vermutlich auch einen Nutzer-Scroll zurück (siehe 4.3, Beifang).
- Offene Frage: warum die Fälle bis 19.10. grün waren (kein Code-, Lockfile-, Windows- oder
  Edge-Grund gefunden).
