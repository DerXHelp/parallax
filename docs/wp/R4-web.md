# R4 – Review Web Phase 2 „Mission Control“ (WP-30 Gerüst, WP-35 … WP-38, WP-40 Web)

**Stand:** 18.10.2026, `main` = `d098d9b` (WP-40 gemergt, `pnpm check` grün: 199 Dateien, 3520 Tests)
· **Rolle:** read-only Review, nur diese Datei neu (uncommittet, Commit durch den Koordinator) ·
**Umfang:** `git diff fdc44f7..HEAD -- src/web e2e` (195 Dateien, +20 693/−869) · **Parallel:**
R4-Server (`docs/wp/R4.md`, gleicher Checkout) und V3 (`.worktrees/v3`, Browser/Screenshots).

Schweregrade: **[BLOCKER vor WP-41]** – vor der Live-Abnahme beheben/klären · **[SOLLTE]** – in der
Fix-Runde vor WP-41 · **[NIT]** – Kleinigkeit, bei Gelegenheit. **Frage** = Entscheidung des
Koordinators bzw. Nutzers nötig oder nur live/im Browser klärbar.

## Vorgehen und Checks

- **Gelesen:** `CLAUDE.md`; `docs/progress.md` (inkl. „Sammelliste Welle 2“); `docs/wp/WP-30.md`
  (§2, §4.14 C, §5, §6, §7); `docs/decisions.md` ADR-100 … ADR-120; „2. Ergebnis“ von WP-35, 36, 37,
  38, 40; `docs/architecture.md` §2.3; `docs/wp/R2-web.md` (Aufbau); `docs/plan.md` (Bilder in
  Tool-Ergebnissen, Slash-Befehle). **Produktionscode vollständig** gelesen für
  `features/composer/**` (Composer, Chips, Slash, native Befehle, Bilder/Upload, Rate-Limit, Hilfe,
  ModelPicker), `features/transcript/**` (Phase-2-Diff, ImageThumb/ImageViewer, Blob-Quelle,
  Windows-Pfade, Read-Renderer, ToolCallRow), `ui/lightbox.tsx`, `features/profiles/**`,
  `shell/{NewSessionDialog,NewSessionForm}.tsx`, `shell/new-session/**`, `shell/{requests,slots}.ts(x)`,
  `App.tsx`, `shell/shortcuts.ts` (Kürzel-Pfad); die übrigen Bereiche (WP-35 Navigation, WP-38
  Einstellungen/Töne, E2E) wurden von drei read-only Hilfsagenten mit demselben Auftrag geprüft – ihre
  Befunde sind hier an den Fundstellen nachgeprüft (u. a. R4W-04, -05, -06, -07, -10, -11) und ggf.
  zusammengeführt.
- **Greps über `src/web`:** kein `dangerouslySetInnerHTML`/`innerHTML`/`rehype-raw`/`eval`, kein
  `any`/`as unknown as`/`@ts-ignore`/`eslint-disable` (in `e2e/` 7× `as unknown as`, R4W-27); keine
  Rohfarben in `.tsx` (Hex/rgb nur in Canvas-Code: JPEG-Hintergrund `images.ts:90`, Playground-Daten);
  `title`/`aria-label`/`placeholder`/`alt`/`label` mit Literal nur in Playgrounds (Entwicklertext,
  architecture §2.3c); Links nur im Markdown-Renderer (unverändert http(s), `noopener noreferrer`) und
  der Lightbox-Download (`/api/blob/…`); `window.open` nur `lib/windows.ts:19` mit `'popup,noopener'`.
- **Skripte** (`%TEMP%\claude\parallax-r4-web\`, Node 26 mit Type-Stripping):
  `unused-keys.mjs` (jeder Wörterbuch-Schlüssel gegen Literale und Template-Präfixe im
  Produktionscode), `same-text.mjs` (en/de gleiche Schlüssel, gleiche Platzhalter, gleichlautende
  Texte), `unused-exports.mjs` (Exporte ohne Nutzer). Ergebnis: en/de in allen Phase-2-Namensräumen
  vollständig, Platzhalter identisch, gleichlautende Texte nur Lehnwörter („Branch“, „Port“, „MCP“);
  unbenutzte Schlüssel → R4W-20; tote Exporte → R4W-23.
- **Proben:** `pnpm exec vitest run` für Composer/Transkript/Profile/Neue Session/Lightbox
  (26 Dateien, 295 Tests grün) und für Einstellungen/Töne/SettingsMenu/Slider (7 Dateien, 63 Tests
  grün); eine Vitest-Probe mit eigener Config im Temp-Ordner gegen das Szenario `navigation` (Fokus
  nach Strg+K/Esc, `aria-hidden` der Hinweis-Region, Pfeiltasten im Zeilenmenü; 2 Tests grün, belegt
  R4W-04, -05, -12). Vorhandenes `dist/web` (Build nach WP-40) nur gelesen: `index-*.js`
  422 284 B, `vendor` 312 067 B, `react` 218 809 B; Demo-Code (`FakeProfileServer`, `demo-host`,
  `FakeHost`) ist **nicht** im Start-Chunk, Einstellungsseite und Profil-Editor sind es (R4W-19).
- **Nicht ausgeführt** (laut Auftrag): `pnpm build`, `pnpm e2e`, `pnpm check`, Browser/MCP,
  Live-`claude`. Verhalten mit echtem Layout (Drag & Drop, Radix-Fokus in Edge, Töne) nur aus Code
  und Proben bewertet; die betroffenen Punkte sind als Live-/V3-Prüfpunkt markiert. Keine eigenen
  Prozesse übrig.

## Gesamturteil

Phase 2 Web ist sorgfältig gebaut und hält die Phase-1-Zusagen: Die **Ziel-Sperre** (ADR-040) ist
unverändert (Vergleich mit `fdc44f7`: `enterAnswers`, Lock beim ersten Zeichen, `submit('answer')`
nur armiert), das Slash-Menü öffnet nie bei gesperrtem Ziel, Bild-Uploads ändern den Antwortpfad
nicht; die Queue zeigt weiter nur das Transkript. **Sicherheit** ist ohne harten Befund: Renderer
unverändert sicher, Bilder nur `/api/blob/<id>` (same origin), Upload mit Typ-, Anzahl- und
Größenprüfung im Client und Magic-Bytes im Server, Ordner-Browser lässt den Server entscheiden und
prüft den Start mit `windowsPathIssue`, Secrets im Profil-Editor maskiert (`new-password`), Fenster
mit `noopener`. **Konventionen** sind sauber (alle UI-Texte über `t()`, auch Attribute; en/de
vollständig; nur Tokens; nur `ui/`-Primitives; Importgrenzen lint-sauber).

Die Befunde liegen an vier Stellen:
1. **Ungespeicherte Eingaben und Fokus in Dialogen:** Profil-Entwürfe gehen beim Tab-Wechsel, Esc
   oder Schließen still verloren (R4W-01); drei Navigations-Dialoge geben den Fokus an `<body>`
   zurück (R4W-04); Fehler aus Dialogen landen hinter dem Modal (R4W-05).
2. **Live sichtbare Nahtstellen:** ein Datei-Drop neben den Composer navigiert das App-Fenster weg
   (R4W-02), Bilder aus Tool-Ergebnissen erscheinen erst nach dem Aufklappen (R4W-03), Abo-Limits
   zeigen nach dem Reset alte Werte (R4W-06), nativer Toast und Fenster klingen doppelt (R4W-07,
   Server).
3. **Secrets-Hygiene:** „Konsolenbefehl kopieren“ legt Profil-Secrets im Klartext in die
   Zwischenablage (R4W-08, Frage), die Secret-Regel existiert doppelt (R4W-09).
4. **E2E-Stabilität:** fester 700-ms-Wait als Grundlage von sechs Präsenz-Fällen (R4W-10).

**Anzahl:** 0 × BLOCKER, 10 × SOLLTE, 18 × NIT. WP-41 braucht keine Vorarbeit im Sinne eines
Blockers; empfohlen ist, R4W-01, -02, -04, -06, -07 und -08 vor der Live-Abnahme zu beheben bzw. zu
entscheiden, weil sie dort sofort auffallen.

## Abgleich Sammelliste Welle 2 (Web-Punkte) und WP-40 §2.6

| Punkt | Ergebnis |
|---|---|
| `isSecretEnvKey` nach `@shared` (Kopie `features/profiles/lib/secrets.ts`) | bestätigt, identische Regex in Web und Server → **R4W-09** |
| Feature `profiles` importiert `shell/new-session` (Grenze) | zulässig (Feature → Shell, nie umgekehrt; vom Auftrag WP-36 vorgesehen), aber undokumentiert → **R4W-22** |
| unbenutzte Schlüssel `shell.newSession.{description,hint,starting}`, `shell.empty.recentProjects` | bestätigt, dazu weitere aus WP-35 und Phase 1 → **R4W-20** |
| Esc verwirft ungespeicherte Profiländerungen | bestätigt und **größer**: auch Tab-Wechsel, X, Klick daneben, erneute `settings`-Anfrage → **R4W-01** |
| `state/settings.ts` alle Top-Level-Felder optimistisch | heute ohne Fehlerbild (Overlay in WP-38), Vereinfachung → **R4W-15** |
| Hinweis mit Aktion (`ClientNotice`) für „Töne aktivieren“, Hinweis-Region hinter Modals | bestätigt (Probe: `aria-hidden`), konkrete Instanz im Conversations-Dialog → **R4W-05** |
| Kommentar `server/lib/powershell.ts` | Server, nicht Teil von R4-Web |
| WP-40: Start-Chunk 412 kB, `lazy()` | Kandidaten und Schnitt ohne Änderung an `App.tsx` → **R4W-19** |
| V3: deaktivierter eingeschalteter Switch wirkt aktiv | Code dimmt (`disabled:opacity-50`), Kontrast im Screenshot prüfen → **R4W-18** (Frage an V3) |
| V3/WP-37: Bild im `Read`-Ergebnis erst nach Aufklappen | weicht vom Plan ab („inline als Thumbnail“) → **R4W-03** |

## Geprüft ohne Befund (Auszug)

- **Composer (WP-37):** Slash-Menü als Listbox mit `aria-activedescendant`, Klick hält den Fokus im
  Feld (`command-list.tsx:162`); Terminal-Befehle ausgeblendet, `/config` nur mit `key=value`
  durchgereicht; native Befehle entfernen den Entwurf nur bei Erfolg und unveränderter Eingabe;
  Paste nimmt Bilder nur ohne Text; Chips mit Zustand, Abbruch per `AbortController`, Rückgabe nach
  Sendefehler, Objekt-URLs werden freigegeben; Upload-Antwort und Fehler per zod
  (`attachmentUploadResponseSchema`, `errorPayloadSchema`); Anhänge nur für den lokalen Host;
  deaktivierter Composer (archiviert/extern) behält den Entwurf; Rate-Limit-Banner rendert nur an
  Fristen (`useNowUntil`).
- **Transkript/Lightbox:** eine Lightbox je `TranscriptView` außerhalb der virtualisierten Zeilen,
  Fokus zurück zum Vorschaubild bzw. zur Region; `children` von `ImageViewer` bleiben referenzgleich
  (kein Re-Render der Liste beim Öffnen); Zoom per Knöpfen/Rad/Tasten, Rad-Listener nicht passiv und
  entfernt; V2-12 nur in Fließtext (Code-Spans, Fences, eingerückte Zeilen bleiben); `handoff`-Zeile
  ohne `role="separator"` (Text bleibt lesbar).
- **Neue Session / Ordner-Browser / Profile (WP-36):** Vorbelegung über den Anfragekanal, Default
  vorausgewählt, Fehlerprofile gesperrt (Grund im Eintrag und Tooltip); Ordner-Browser mit Brotkrumen,
  Typeahead, Alt+↑, nur die neueste Antwort zählt, Auswahl übernimmt `listing.path` exakt; Editor mit
  entprellter `profile.validate` (nur neueste Antwort), Grenzen aus `profileInputSchema`/`LIMITS`,
  `safeParse` an der Grenze, Befunde je Zeile über Zeilen-IDs, Bypass rot mit Badge, configDir-Warnung
  per `windowsPathKey`; Env-Werte erscheinen in keinem Text und keinem Log des Clients.
- **Navigation (WP-35):** Alt+1…9 = sichtbare Reihenfolge (flach, gruppiert, Archiv), Alt+N zyklisch,
  keine Strg+Alt-Kürzel; Inline-Umbenennen Enter/Esc/Blur; Kontextmenü-Regeln (Schlafen nur `idle`,
  extern nur mit Session-ID); `#session=` per Schema geprüft; `SessionRow` `memo` mit primitiven Props,
  Sidebar hängt nicht an Item-Deltas; `requests.ts` (neuester Handler gewinnt, `false` reicht weiter).
- **Einstellungen/Töne (WP-38):** Overlay baut zweite Änderung auf der ersten auf, Rücknahme bei
  Fehler, kein Overlay-Leck (Zeitüberschreitung/`CONNECTION_LOST` beendet die Anfrage); Zahlenfelder
  speichern bei Enter/Blur in zod-Grenzen; ein `AudioContext`, erst nach Interaktion, `suspend` in
  Pausen; Kanalwahl hebt nie gegen „Nicht stören“ oder Toast aus an; `silent` der Web Notification nach
  ADR-109.
- **E2E (WP-40):** Fälle mit Reihenfolge-/Einstellungsabhängigkeit starten eigene Server, kein
  `describe.serial`; Aufräumen mit Log-Prüfung; Plan-Verifikation Phase 2 (WP-30 §2.11) vollständig
  abgedeckt, soweit ohne Live möglich; CSP-Verletzungen lassen jeden Test scheitern; `noopener` und
  eigene `clientId` geprüft.

---

## Befunde

### SOLLTE (Fix-Runde vor WP-41)

#### R4W-01 [SOLLTE] Profil-Entwurf geht ohne Rückfrage verloren – Tab-Wechsel, Esc, X, Klick daneben
- **Fundstelle:** `src/web/features/preferences/SettingsPage.tsx:96-101` (`onOpenChange(false)` →
  sofort `onClose`), `:149-154` (`TabsContent` ohne `forceMount` – Radix hängt inaktive Bereiche aus;
  `src/web/ui/tabs.tsx:33-41`); `src/web/features/profiles/ProfilesSettings.tsx:33`, `:55-62` (Schutz
  nur beim Profilwechsel innerhalb des Bereichs); `features/profiles/components/ProfileEditor.tsx:221`
  (Entwurf nur im Komponenten-State); `src/web/shell/SettingsMenu.tsx:122-137` (jede neue
  `settings`-Anfrage montiert die Seite über `key={serial}` neu).
- **Beschreibung:** Die Sammelliste nennt Esc. Häufiger ist der **Tab-Wechsel**: Wer im Bereich
  „Profile“ Env-Variablen oder Argumente eingibt und kurz unter „Allgemein“ nachsieht, verliert den
  ganzen Entwurf samt eingetippter Secrets. Ebenso bei Esc in jedem Feld, beim X, beim Klick auf das
  Overlay und bei `/settings` aus dem Composer, während die Seite offen ist.
- **Auswirkung:** stiller Datenverlust längerer Eingaben; in WP-41 („Profil mit eigenem `configDir`
  testen“) wahrscheinlich.
- **Fix:**
  - (a) **WP-38:** `TabsContent value="profiles"` mit `forceMount` und `hidden={current !==
    'profiles'}` – der Entwurf übersteht den Tab-Wechsel (ohne Contract-Änderung).
  - (b) **Koordinator + WP-36 + WP-38:** Schutz beim Schließen. Entweder Slot-Prop
    `ProfilesSettings: ComponentType<{ onDirtyChange?: (dirty: boolean) => void }>`
    (`shell/slots.tsx`) – WP-36 meldet `dirty` (gibt es schon intern, `ProfilesSettings.tsx:33`) – oder
    eine kleine Schutz-Registry im Anfragekanal (`useCloseGuard` in `shell/requests.ts`). Bei `dirty`
    fängt `SettingsPage` `onEscapeKeyDown`/`onPointerDownOutside`/X per `preventDefault` ab und zeigt
    die vorhandene Inline-Rückfrage (Muster `profile-discard-confirm`).
  - (c) **WP-38:** `SettingsPageHost` wechselt bei offener Seite nur `section`, statt neu zu montieren.
- **Test-Idee:** Feld im Editor ändern → Tab „Allgemein“ → zurück → Wert noch da; mit `dirty` Esc →
  Rückfrage, Dialog bleibt offen; „Verwerfen“ schließt.
- **Owner:** WP-38 (`features/preferences/**`, `shell/SettingsMenu.tsx`), WP-36
  (`features/profiles/**`), Koordinator (`shell/slots.tsx` bzw. `shell/requests.ts`).

#### R4W-02 [SOLLTE] Datei-Drop neben dem Composer navigiert das App-Fenster zur Datei
- **Fundstelle:** `src/web/features/composer/Composer.tsx:646-674` (die **einzigen**
  `dragover`/`drop`-Handler in `src/web` – nur auf der Composer-Wurzel); kein globaler Schutz in
  `src/web/shell/{AppShell,ShellEffects}.tsx` oder `main.tsx` (grep `onDrop|dragover|'drop'`).
- **Beschreibung:** Ein Screenshot wird typischerweise „auf das Fenster“ gezogen, nicht genau auf die
  schmale Composer-Leiste. Landet er auf Transkript, Sidebar oder Kopfzeile, ruft niemand
  `preventDefault()` – Chromium/Edge öffnet dann die Datei im selben Fenster (`file:///…png`). Das
  App-Fenster (`--app`, ohne Adressleiste) zeigt das Bild statt Parallax; zurück nur per Alt+←, die
  WS-Verbindung ist bis dahin weg. Gleiches gilt bei entfernten Hosts (`canAttach === false`), weil
  der Composer dann gar nichts abfängt.
- **Auswirkung:** Verlust des App-Zustands (Entwurf bleibt, Chips/Scroll-Position nicht); wirkt wie
  ein Absturz. Live wahrscheinlich (WP-41 prüft Screenshots).
- **Fix:** **WP-35:** in `ShellEffects` ein fensterweiter `dragover`/`drop`-Listener, der für
  `dataTransfer.types` mit `Files` immer `preventDefault()` ruft (`dropEffect = 'none'` außerhalb einer
  Drop-Zone). **WP-37:** optional die ganze `SessionPane` als Drop-Zone (Bilder gehen an den Composer
  der gezeigten Session; Übergabe über ein kleines Shell-Modul wie `transcript-follow.ts`, ohne
  Feature-Querimport).
- **Test-Idee:** Web-Test: `drop` mit `Files` auf `[data-slot=transcript]` → `defaultPrevented`;
  E2E: `page.dispatchEvent('[data-slot=transcript]', 'drop', …)` → URL unverändert.
- **Owner:** WP-35 (`src/web/shell/**`), WP-37 (`features/composer/**`).

#### R4W-03 [SOLLTE] Bilder aus Tool-Ergebnissen erscheinen erst nach dem Aufklappen der Tool-Zeile
- **Fundstelle:** `src/web/features/transcript/items/ToolCallRow.tsx:109-111` (`Disclosure` mit
  `defaultOpen = renderer.defaultOpen?.(item) ?? false`); `renderers/read.tsx:102` und
  `renderers/parts.tsx:84-98`, `:136` (`ResultImages` nur im Body); `docs/plan.md:338-339` („Sie
  erscheinen **inline als Thumbnail**“), `:839`; E2E klickt die Zeile auf
  (`e2e/phase2-composer.spec.ts:121`).
- **Beschreibung:** Ein Screenshot über das chrome-devtools-MCP, ein `Read` auf ein Bild oder Bash mit
  Bild ist ein zentrales Ergebnis – heute sieht man nur „Read foo.png“ und muss aufklappen. Der
  Read-Body hat bei Bildern meist keinen Text; aufgeklappt zeigt er nur das Bild.
- **Auswirkung:** Abweichung vom Plan; V3/WP-40 haben es bemerkt (WP-40 §2.6).
- **Fix (WP-37, nach kurzer Koordinator-Entscheidung):** `ToolCallFrame` zeigt `resultImages(item)`
  als Thumbnail-Leiste **unter der Kopfzeile, unabhängig vom Aufklappen** (kleinere Höhe, z. B.
  `max-h-40`), und die Bodies (`read`, `parts`) lassen sie dann weg; alternativ `defaultOpen: item =>
  resultImages(item).length > 0` für Read/MCP/Bash. Danach E2E-Klick in `phase2-composer.spec.ts:121`
  entfernen (WP-40).
- **Test-Idee:** `phase2.test.tsx`: Read mit Bild-Ergebnis → `[data-slot=image-thumb]` ohne Klick
  sichtbar, genau einmal.
- **Owner:** WP-37 (`features/transcript/**`), WP-40 (E2E-Anpassung).

#### R4W-04 [SOLLTE] Quick-Switcher, „Frühere Unterhaltungen“ und Session-Info geben den Fokus an `<body>` zurück
- **Fundstelle:** `src/web/shell/navigation/QuickSwitcher.tsx:174-191`,
  `ConversationsDialog.tsx:50-56`, `SessionInfoDialog.tsx:36-42` (kein `DialogTrigger`, kein
  `onCloseAutoFocus`); Radix Dialog fokussiert beim Schließen nur `triggerRef`.
- **Beschreibung:** Die Dialoge öffnen über Strg+K, `/resume`, `/status` (Anfragekanal) oder einen
  Menüeintrag. Probe: Zeile fokussiert → Strg+K → Esc → `document.activeElement === body`; ebenso
  Session-Info → Esc. `NewSessionDialog` und `SettingsPage` lösen das selbst (gemerktes Element), die
  WP-35-Dialoge nicht.
- **Auswirkung:** Wer im Composer `/status` oder Strg+K nutzt, tippt danach ins Leere;
  Tastatur-/Screenreader-Nutzer verlieren die Position (ADR-118 „Esc schließt Dialoge“).
- **Fix:** Beim Öffnen `document.activeElement` merken; in `onCloseAutoFocus` `preventDefault()` und
  das gemerkte Element fokussieren, falls noch verbunden, sonst Zeile bzw. „…“ der Kopfzeile (wie
  `finishRename`); nach einer Auswahl im Quick-Switcher `focusSessionInput` der neuen Session.
  Gemeinsamer Helfer `useReturnFocus()` in `src/web/lib` (WP-38 hat dasselbe Muster in
  `SettingsPage.tsx:94-109` – dann dort mitnutzen).
- **Test-Idee:** Zeile fokussieren → Strg+K → Esc → Fokus wieder auf der Zeile; Composer fokussiert →
  `/status` → Esc → Fokus im Composer.
- **Owner:** WP-35 (`src/web/shell/navigation/**`, `src/web/lib/**`).

#### R4W-05 [SOLLTE] Hinweise liegen hinter jedem Modal (verdeckt, für Screenreader verborgen); Hinweis ohne Aktion
- **Fundstelle:** `src/web/shell/NotificationCenter.tsx:91` (`fixed … z-40`, außerhalb der
  Dialog-Portale; Dialoge `z-50`, Radix `hideOthers` setzt `aria-hidden` – per Probe bestätigt);
  konkrete Instanz `src/web/shell/navigation/ConversationsDialog.tsx:41-45` (`showErrorNotice` bei
  `SESSION_BUSY`, Dialog bleibt offen); `src/web/notifications/delivery.ts:96-99` („Töne aktivieren“
  ohne Knopf, weil `ClientNotice` keine Aktion kennt – WP-38 §2.2).
- **Beschreibung:** „Öffnen“ einer früheren Unterhaltung bei arbeitender Session zeigt den Grund nur
  abgedunkelt hinter dem Overlay, angesagt wird nichts. Gleiches gilt für Session-Hinweise
  („Berechtigung nötig“), die während eines offenen Dialogs eintreffen (der Ton kommt trotzdem). WP-38
  umgeht es für eigene Fehler mit einem Inline-`Alert`, WP-36 ebenso.
- **Auswirkung:** Klick scheint wirkungslos; Barriere für Screenreader (Sammelliste Welle 2).
- **Fix:**
  - **WP-35:** `ConversationsDialog` zeigt Fehler inline (`Alert role="alert"` mit `tError`), wie die
    Einstellungsseite.
  - **Koordinator (Regel) + WP-35 (`state/notices.ts`, `NotificationCenter.tsx`):** Regel in
    architecture §2.3(i) „Fehler aus Dialogen inline“; die Region rendert per Portal über dem Overlay
    (`z-[60]`) bzw. wird von `hideOthers` ausgenommen; im selben Zug
    `ClientNotice.action?: { label: TranslationKey; run(): void }` – dann bekommt „Töne aktivieren“
    einen Knopf (WP-38 nutzt ihn).
- **Test-Idee:** `switchConversation` → `SESSION_BUSY` → `getByRole('alert')` im
  `[data-slot=conversations-dialog]`; Dialog offen + `showNotice` → Region ohne `aria-hidden`-Vorfahr.
- **Owner:** WP-35, Koordinator (Doku, ggf. `ui/dialog.tsx`), WP-38 (Knopf „Töne aktivieren“).

#### R4W-06 [SOLLTE] Abo-Limits zeigen nach dem Reset weiter die alte Auslastung, mit vergangener Uhrzeit
- **Fundstelle:** `src/web/shell/navigation/AccountLimits.tsx:20-25` (`resetsAt − now < DAY_MS` ist
  für **jede vergangene** Zeit wahr → nur Uhrzeit, kein Datum); `src/web/lib/account-limits.ts:28-44`
  (keine Prüfung `resetsAt <= now`).
- **Beschreibung:** Die Limits sind persistent (ADR-114) und ändern sich nur mit dem nächsten
  `rate_limit_event`. Nach einem Neustart am Folgetag steht z. B. „5-Stunden-Limit 92 % –
  zurückgesetzt um 03:50“, obwohl der Reset Tage zurückliegt. Das deutsche „zurückgesetzt um“ klingt
  zudem nach Vergangenheit.
- **Auswirkung:** irreführende Anzeige; Abo-Limit-Anzeige ist WP-41-Prüfpunkt (WP-30 §10).
- **Fix:** `limitBars(info, now)` blendet Fenster mit `resetsAt <= now` aus (oder zeigt 0 % mit
  „zurückgesetzt“); `useNowUntil([resetsAt…])` statt `useNow(60_000)` rendert genau am Reset neu; Text
  de „setzt sich um {time} zurück“ bzw. „… am {date}“.
- **Test-Idee:** Tabelle in `lib/navigation-helpers.test.ts`: `resetsAt` vergangen → keine Leiste;
  Reset in drei Tagen → Text mit Datum.
- **Owner:** WP-35 (`src/web/lib/account-limits.ts`, `shell/navigation/AccountLimits.tsx`, Namensraum
  `navigation`).

#### R4W-07 [SOLLTE] Doppelter Ton: nativer Toast und Fenster klingen gleichzeitig (Naht Server ↔ Web) – Frage
- **Fundstelle:** Server `src/server/sessions/notifier.ts:78-80` (Fenster ohne Web-Notification-Recht →
  `delivery: 'in_app'`, `native: true`), `src/server/sessions/manager.ts:634-653` (`notify` an das
  Fenster **und** `toasts.show`), `src/server/sessions/nativeToasts.ts:44` (`silent: !sound`); Client
  `src/web/notifications/delivery.ts:124`, `:136` (klingt bei jedem `notify` mit Ton).
- **Beschreibung:** Für Web Notifications regelt der Client es richtig (`silent`, wenn er selbst klingt,
  `delivery.ts:144`). Für den **nativen** Toast fehlt die Entsprechung: Kann das Fenster keine Web
  Notifications zeigen (Fall WP22-03/ADR-082), spielen Windows-Toast-Ton und Web-Audio-Ton
  gleichzeitig. Mit ADR-120 ist Web Audio im App-Fenster ohne Interaktion entsperrt – der Doppelton
  ist dort der Normalfall.
- **Auswirkung:** störender Doppelklang bei jeder Benachrichtigung in WP-41 (L8, Ton-Prüfung).
- **Fix (Server, Entscheidung Koordinator, ADR-109 ergänzen):** Toast `silent = !sound ||
  planned.clientId !== null` (ein Fenster bekommt die Meldung und klingt selbst); Alternative: Contract-
  Flag am `notify`, damit der Client nicht klingt. Test: `planNotification`/`toastShowOptions` mit
  `systemNotifications: false` und Fenster → `silent: true`.
- **Owner:** WP-31/34-Pfade (`src/server/sessions/**`); **Abgleich mit R4-Server** (`docs/wp/R4.md`).
  **Frage:** falls der Doppelton gewollt ist (Toast-Ton als „Systemton“), bitte im ADR festhalten.

#### R4W-08 [SOLLTE] „Konsolenbefehl kopieren“ legt Profil-Secrets im Klartext in die Zwischenablage – Frage
- **Fundstelle:** Server `src/server/claude/consoleCommand.ts:89-99` (`$env:NAME='<value>'` für **alle**
  `spec.explicitEnv`, auch `*_KEY`/`*_TOKEN`); Web `src/web/shell/navigation/session-actions.tsx:98-118`
  (`copyText(result.command)`); Hinweistext `shell/navigation/i18n/en.ts:49-50` (warnt nur vor zwei
  Schreibern).
- **Beschreibung:** Parallax maskiert Secrets im Editor und schwärzt sie im Log (R9, ADR-102), kopiert
  sie hier aber ohne Hinweis. Windows hält Zwischenablage-Inhalte im Verlauf (Win+V) und synchronisiert
  sie ggf. geräteübergreifend.
- **Auswirkung:** API-Keys/Tokens landen außerhalb der Kontrolle von Parallax; widerspricht dem eigenen
  Secrets-Konzept.
- **Fix (Entscheidung Koordinator):** Server ersetzt Werte geheimer Namen (`isSecretEnvKey`) durch eine
  Abfrage, z. B. `$env:ANTHROPIC_API_KEY=(Read-Host 'ANTHROPIC_API_KEY')` (Befehl bleibt nutzbar,
  Secret nie in der Zwischenablage); mindestens aber der Hinweistext nennt es („enthält Zugangsdaten
  deines Profils“). Test: `consoleCommandText` mit `{GATEWAY_TOKEN:'x'}` → Ausgabe ohne `x`.
- **Owner:** WP-32 (`src/server/claude/consoleCommand.ts`) + WP-35 (Text im Namensraum `navigation`);
  **Abgleich mit R4-Server**.

#### R4W-09 [SOLLTE] Secret-Regel doppelt: `isSecretEnvKey` als Kopie im Web
- **Fundstelle:** `src/web/features/profiles/lib/secrets.ts:7-9` und `src/server/claude/profiles.ts:25-27`
  (identische Regex), Nutzer `features/profiles/components/EnvTable.tsx:71`,
  `src/server/sessions/external.ts:63`; Wunsch WP-36 §2.6.
- **Beschreibung:** Eine sicherheitsrelevante Regel an zwei Stellen: Erweitert jemand die Server-Regel
  (z. B. `*_APIKEY`, `*_CREDENTIALS`), maskiert der Editor den Wert nicht mehr bzw. umgekehrt. Der Test
  `lib.test.ts:29-41` prüft nur die Web-Kopie gegen eine eigene Tabelle.
- **Auswirkung:** Drift zwischen Log-Schwärzung und UI-Maskierung; R4W-08 bräuchte die Regel im Server
  ohnehin.
- **Fix:** **Koordinator:** `isSecretEnvKey` nach `@shared` (z. B. `src/shared/common.ts` oder neues
  `@shared/secrets`), Contract-Changelog; danach **WP-36** entfernt `lib/secrets.ts`, **WP-32**
  re-exportiert bzw. importiert aus `@shared`.
- **Test-Idee:** Tabellentest in `src/shared` (Groß/klein, Suffixe, `PASSWORD` mittendrin); Web und
  Server nutzen denselben Import (grep-Test entfällt).
- **Owner:** Koordinator (`src/shared/**`), WP-36, WP-32.

#### R4W-10 [SOLLTE] E2E: fester 700-ms-Wait in `setPresence` trägt sechs Präsenz-Fälle
- **Fundstelle:** `e2e/support/presence.ts:92-93` (`waitForTimeout(700)` nach der Präsenzänderung,
  Entprellung im Client 250 ms); Aufrufer `e2e/phase2-sessions.spec.ts:142`, `:157`,
  `e2e/phase2-settings.spec.ts:49`, `:64`, `:69`, `e2e/notifications.spec.ts:43`.
- **Beschreibung:** Der Test nimmt an, dass der Server die Präsenz nach 700 ms kennt. Unter Last
  (gedrosselte Timer, paralleles `pnpm test`) kommt sie ggf. nach der nächsten Aktion an – dann wählt
  der Server `in_app` statt `system` bzw. ein Turn-Ende gilt als gesehen.
- **Auswirkung:** Flake-Quelle in den neuen Statusketten- und Benachrichtigungsfällen (vgl.
  `docs/wp/FLAKES.md`); in der „Nicht stören“-Prüfung droht falsches Grün.
- **Fix:** Init-Script umhüllt `WebSocket.prototype.send` und merkt sich das letzte
  `{type:'presence'}`; `setPresence` wartet per `expect.poll`, bis ein Frame mit den gewünschten
  `focused`/`visible` gesendet wurde (Server liest Frames eines Sockets in Reihenfolge →
  deterministisch).
- **Test-Idee:** `phase2-sessions` 5× parallel zu `pnpm test`.
- **Owner:** WP-40 (`e2e/**`).

### NIT

#### R4W-11 [NIT] Globale Kürzel wirken hinter modalen Dialogen
- **Fundstelle:** `src/web/shell/shortcuts.ts:224-252` (Overlay-Prüfung nur für Esc, `:227-228`);
  Registrierungen `src/web/shell/Sidebar.tsx:224-244` (Alt+1…9, Alt+N, `allowInInputs`),
  `src/web/shell/navigation/NavigationLayer.tsx:47-69` (Strg+K, F2).
- **Beschreibung:** Bei offener Einstellungsseite, Neue-Session-Dialog oder Lightbox wechseln Alt+1…9/
  Alt+N die Session dahinter (die Lightbox verschwindet dann mit ihrer `TranscriptView`, Fokus auf
  `<body>`); Strg+K stapelt den Quick-Switcher über die Einstellungen; F2 startet ein Umbenennen
  hinter dem Modal, das die Fokusfalle sofort wieder abbricht.
- **Fix:** In `handleKeyDown` Kürzel überspringen, wenn ein modaler Dialog offen ist
  (`document.querySelector('[role=dialog][aria-modal=true]')`) und das Ziel nicht darin liegt; ggf.
  Flag `allowInOverlays` je Kürzel. Test: Einstellungen offen → Alt+2 ändert die Auswahl nicht.
- **Owner:** WP-35 (`src/web/shell/shortcuts.ts`).

#### R4W-12 [NIT] Pfeiltasten in den Zeilenmenüs lösen die Listennavigation der Sidebar aus
- **Fundstelle:** `src/web/shell/Sidebar.tsx:72-79` (`onListKeyDown` prüft weder `defaultPrevented`
  noch, ob das Ziel im DOM unter der Liste liegt).
- **Beschreibung:** React-Ereignisse aus portalisierten Radix-Menüs (Kontextmenü, „…“) laufen durch
  den React-Baum zur Liste. Probe: ArrowDown im „…“-Menü fokussiert kurz eine Sidebar-Zeile; die
  Fokusfalle holt den Fokus zurück. Möglicher Scroll-Sprung bzw. aufblitzender Tooltip (Frage an V3).
- **Fix:** `if (event.defaultPrevented || !(event.target instanceof Node) ||
  !event.currentTarget.contains(event.target)) return;` am Anfang. Test: ArrowDown im Menü → keine
  Zeile erhält `focus`.
- **Owner:** WP-35.

#### R4W-13 [NIT] Roving-Tabindex gilt in Archiv- und Gruppenansicht nur eingeschränkt
- **Fundstelle:** `src/web/shell/navigation/SessionRow.tsx:276-292` („Wiederherstellen“ je archivierter
  Zeile immer Tab-Stopp); `src/web/shell/Sidebar.tsx:156-165` („+“ je Gruppe Tab-Stopp).
- **Beschreibung:** architecture §2.3(l) sagt „die Liste bleibt ein Tab-Stopp“ – gilt nur flach.
- **Fix:** Knöpfe wie „…“ nur bei Hover/Fokus bzw. `tabIndex={-1}` (Aktionen bleiben über Kontextmenü
  und „…“ erreichbar) oder die Ausnahme dokumentieren. Test: Archiv mit drei Einträgen → Tab verlässt
  die Liste nach höchstens zwei Stopps.
- **Owner:** WP-35.

#### R4W-14 [NIT] Session-Info zeigt rohe Enum-Werte
- **Fundstelle:** `src/web/shell/navigation/SessionInfoDialog.tsx:62-64` (`apiKeySource`, z. B.
  „none“), `:77` (MCP-`server.status`, z. B. „needs-auth“).
- **Beschreibung:** Englische Datenwerte auch in der deutschen UI; „none“ heißt Abo-Anmeldung.
- **Fix:** bekannte Werte über `t('navigation.info.apiKeySources.<v>')` bzw. `…mcpStatus.<v>`,
  Unbekanntes roh. Test: deutsch + `apiKeySource: 'none'` → „Abo (claude.ai)“ o. ä.
- **Owner:** WP-35.

#### R4W-15 [NIT] `state/settings.ts` übernimmt nur `language`/`theme` optimistisch (Sammelliste)
- **Fundstelle:** `src/web/state/settings.ts:52-57` (`definedOnly`).
- **Beschreibung:** Heute ohne Fehlerbild – die Einstellungsseite legt ein eigenes Overlay darüber
  (`features/preferences/state/settings-editor.ts`). Die Rücknahme-Logik verträgt alle Felder.
- **Fix:** alle definierten Top-Level-Schlüssel des Patches optimistisch übernehmen; danach kann WP-38
  das Overlay auf die Fehleranzeige reduzieren (Folgearbeit). Test: `updateSettings({idleSleep})` →
  Store sofort geändert, bei Fehler zurück.
- **Owner:** WP-35 (`src/web/state/**`), danach optional WP-38.

#### R4W-16 [NIT] Einstellungsseite: Fehleranzeige verschwindet mit einem späteren Erfolg; Fehler nach dem Schließen verloren
- **Fundstelle:** `src/web/features/preferences/state/settings-editor.ts:52-60`
  (`if (latest.current === token) setError(null)`).
- **Beschreibung:** Änderung A scheitert (Rücknahme + `Alert`), dann Änderung B an einem anderen Feld
  gelingt → `Alert` weg, A springt still zurück. Schließt der Nutzer vor dem Ack, geht ein Fehler ganz
  verloren (State unmontiert).
- **Fix:** Fehler erst bei der nächsten Änderung **desselben** Top-Level-Felds bzw. per Schließen des
  `Alert` löschen; nach dem Unmount `showTextNotice('settings.saveFailed')`. Test: A rejected, B
  resolved → `role=alert` bleibt.
- **Owner:** WP-38.

#### R4W-17 [NIT] Lautstärke per Tastatur: ein `settings.update` und ein Vorhören je Taste
- **Fundstelle:** `src/web/features/preferences/sections/NotificationsSection.tsx:129-134` (Radix ruft
  `onValueCommit` bei jedem Pfeil-/Bild-/Pos1-Tastendruck).
- **Beschreibung:** Gehaltene Pfeiltaste → viele Schreibvorgänge (`settings.json`, `host.state` an alle
  Fenster) und überlappende Töne.
- **Fix:** Commit bei Tastatur entprellen (z. B. 300 ms nach der letzten Taste speichern, dann einmal
  vorhören). Test mit Fake-Timern: 5× Pfeil → ein Patch.
- **Owner:** WP-38.

#### R4W-18 [NIT] Deaktivierte Schalter: „Fenster beim Anmelden öffnen“ ohne Begründung; eingeschaltet + deaktiviert wirkt aktiv (V3) – Frage an V3
- **Fundstelle:** `src/web/features/preferences/sections/ServerSection.tsx:70-85` (kein
  `disabledReason` → kein `aria-describedby` auf den Grund); `src/web/ui/switch.tsx:10`
  (`data-[state=checked]:bg-brand … disabled:opacity-50`); Label gedimmt über
  `features/preferences/components/SettingField.tsx:53`.
- **Beschreibung:** Der Grund (keine Systemintegration bzw. Autostart aus) steht nur am
  Autostart-Feld. Der Switch wird gedimmt, 50 % der Akzentfarbe reicht im dunklen Thema vermutlich
  nicht (WP-40-Smoke-Screenshot); nur per Screenshot klärbar.
- **Fix:** **WP-38:** `disabledReason` setzen (ohne Integration der vorhandene Text, sonst neuer
  Schlüssel „nur mit Autostart“). **Koordinator** (`ui/switch.tsx`, bestehend): z. B.
  `disabled:data-[state=checked]:bg-muted-foreground/50`. Test: `aria-describedby` zeigt auf den Grund.
- **Owner:** WP-38, Koordinator (`src/web/ui/switch.tsx`).

#### R4W-19 [NIT] Start-Chunk 412 kB: Einstellungsseite und Profil-Editor sind statisch drin – `lazy()`-Schnitt
- **Fundstelle:** `src/web/App.tsx:5-6`, `:25`, `:30` → statisch über
  `src/web/features/preferences/index.ts` und `src/web/features/profiles/index.ts`; Beleg
  `dist/web/assets/index-CCUgsJ4_.js` (422 284 B) enthält `settings-page`, `profile-editor`,
  `folder-browser` (Quelltext grob 37 kB preferences + 75 kB profiles ohne Tests/Playground/i18n).
- **Beschreibung:** Beide öffnen selten. Unkritisch für 127.0.0.1, aber die 500-kB-Schwelle
  (architecture §2.3j) rückt näher; zusätzlich liegen alle en- **und** de-Wörterbücher im Start-Chunk
  (R2W-21).
- **Fix (ohne Änderung an `App.tsx`):** nach dem Muster `features/transcript/slots.tsx` exportieren
  **WP-38** (`features/preferences/index.ts`) und **WP-36** (`features/profiles/index.ts`)
  Modulkonstanten `memo((props) => <Suspense fallback={…}><Lazy… {...props} /></Suspense>)` mit
  `lazy(() => import('./SettingsPage'))` bzw. `'./ProfilesSettings'` – eigenes `Suspense` nötig, weil
  `SettingsMenu.tsx:130` den Slot ohne Grenze rendert; der Identitätsvergleich mit dem Platzhalter
  (`SettingsMenu.tsx:121`) bleibt gültig. Optional **WP-35**: `QuickSwitcher`/`ConversationsDialog`/
  `SessionInfoDialog`, **WP-36**: `FolderBrowser`; **Koordinator**: `de`-Wörterbücher lazy.
- **Test-Idee:** `App.test` öffnet die Seite per `findBy…`; Build-Bericht nennt `index` < 360 kB und
  die neuen Chunks.
- **Owner:** WP-38, WP-36 (je eigene `index.ts`); optional WP-35, Koordinator (`src/web/i18n/**`).

#### R4W-20 [NIT] Unbenutzte i18n-Schlüssel
- **Fundstelle (Skript `unused-keys.mjs`, Produktionscode ohne Tests/Playground):**
  - neu unbenutzt durch Phase 2: `shell.newSession.{description,hint,starting}`
    (`src/web/i18n/en.ts:114-119`), `shell.empty.recentProjects` (`:110`), `shell.sidebar.waitingAction`
    (`:46`); `navigation.sidebar.viewMode`, `navigation.sidebar.groupSessions`,
    `navigation.row.archived`, `navigation.row.external` (`src/web/shell/navigation/i18n/en.ts:10`,
    `:19`, `:26-27`);
  - nur noch in der Playground-Galerie: `shell.newSession.{title,cwdLabel,cwdPlaceholder,submit}`,
    `shell.session.details` (`playground/demos.tsx`);
  - schon in Phase 1 unbenutzt: `common.show` (`en.ts:20`), `shell.sidebar.lastActivity` (`:48`),
    `decisions.panel.label` (`features/decisions/i18n/en.ts:139`).
- **Fix:** Schlüssel in en/de entfernen, Galerie auf `newSession.*` umstellen; als Wächter ein
  Vitest, der Schlüssel ohne Literal/Template-Präfix im Code meldet (Logik wie das Skript, Ausnahmen
  per Liste).
- **Owner:** Koordinator (`src/web/i18n/**`, `playground` nur lesend → WP-35 für `demos.tsx`), WP-35
  (Namensraum `navigation`).

#### R4W-21 [NIT] Duplikate und Helfer außerhalb von `lib`
- `copyText` (`src/web/lib/clipboard.ts:5-14`, WP-35) und eigene Clipboard-Logik in
  `features/transcript/components/CopyButton.tsx:38-44` → `CopyButton` nutzt `copyText` (**WP-37**).
- Endungstabellen doppelt: `features/transcript/state/blob-source.ts:23-29` und
  `features/composer/lib/images.ts:108-113` (Features dürfen nicht teilen) → eine Tabelle
  `extensionForMediaType` in `src/web/lib` (**WP-35**), beide nutzen sie (**WP-37**).
- `PROFILE_BG` in `src/web/shell/navigation/profile-colors.ts:4` ist ein reiner Helfer (genutzt von
  `shell/new-session/profile-status.tsx` und `features/profiles/components/ColorPicker.tsx:5`) →
  `src/web/lib/profile-colors.ts`; Profil-Map je Host doppelt (`Sidebar.tsx:208-214`,
  `QuickSwitcher.tsx:80-87`) → Selektor `useProfilesByHost()` in `state/hooks.ts` (**WP-35**).
- zod-Grenzen-Introspektion doppelt: `features/preferences/lib/limits.ts:10-12` und
  `features/profiles/lib/draft.ts:65-71` → optional `numberRange(schema)` in `src/web/lib` (**WP-35**).
- Env-Namensregel dupliziert: `features/profiles/lib/draft.ts:191` (`/^[^=\s][^=]*$/`) statt der
  Schlüssel-Schema-Prüfung aus `profileInputSchema` (`src/shared/model.ts:188-193`) → je Zeile
  `profileInputSchema.shape.env.keyType.safeParse` o. ä. (**WP-36**).
- `DEFAULT_PORT = 4711` in `features/preferences/lib/limits.ts:21` und `src/server/config.ts:39` →
  Contract-Wunsch `@shared` (**Koordinator**).
- **Owner:** wie je Punkt angegeben.

#### R4W-22 [NIT] Feature → Shell-Importe sind erlaubt, aber nirgends als Regel festgehalten
- **Fundstelle:** `features/profiles/components/{ProfileEditor,ProfileList,FieldNotes,TestResult,
  ColorPicker}.tsx`, `lib/draft.ts:19` → `shell/new-session/{FolderBrowser,profile-issues,
  profile-status}`, `shell/navigation/profile-colors`; `features/preferences/sections/AboutSection.tsx:3`
  → `shell/SettingsMenu` (`HostFacts`); `features/composer/HelpDialog.tsx:3` → `shell/ShortcutHelp`.
- **Bewertung:** Richtung Feature → Shell ist durch ESLint erlaubt (`eslint.config.js` sperrt nur
  Shell → Feature und Feature ↔ Feature), zyklenfrei, und für WP-36 im Auftrag vorgesehen
  („Shell-Bausteine; der Profil-Editor nutzt den Ordner-Browser“). `CLAUDE.md` sagt aber nur
  „Querverbindungen zur Shell über den Anfragekanal“. Profil-Domänenlogik (Status-/Befundtexte im
  Namensraum `newSession`, `profile-issues.ts`) liegt damit in der Shell.
- **Fix:** **Koordinator:** Regel in `CLAUDE.md`/architecture §2.3(h): „Features dürfen Shell-Bausteine
  importieren (Komponenten, Kanäle), die Shell nie Features“. Optional **WP-36:** reine Helfer
  (`profile-issues.ts`) nach `src/web/lib`, **WP-38:** `HostFacts` in eigene Datei
  `shell/HostFacts.tsx` (Owner-Frage: `SettingsMenu.tsx` gehört WP-38).
- **Owner:** Koordinator (Doku), optional WP-36/WP-38.

#### R4W-23 [NIT] Tote Exporte
- **Fundstelle (Skript `unused-exports.mjs`):** `slashCatalogOf` (`features/composer/lib/slash.ts:107`,
  nirgends genutzt), `isProfileUsable` (`shell/new-session/profile-status.tsx`), `getRename`
  (`shell/navigation/rename.ts`); dazu nur in Tests genutzte Helfer (unkritisch).
- **Fix:** entfernen. **Owner:** WP-37, WP-36, WP-35.

#### R4W-24 [NIT] Autofokus auf der destruktiven Aktion in Inline-Bestätigungen
- **Fundstelle:** `features/profiles/components/ProfileEditor.tsx:688` („Löschen bestätigen“
  `autoFocus`), `features/profiles/ProfilesSettings.tsx:103` („Verwerfen“ `autoFocus`).
- **Beschreibung:** Per Tastatur ausgelöst (Enter auf „Löschen“) landet der Fokus direkt auf der
  bestätigenden Aktion; ein wiederholtes Enter (Auto-Repeat) bestätigt sofort. Schaden begrenzt
  (Löschen nur unbenutzter Profile), aber gegen die Praxis „Fokus auf Abbrechen“.
- **Fix:** `autoFocus` auf „Abbrechen“ bzw. „Weiter bearbeiten“. Test: Enter auf „Löschen“ → Fokus auf
  „Abbrechen“.
- **Owner:** WP-36.

#### R4W-25 [NIT] Lightbox „Speichern unter“ ist ein Download-Link – im Parallax-Edge-Profil vermutlich ohne Dialog (Live-Prüfpunkt)
- **Fundstelle:** `src/web/ui/lightbox.tsx:234-243` (`<a href download>`); Beschriftung
  `transcript.image.save`.
- **Beschreibung:** Edge fragt im frischen Profil standardmäßig nicht nach dem Speicherort, die Datei
  landet in „Downloads“. Die Beschriftung verspricht einen Dialog („Speichern unter“, Plan).
- **Fix:** WP-41 prüfen; bei Bedarf `window.showSaveFilePicker` (in Edge vorhanden, Rückfall Link)
  oder Text „Herunterladen“. **Owner:** WP-37 (`ui/lightbox.tsx`, `features/transcript/**`).

#### R4W-26 [NIT] Composer-Kleinigkeiten (Bilder und native Befehle)
- **`/plan text` bei laufendem Upload:** `canSend` gilt für Befehlsentwürfe ohne Upload-Prüfung
  (`features/composer/Composer.tsx:350`), `sendMessage` bricht dann still ab (`:416-418`) – der Modus
  wechselt, der Text bleibt ohne Hinweis stehen (`lib/native.ts:127-134`). Fix: Inline-Hinweis
  `composer.attachments.pending` bzw. Senden-Knopf sperren.
- **Antwort per Enter mit Bild-Chips:** der Antwortpfad (`Composer.tsx:483-503`) kann keine Bilder
  mitsenden (Contract), die Chips bleiben kommentarlos liegen. Fix: Hinweis „Bilder gehen mit der
  nächsten Nachricht“ an der Zielzeile.
- **GIF ohne Skalierung:** `lib/images.ts:146-148` lässt ein GIF ≤ 3,75 MB unabhängig von der Kante
  unverändert (ADR-103: lange Kante 1568 px). Fix: nur unskalierte GIFs durchreichen, sonst wie andere
  Bilder kodieren (Animation geht ohnehin verloren).
- **Owner:** WP-37 (`features/composer/**`); je ein Test in `attachments.test.tsx`/`images.test.ts`.

#### R4W-27 [NIT] E2E-Kleinigkeiten
- „Nicht stören“: Abwesenheit per festem 1-s-Wait, ohne Positivkontrolle, dass vorher überhaupt ein Ton
  kam (`e2e/phase2-settings.spec.ts:70-77`) → nach `:53` `expect.poll(tones).toContain(CHIME_HZ)`.
- Optimistische Anzeige gilt als „gespeichert“ (`phase2-settings.spec.ts:26-30`, `:44-45`, `:66-67`,
  `:91-99`) → auf `host.state.settings` warten oder `data-pending` der Seite (WP-38).
- Status-Rekorder kann Zwischenzustände verschmelzen (`phase2-sessions.spec.ts:108-113`) →
  `attributeOldValue: true`.
- Selektoren an englischen Texten (`phase2-new-session.spec.ts:46`, `phase2-navigation.spec.ts:133`,
  `:139`, `phase2-settings.spec.ts:44`, `:66`, `:88`, `support/app.ts:89`); Fuzzy-Anfrage „zbr“ kann
  über das zufällige `mkdtemp`-Suffix im Pfad doppelt treffen (`phase2-navigation.spec.ts:54`) →
  `data-*`-Attribute, eindeutigere Anfrage.
- `as unknown as` in Browser-Callbacks (`phase2-sessions.spec.ts:106`, `:118`, `support/presence.ts`
  5×) → `declare global { interface Window { … } }` in `e2e/support`.
- R9 nicht geprüft: das gespeicherte Token `tok-e2e-secret` (`phase2-new-session.spec.ts:85-97`) wird
  nie gegen das Server-Log geprüft → `expect(logLines).not.toContain('tok-e2e-secret')`.
- **Owner:** WP-40 (`e2e/**`).

#### R4W-28 [NIT] App-Test „jede Anfrage hat einen Handler“ ist nicht vollständig erzwungen
- **Fundstelle:** `src/web/App.test.tsx:349-361` (fest kodierte `ShellRequest[]`-Liste).
- **Fix:** `const REQUESTS: { [K in ShellRequestKind]: ShellRequestOf<K> }` (Typen aus
  `shell/requests.ts:38-39`) und darüber iterieren – eine neue Anfrage-Art ohne Fall bricht dann `tsc`.
- **Owner:** WP-40 (`src/web/App.test.tsx`).

---

## Empfohlene Fix-Pakete

Gruppiert nach den Owner-Pfaden aus `CLAUDE.md`, damit parallele Fix-Worktrees ohne gemeinsame Datei
entstehen. Reihenfolge innerhalb eines Pakets = Priorität.

| Paket | Owner-Pfade (`CLAUDE.md`) | Befunde | Abhängigkeit |
|---|---|---|---|
| **K – Koordinator (zuerst)** | `src/shared/**`, `src/web/shell/{requests,slots}.ts(x)`, `src/web/i18n/**`, bestehende `src/web/ui/*`, Doku | R4W-09 (`isSecretEnvKey` nach `@shared`, Changelog), R4W-01 (Slot-Prop `onDirtyChange` bzw. Schutz-Registry), R4W-05 (Regel „Fehler aus Dialogen inline“, ggf. `ui/dialog`), R4W-18 (`ui/switch`), R4W-20 (Kern-Schlüssel), R4W-21 (`DEFAULT_PORT`), R4W-22 (Regel Feature → Shell), Entscheidungen R4W-03, -07, -08 | blockiert die Teile von 01, 09 in den Paketen B/C und den Server |
| **A – Navigation (WP-35-Pfade)** | `src/web/shell/**` ohne WP-36/38-Dateien, `src/web/{state,lib,playground}/**`, `ui/{context-menu,command-list}` | R4W-02 (globaler Drop-Schutz in `ShellEffects`), R4W-04, R4W-05 (Conversations inline, `NotificationCenter`/`notices` mit Aktion), R4W-06, R4W-11, -12, -13, -14, -15, R4W-21 (Helfer nach `lib`, `useProfilesByHost`), R4W-23 (`getRename`), R4W-08 (Hinweistext), R4W-20 (`navigation`-Schlüssel, Galerie) | R4W-05 Aktion-API vor Knopf in Paket D |
| **B – Composer/Transkript (WP-37-Pfade)** | `src/web/features/{composer,transcript}/**`, `src/web/ui/lightbox.tsx` | R4W-03, R4W-02 (Drop-Zone Pane, optional), R4W-26, R4W-21 (`CopyButton`, Endungstabelle), R4W-23 (`slashCatalogOf`), R4W-25 | R4W-21 Endungstabelle nach A; R4W-03 → E2E in Paket E |
| **C – Neue Session/Profile (WP-36-Pfade)** | `src/web/shell/{NewSessionDialog,NewSessionForm,EmptyState}.tsx`, `src/web/shell/new-session/**`, `src/web/features/profiles/**` | R4W-01 (`dirty` melden), R4W-09 (Kopie entfernen), R4W-19 (lazy `ProfilesSettings`, optional `FolderBrowser`), R4W-24, R4W-21 (Env-Regel), R4W-23 (`isProfileUsable`), R4W-22 (optional) | nach K (01, 09) |
| **D – Einstellungen/Töne (WP-38-Pfade)** | `src/web/features/preferences/**`, `src/web/notifications/**`, `src/web/shell/SettingsMenu.tsx`, `src/web/ui/slider.tsx` | R4W-01 (`forceMount`, Schließ-Schutz, kein Neumontieren), R4W-16, R4W-17, R4W-18 (`disabledReason`), R4W-19 (lazy `SettingsPage`), R4W-05 (Knopf „Töne aktivieren“) | 01 teils nach K; Knopf nach A |
| **E – Integration/E2E (WP-40-Pfade)** | `e2e/**`, `src/web/App.tsx`, `src/web/App.test.tsx` | R4W-10, R4W-27, R4W-28; E2E-Anpassung nach R4W-03 (`phase2-composer.spec.ts:121`), neue Fälle zu R4W-01/-02/-04 | nach B (03) |
| **S – Server (Abgleich R4-Server)** | `src/server/sessions/**` (WP-31/34), `src/server/claude/**` (WP-32) | R4W-07 (Toast `silent`), R4W-08 (Secrets nicht in den Kopierbefehl), R4W-09 (Import aus `@shared`) | nach K; mit `docs/wp/R4.md` zusammenlegen |

**Live-/V3-Prüfpunkte aus diesem Review:** R4W-02 (Drop in Edge), R4W-07 (Doppelton im App-Fenster),
R4W-12 (Scroll-Sprung), R4W-18 (Kontrast deaktivierter Switch), R4W-25 (Download-Dialog).
