# FIX-R4-F4 – Composer/Transkript (Ergebnis)

> Fix-Runde nach R4/V3, Paket **F4** laut `docs/wp/FIX-R4.md` §2. Worktree `.worktrees/fix-f4`,
> Branch `fix/r4-f4`, Basis `main` = `29f3256`. Besitz-Pfade: `src/web/features/{composer,transcript}/**`,
> `src/web/ui/lightbox.tsx`, neu `src/web/lib/media-types.ts` (+ Test daneben). Kein Live-`claude`,
> kein Browser (chrome-devtools-MCP gehört F3).

## 1. Befunde

| Befund | Ergebnis | Umsetzung | Test (Gegenprobe) |
|---|---|---|---|
| **R4W-03 / V3-09** Tool-Bilder erst nach Aufklappen, „Bild ohne Namen“ | **behoben** | Koordinator-Entscheidung „inline wie im Plan“: `ToolCallFrame` zeigt `ToolResultImages` (neu in `renderers/parts.tsx`) **unter der Zeile, unabhängig vom Aufklappen**, Vorschau `max-h-40`; die Bodies (`ToolResultText`, `ReadBody`) zeigen keine Bilder mehr → genau einmal. `AgentCard` (eigene Zeile ohne Frame) zeigt die Leiste ebenfalls. Name: `previewImages(item)` (`lib/text.ts`) benennt Blobs ohne Namen nach dem letzten Segment von `input.file_path` (zod-Leser `readFilePathInput`) → „Bild fake-shot.png vergrößern“, Lightbox-Titel und „Speichern unter“ `fake-shot.png`. Nur `image/*`, gecacht je Item (stabil für `memo`). Ein Ergebnis nur aus Bildern zeigt aufgeklappt kein „Keine Ausgabe“/„Die Datei ist leer.“ | `items/phase2.test.tsx` „pictures of tool results …“ (Read, Bash, MCP, nur Bilder, Agent-Karte, `previewImages`); ohne die Leiste in `ToolCallRow` 4 der 6 rot (Agent-Karte und `previewImages` hängen nicht daran) |
| **V3-02** `/vim` + Enter setzt `/clear ` ein | **behoben** | `filterMenu` (`lib/slash.ts`) ohne `fuzzyFilter`: jedes Wort muss Name/Alias unscharf treffen (`fuzzyScore`, nur lesend aus `lib/fuzzy.ts`) **oder** – ab `DESCRIPTION_MIN_CHARS` = 3 Zeichen – als **zusammenhängender** Teilstring in der Beschreibung stehen (akzent-/groß-klein-unabhängig). Reihenfolge: exakter Name/Alias, dann Namens-/Alias-Treffer (Fuzzy-Wert), dann Beschreibungstreffer, bei Gleichstand Katalogreihenfolge. Neu `menuMatches(entries, query, terminal)`: ein **exakt getippter Terminal-Befehl** liefert keine Treffer → Menü zu, Enter zeigt den Terminal-Hinweis (Composer nutzt `menuMatches`) | `lib/slash.test.ts` (V3-02 ×3), `slash.test.tsx` „`/vim` + Enter ohne Esc“ und „`/mo` nur Namen“; ohne Fix beide Komponententests rot |
| **ADR-125** Summengrenze vor dem Senden, Fehler am Chip | **behoben** | `attachmentsOverTotal(list, max = LIMITS.attachmentsTotalBytes)` (`state/attachments.ts`): Rohbytes (`ref.bytes`) der fertigen Uploads in Listenreihenfolge; jeder Chip ab dem Überschreiten ist „über der Grenze“. `AttachmentChips` zeigt am Chip „Alle Bilder zusammen über 20 MB“ (Fehlerfarbe, `data-over-total`, im `aria-label`), die Fußzeile „Die Bilder sind zusammen zu groß – entferne eins, um zu senden.“; Senden/Enter gesperrt (`canSend`, Schutz in `sendMessage`). Entfernen gibt frei | `attachments.test.tsx` (6 × 3,75 MB, Chip 6 markiert, Entfernen → Senden mit 5 Blob-IDs) + Tabellentest `attachmentsOverTotal` |
| **V3-04** `HelpDialog` gibt den Fokus an `<body>` | **behoben** | `HelpDialog` merkt sich beim Öffnen (Layout-Effekt, vor dem Fokus-Sprung) das fokussierte Element und gibt es in `onCloseAutoFocus` zurück, sonst `returnFocus` (Composer: Eingabefeld). Beim Wechsel zur Tastenkürzel-Hilfe bleibt der Fokus dort | `slash.test.tsx` „V3-04 …“ (getippt und per Menü gewählt; Esc und „Schließen“) |
| **R4W-21** `CopyButton` eigene Clipboard-Logik; Endungstabellen doppelt | **behoben** | `CopyButton` nutzt `copyText` (`lib/clipboard.ts`, nur lesend). Neu `src/web/lib/media-types.ts`: `extensionForMediaType` (eine Tabelle: PNG, JPEG, WebP, GIF, SVG, PDF; Parameter/Großschreibung egal) und `fileNameForMediaType`; `composer/lib/images.ts` (`nameForType`) und `transcript/state/blob-source.ts` (`downloadNameOf`) nutzen sie | `lib/media-types.test.ts`, `components/CopyButton.test.tsx` (Erfolg, abgelehnt, keine Zwischenablage), bestehende `nameForType`-/Download-Tests |
| **R4W-23** toter Export `slashCatalogOf` | **behoben** | entfernt | `tsc`/ESLint |
| **R4W-26** Composer-Kleinigkeiten | **behoben** | (1) `/plan text` bei laufendem/fehlgeschlagenem/zu großem Upload: „Ausführen“ gesperrt, Enter ohne Wirkung (kein Moduswechsel), Hinweis „Bilder werden hochgeladen…“ – `sendsPrompt(action)` in `lib/slash.ts`; (2) Antwort per Enter mit Bild-Chips: Hinweis „Die Bilder bleiben für deine nächste Nachricht – eine Antwort geht ohne sie.“ an der Zielzeile (`aria-describedby`); (3) GIF über der Kantengrenze wird wie jedes Bild skaliert (nur unskalierte GIFs bleiben unverändert) | `attachments.test.tsx` (R4W-26 ×2), `lib/images.test.ts` (GIF ×2) |
| **V3-12** (Anteil WP-37) | **behoben** | `ImageThumb`: `loading="lazy"` nur mit bekannter Größe (Tool-Ergebnis-Blobs haben keine; die Liste ist virtualisiert); verstecktes Datei-Input des Composers mit `id` | `phase2.test.tsx` „V3-12 …“ |
| **V3-13** (Anteil WP-37) | **behoben** | Rate-Limit-Zeile übersetzt `rateLimitType` (`five_hour` → „5-Stunden-Limit“, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`; Unbekanntes roh, `lib/rate-limit.ts`); de „Zurückgesetzt {time}“ → „Zurücksetzung {time}“ (künftige Zeit); EN-Composer-Sperre „Opened in an external console – …“ | `phase2.test.tsx` „rate-limit row …“ (5 Fälle), `states.test.tsx` |
| R4W-02 (optional) Drop-Zone über dem ganzen Pane | **zurückgestellt** | Die `SessionPane` gehört der Shell (F2); eine Übergabe der Dateien an den Composer bräuchte ein Shell-Modul (Feature ↔ Feature ist verboten). Der globale Drop-Schutz (F2, `ShellEffects`) verhindert das Wegnavigieren bereits; die Pane-Drop-Zone ist reiner Komfort | – |
| R4W-25 Lightbox „Speichern unter“ = Download-Link | **geprüft, zurückgestellt (Live-Punkt)** | Code unverändert: `<a href="/api/blob/…" download="<name>">` – Edge fragt im frischen Profil standardmäßig nicht nach dem Ort (Datei landet in „Downloads“). Seit diesem Paket stimmt wenigstens der Dateiname (V3-09). Entscheidung erst nach WP-41: entweder Beschriftung „Herunterladen“ (neuer Text) oder `showSaveFilePicker` mit Rückfall auf den Link | – |

## 2. Entscheidungen

1. **Bilder unter der Zeile statt `defaultOpen`:** Die Vorschau steht unter der Kopfzeile, die Zeile
   bleibt zugeklappt (kompakt, wie im Plan); die Bodies zeigen keine Bilder mehr, damit jedes Bild
   genau einmal erscheint. Höhe `max-h-40` (Klick → Lightbox in voller Größe).
2. **Slash-Filter ohne `fuzzyFilter`:** eigene Rangfolge in `lib/slash.ts` auf Basis von
   `fuzzyScore` – `lib/fuzzy.ts` (F2) bleibt unverändert und kann für den Quick-Switcher (V3-03)
   angepasst werden, ohne das Slash-Menü zu verschieben. Beschreibungstreffer erst ab 3 Zeichen.
3. **Summengrenze abgeleitet statt Fehlerzustand:** „über der Grenze“ wird aus der Liste berechnet
   (kein neuer `status`); entfernt man einen Chip davor, verschwindet der Fehler von selbst.

## 3. Checks

Stand Commit `7dd61d3` (Code), Logs in `%TEMP%\claude\parallax-fix-f4\`.

| Schritt | Ergebnis |
|---|---|
| `pnpm exec tsc -b` | grün |
| `pnpm exec eslint src/web/features/{composer,transcript} src/web/ui/lightbox.tsx src/web/lib/media-types*.ts --max-warnings=0` | grün |
| `pnpm exec vitest run` eigene Pfade (Composer, Transkript, `lib/media-types`, `ui/lightbox`) | 19 Dateien, 272 Tests grün |
| Gegenproben (Fix temporär zurückgenommen) | R4W-03: 4 Tests rot; V3-02 (Composer): 2 rot; V3-04: rot; ADR-125: rot – danach wiederhergestellt |
| `pnpm check` | `tsc` ✓, ESLint ✓, Vitest 3590/3591 – rot nur `features/profiles/ProfilesSettings.test.tsx › creates a new profile` (F3-Pfad, 22,5 s unter Last der vier parallelen Pakete; isoliert 13/13 grün) |
| `pnpm test` (voller Wiederholungslauf) | **202 Dateien, 3591 Tests grün** (268 s) |
| `pnpm build` | grün, Build `0.0.0+7dd61d3c124b`; `index` 424,7 kB (vorher 422,3 kB), `vendor` 312,1 kB |
| Sichtprüfung ohne Browser | Vite auf Port 5187 (`PARALLAX_DEV_WEB_PORT`), 21 geänderte Module per HTTP transformiert (200, neuer Code enthalten), keine Fehler im Vite-Log; Vite per PID beendet |

Commits: `a1174e2` (Transkript-Bilder, `media-types`, CopyButton, Rate-Limit-Fenster, GIF),
`7dd61d3` (Composer: Slash-Menü, Summengrenze, `/plan`-Uploads, Antwort-Hinweis, Hilfe-Fokus,
`slashCatalogOf`), danach dieses Dokument.

## 4. Hinweise für F5 (E2E)

- **`e2e/phase2-composer.spec.ts:119-123` (R4W-03):** Der Klick auf die Tool-Zeile entfällt. Statt
  `await read.getByRole('button', { name: /Read/ }).first().click();` prüfen, dass das Bild **ohne
  Aufklappen** und genau einmal da ist, z. B.
  `await expect(read.locator('[data-slot="image-thumb"]')).toHaveCount(1);` und optional
  `await expect(read.getByRole('button', { name: /Read/ }).first()).toHaveAttribute('aria-expanded', 'false');`.
  Der Name kommt jetzt aus `input.file_path`: Knopf „Enlarge image fake-shot.png“, Lightbox-Titel
  „Image: fake-shot.png“, `lightbox-save` mit `download="fake-shot.png"` (zusätzliche Assertion
  sinnvoll). Der Rest (Klick aufs Vorschaubild, Esc, Fokus zurück) bleibt.
- **Neuer Fall V3-02 „`/vim` + Enter ohne Esc“:** in einer Session mit Katalog (nach dem ersten
  Turn) `await session.composer.fill('/vim'); await expect(menu).toHaveCount(0);
  await session.composer.press('Enter');` → `[data-slot="terminal-hint"]` sichtbar mit „/vim“,
  Feld bleibt `/vim`, keine User-Nachricht `/vim`. Nicht `run()` benutzen (drückt Esc).
- Der Helfer `run()` (Esc vor Enter) bleibt für `/rename`/`/clear` nötig: ein exakt getippter
  Befehl mit Menütreffer übernimmt bei Enter weiterhin den Eintrag (`/clear ` + Argument-Hinweis).

## 5. Live-Prüfpunkte (WP-41)

- Read eines Screenshots bzw. chrome-devtools-`take_screenshot`: Vorschaubild unter der
  zugeklappten Zeile, genau einmal; Name aus dem Pfad; Lightbox öffnet.
- `/vim` + Enter (ohne Esc) zeigt den Hinweis; `/mo` zeigt nur Namens-Treffer.
- Sechs große Screenshots einfügen (je nahe 3,75 MB nach dem Verkleinern) → ab dem Überschreiten
  von 20 MB Fehler am Chip, Senden gesperrt; Server lehnt ohne Client-Sperre ebenfalls ab (F1).
- R4W-25: „Speichern unter“ im Parallax-Edge-Profil – Dialog oder direkt „Downloads“?

## 6. Wünsche an den Koordinator

- `src/web/lib/README.md` (mehrere Owner): Zeile für `media-types.ts` ergänzen –
  „`extensionForMediaType(type)` (eine Endungstabelle, R4W-21), `fileNameForMediaType(name, type)` –
  genutzt von Composer (Anhangsnamen) und Transkript („Speichern unter“)“.
- R4W-25: Entscheidung nach WP-41 (Beschriftung oder `showSaveFilePicker`).
- F2 (Hinweis): Die Tastenkürzel-Hilfe (`shell/ShortcutHelp.tsx`) hat keinen Trigger und gibt den
  Fokus beim Schließen an `<body>` (gleiches Muster wie V3-04); aus `/help` → „Tastenkürzel“
  geöffnet, endet der Fokus dort. Mit `useReturnFocus` (R4W-04) mitlösen.
- F2 (Hinweis): Das Slash-Menü nutzt aus `lib/fuzzy.ts` nur noch `fuzzyScore(query, text)`; eine
  Änderung von `fuzzyFilter` für den Quick-Switcher (V3-03) betrifft das Menü nicht, eine Änderung
  der Signatur von `fuzzyScore` schon.
- FLAKES: `ProfilesSettings.test.tsx › creates a new profile` scheiterte einmal im vollen
  `pnpm check` unter Last (Text „Profile “Private” saved.“ nicht gefunden, 22,5 s); isoliert und im
  Wiederholungslauf grün – an F3/`docs/wp/FLAKES.md` weitergeben.
