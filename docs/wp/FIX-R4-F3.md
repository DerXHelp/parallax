# FIX-R4-F3 – Profile, Neue Session, Einstellungen (Ergebnis)

> Fix-Paket F3 der Fix-Runde nach R4/V3 (`docs/wp/FIX-R4.md` §2). Worktree `.worktrees/fix-f3`,
> Branch `fix/r4-f3`, Basis `main` = `29f3256`. Grundlage: `docs/wp/R4-web.md`, `docs/wp/V3.md`,
> ADR-123/124/126, Contract-Changelog „R4 (K)“. Commits: `be83921` (Fixes + Tests), `508c81b`
> (Nachträge aus der Sichtprüfung, instabiler Test), danach dieses Ergebnis.

## 1. Befunde

### Behoben

| Befund | Fix | Test (Gegenprobe) |
|---|---|---|
| **R4W-01 a** Profil-Entwurf geht beim Bereichswechsel verloren | `SettingsPage`: Bereich „Profile“ bleibt nach dem ersten Besuch montiert (`forceMount` + `hidden={current !== 'profiles'}`); Punkt + Screenreader-Text „ungespeicherte Änderungen“ am Reiter, solange der Editor `dirty` meldet | `SettingsPage.test` „a draft survives switching sections“ (ohne `forceMount`: Feld leer) |
| **R4W-01 b** Schließen ohne Rückfrage | `onDirtyChange` des Slots → `profilesDirty`; `onOpenChange(false)` (Esc, X, Klick daneben) zeigt bei `dirty` eine Inline-Rückfrage oben im Dialog („Weiter bearbeiten“ mit Fokus, „Verwerfen und schließen“); Esc während der Frage = weiter bearbeiten; „Weiter bearbeiten“ wechselt zu „Profile“ und fokussiert das verlassene Feld (sonst den Reiter) | `SettingsPage.test` „Esc … asks inline …“, „the close button and a click outside ask …“, „without unsaved changes nothing asks“ |
| **R4W-01 c** neue `settings`-Anfrage montiert neu | `SettingsPageHost` (`SettingsMenu.tsx`) ohne `key={serial}`, ändert nur `section` (ohne Bereich bleibt der gezeigte); die Seite registriert zusätzlich selbst einen `settings`-Handler (neuester gewinnt) und wechselt nur den Bereich – auch zum selben Bereich erneut | `SettingsMenu.test` „… changes only the section – no new page“ (mit `key`: zweimal montiert), `SettingsPage.test` „a settings request while open …“ |
| R4W-09 (Web) Secret-Regel doppelt | `EnvTable` nutzt `isSecretEnvKey` aus `@shared/secrets`; `features/profiles/lib/secrets.ts` gelöscht, Test der Kopie entfernt; Hinweistext `profiles.fields.envHint` (en/de) nennt die neue Regel | `components/EnvTable.test.tsx` (8 Namen; `AWS_BEARER_TOKEN_BEDROCK`, `GH_TOKEN_CI`, `ANTHROPIC_CUSTOM_HEADERS`, `DB_CREDENTIALS` maskiert – mit der alten Kopie rot) |
| R4W-16 Fehleranzeige verschwindet / geht nach dem Schließen verloren | `settings-editor.ts`: Fehler mit den abgelehnten Top-Level-Feldern; ein späterer Erfolg eines **anderen** Felds lässt ihn stehen, erst ein Erfolg desselben Felds oder „Ausblenden“ entfernt ihn; Ablehnung nach dem Unmount → `showTextNotice('settings.saveFailed')` | `state/settings-editor.test.ts` (3, mit zurückgehaltenen `updateSettings`), `SettingsPage.test` „the error stays when another field saves fine …“ |
| R4W-17 Lautstärke per Tastatur | `VolumeSlider`: Zeiger speichert bei `onValueCommit`, Tastatur 300 ms nach der letzten Taste (`VOLUME_KEY_COMMIT_MS`), dann einmal Vorhören; beim Schließen innerhalb der 300 ms wird ohne Ton gespeichert. `ui/slider.tsx`: Doku zu `onValueCommit` je Taste | `SettingsPage.test` „keyboard steps … saved and played once“ (5× → ein Patch 0.65, ein Ton; ohne Fix fünf Patches) |
| R4W-18 „Fenster öffnen“ ohne Begründung | `ServerSection`: `disabledReason` – ohne Systemintegration der vorhandene Text, sonst neu `preferences.server.openWindowNeedsAutostart` | `SettingsPage.test` „autostart is disabled …“ (beide Schalter `aria-describedby` → Grund), „… needs autostart …“ |
| R4W-21 Duplikate | `DEFAULT_PORT` aus `@shared/model` (Konstante in `preferences/lib/limits.ts` entfernt); Env-Namensregel über `profileInputSchema.shape.env.keyType` statt eigener Regex; neue `src/web/lib/zod-range.ts` (`numberRange`) für `preferences/lib/limits.ts` und `profiles/lib/draft.ts` | `lib/zod-range.test.ts`, `profiles/lib/lib.test.ts` „checks env names with the rule of the contract“ |
| R4W-22 (optional) `HostFacts` in `SettingsMenu.tsx` | neue Datei `src/web/shell/HostFacts.tsx` (`HostFacts` + `ClaudeInfo`); `SettingsMenu` und `AboutSection` importieren von dort | bestehende Tests (`SettingsPage.test` „About …“) |
| R4W-23 toter Export | `isProfileUsable` entfernt (`profileErrors(...).length === 0` ist die Regel, Doku am Helfer) | – (tsc/lint) |
| R4W-24 Autofokus auf destruktiver Aktion | Fokus auf „Abbrechen“ (Löschen) bzw. „Weiter bearbeiten“ (Verwerfen, Schließen der Seite); „Abbrechen“ gibt den Fokus an „Löschen…“ zurück | `ProfilesSettings.test` „deletes … after asking“ (Enter auf dem Fokus löscht nicht), „asks before leaving …“ |
| **V3-01 Teil 2** lange Pfade sprengen die Dialoge | `NewSessionForm`: alle Raster mit `grid-cols-[minmax(0,1fr)]`; Projekt-Knöpfe `min-w-0`, der Elternteil des Pfads weicht zuerst (Ellipse), der Ordnername bleibt sichtbar, solange er passt (`title` = voller Pfad, zugänglicher Name = Kurzpfad als `sr-only`); `FolderBrowser`: Brotkrumenleiste nach jedem Ordner- und Sprachwechsel ans Ende gescrollt (`scrollLeft = scrollWidth`); Demo-Ordnerbaum/Playground mit langem Pfad | `FolderBrowser.test` „keeps the end of a long breadcrumb bar …“ (ohne Fix `scrollLeft` 0); Layout per Sichtprüfung (§3) |
| **V3-04** Fokus nach „Neue Session“ auf `body` | `NewSessionDialog` merkt sich beim Öffnen (`show`) das fokussierte Element und gibt ihm in `onCloseAutoFocus` den Fokus zurück (Muster `SettingsPage`, nicht `useReturnFocus` von F2); nach „Session anlegen“ weiter das Eingabefeld der neuen Session | `NewSessionDialog.test` „Esc and the close button give the focus back to the opener“ |
| **V3-06** Vorgaben überlaufen, Aktionsleiste | Vorgaben einspaltig (`max-w-sm`, `minmax(0,1fr)`), `OptionMenu`-Knopf `min-w-0` + Ellipse + `title`; Bereich „Profile“ ohne Innenabstand unten (`pb-0`), die klebende Aktionsleiste hat ihn selbst (`pb-4`) – kein Durchscheinen unter ihr | Sichtprüfung (§3) |
| V3-12 (WP-36/38) | `SettingField`: `<label for>` nur bei beschriftbarem Steuerelement (`labelFor`, Lautstärke `false`, nur-`below` ohne `for`); Profil-Editor: „Farbe“/„Programm“ als `span` mit `id` (Gruppen über `aria-labelledby`), kein `<label>` ohne Feld | `SettingsPage.test` „the volume label points at no element“, `ProfilesSettings.test` „labels …“ |
| V3-13 (WP-36/38) | DE: Standard-Badge „Standardprofil“ (Liste, Editor, Profilwahl) statt „Standard Standard“; „Kontextfenster (Tokens)“; Ereignis „Braucht Freigabe“ wie der Status (EN „Permission needed“ bleibt – E2E `phase2-settings.spec.ts:44` hängt daran) | `ProfilesSettings.test` „speaks German“ |
| Koordinator-Nachtrag: instabiler Test „creates a new profile …“ (`ProfilesSettings.test`, Fund von F4 im vollen `pnpm check`) | Ursache wie V3-08: unter Last läuft die Live-Prüfung (400 ms) zwischen „--add-dir“ und seinem Wert; „--add-dir“ allein ist ein Fehler und sperrt „Speichern“, der Klick auf den gesperrten Knopf geht verloren. Der Test wartet jetzt vor dem Klick auf die Prüfung des ganzen Werts und einen freien Knopf (Bedingung, keine feste Wartezeit, Zeitlimits unverändert) | isoliert und im vollen `pnpm check` grün (§4) |
| V3-14 (WP-36) | Testergebnis bzw. Aktionsfehler per `scrollIntoView({block:'nearest'})` in Sicht; nach Speichern/Löschen/Standard Fokus auf den Hinweis (`tabIndex=-1`), nach Verwerfen auf die gewählte Zeile; ein unberührtes neues Profil gilt nicht als „ungespeichert“ (kein Nachfragen beim Wechsel/Schließen) | `ProfilesSettings.test` „tests a profile …“, „creates a new profile …“, „deletes …“, „an untouched new profile …“ |

### Zurückgestellt

| Befund | Grund |
|---|---|
| R4W-01 „Rückfrage bei neuer `settings`-Anfrage“ | entfällt: eine Anfrage bei offener Seite wechselt nur den Bereich, der Entwurf bleibt montiert – nichts geht verloren, also nichts zu fragen |
| V3-13 „Arbeitsverzeichnis/Arbeitsordner“, „1 more idle session …“, Rate-Limit-Kennung | nicht F3 (F2/F4 bzw. WP-21) |
| V3-12 Radix-Hilfsinputs („form field without id or name“) | Radix-intern (versteckte `input` der Radio-/Switch-Gruppen); kein Eingriff in `ui/*` dieser Runde |
| R4W-19 `lazy()` | F5 (`App.tsx`) laut FIX-R4 §2 |

## 2. Entscheidungen

1. **Schließ-Schutz in `onOpenChange`** statt einzelner `preventDefault` je Ereignis: Radix meldet Esc, X
   und Klick daneben gleichermaßen als `onOpenChange(false)`; nur Esc während der Frage wird per
   `onEscapeKeyDown` abgefangen (= weiter bearbeiten). Verschachtelte Ebenen (Menüs, Ordner-Browser)
   schließen wie bisher nur sich selbst.
2. **„ungespeichert“ = Entwurf weicht vom Start ab** (`changed`); „Speichern“ bleibt für neue Profile
   frei (`dirty`). Ein unberührtes neues Profil löst weder die Wechsel- noch die Schließ-Frage aus.
3. **Profile-Bereich lazy, dann gehalten:** montiert erst beim ersten Besuch (kein `profile.get` beim
   Öffnen auf „Allgemein“), danach `forceMount` + `hidden`.

## 3. Sichtprüfung

Vite (`PARALLAX_DEV_WEB_PORT=5186`, `pnpm dev:web`), Playground im MCP-Browser, Messung per Skript
(`scrollWidth`/`clientWidth`, Knopfpositionen). Screenshots in
`%TEMP%\claude\parallax-fix-f3\shots\` (Schema `<ansicht>__<theme>-<sprache>__<viewport>.png`).

- **Neue Session mit langem Pfad** (`profiles/new-session`, neuer Eintrag `…\beta-mit-einem-sehr-langen-…`):
  1280×800 dark-en/light-de und 900×700 dark-de – Dialog `scrollWidth` = `clientWidth` (510), „Durchsuchen…“
  und „Session anlegen“ im Dialog; Projekt-Knopf zeigt den Ordnernamen mit Ellipse
  (`new-session-longpath(-chosen)__…`).
- **Ordner-Browser im langen Pfad**: 574 = 574, Titel und „Diesen Ordner wählen“ ganz sichtbar,
  Brotkrumen am Ende (`scrollLeft` = `scrollWidth − clientWidth`, auch nach Sprachwechsel)
  (`folder-browser-longpath__dark-en|light-de__1280x800`, `…__dark-de__900x700`).
- **Profil-Editor „Vorgaben für neue Sessions“** (`profiles/settings-page`): einspaltig, „Nicht gesetzt –
  Claude Code entscheidet“ ungekürzt (251 px bzw. 190 px Text ohne Abschneiden), Panel ohne horizontales
  Scrollen (564 = 564); klebende Aktionsleiste endet bündig am Panelrand (735,2 = 735,2), nichts scheint
  darunter durch (`profile-editor-defaults(-notset)__dark-de__1280x800`, `…__light-en__900x700`).
- **Rückfrage beim Schließen** (R4W-01): Name eingeben → „Allgemein“ (Punkt am Reiter „Profile“) → Esc →
  Inline-Frage, Fokus „Weiter bearbeiten“ → Enter → „Profile“ gewählt, Entwurf da; Esc im Feld → Frage →
  „Weiter bearbeiten“ → Fokus zurück im Feld; X → Frage (`settings-general-unsaved-profile__dark-de__…`,
  `settings-close-confirm__dark-de|light-en__1280x800`).
- **Deaktivierte Schalter** (V3-10/R4W-18): ohne Integration beide Schalter mit Begründung, „Fenster
  öffnen“ an + deaktiviert in neutraler Spur (Fix K); mit Integration und Autostart aus: „Nur, solange …“
  (`settings-server-disabled__light-en|dark-de__…`, `settings-server-autostart-off__dark-de|light-en__…`).
- **Barrierefreiheit**: auf allen sechs Bereichen keine `<label for>` ohne beschriftbares Ziel; DevTools-Issue
  „Incorrect use of `<label for>`“ weg; im Profil-Editor kein `<label>` ohne Feld. Verbleibend nur die
  Radix-Hilfsinputs („form field without id or name“, „No label associated“, zurückgestellt).
- „Profil testen“: Ergebnis nach dem Klick im sichtbaren Bereich (Unterkante 799,9 von 800).

Aufgeräumt: Vite per PID beendet (`taskkill /PID 31620 /T /F`, Port 5186 frei, kein `node` mit
`fix-f3`), MCP-Tab auf `about:blank`, Emulation zurückgesetzt.

## 4. Checks

- **Gegenprobe:** die Produktionsdateien von `main` (`29f3256`) mit den neuen Tests: 25 neue bzw.
  angepasste Tests rot (R4W-01 a/b/c, -09, -16, -17, -18, -24, V3-01, V3-04, V3-12, V3-14), grün blieben
  nur verhaltensneutrale (Env-Namensregel R4W-21, „without unsaved changes nothing asks“). Danach HEAD
  wiederhergestellt.
- Eigene Pfade: `pnpm exec tsc -b` grün, `pnpm exec eslint <eigene Pfade> --max-warnings=0` grün,
  `pnpm exec vitest run <eigene Pfade>` 15 Dateien / 119 Tests grün (vor Stufe 2), nach Stufe 2 10 Dateien /
  73 Tests (Profile, Neue Session) grün.
- Voll (Stand `508c81b`, parallel zu F1/F2/F4): `pnpm check` grün – typecheck, lint, **203 Dateien /
  3565 Tests**; `pnpm build` grün (`index-*.js` 427 604 B; `lazy()` ist F5, R4W-19).

## 5. Live-Prüfpunkte für WP-41

- R4W-01: Profil ändern → „Allgemein“ → zurück (Entwurf da); Esc/X/Klick daneben → Rückfrage in Edge.
- R4W-17: Lautstärke mit gehaltener Pfeiltaste – ein Ton nach dem Loslassen, ein `settings.update`.
- V3-04: „Neue Session“ über den Sidebar-Knopf öffnen, Esc → Fokus auf dem Knopf.

## 6. Hinweise für F5 (E2E nach dem Merge)

- Neue Fälle laut FIX-R4 §2: Entwurf übersteht den Bereichswechsel (`[role=tab][data-section=…]`, Punkt
  `[data-unsaved="true"]` am Reiter „Profile“), Esc mit Entwurf zeigt `[data-slot="settings-close-confirm"]`
  (`[data-action="settings-keep-editing"]`, `[data-action="settings-discard-close"]`).
- `phase2-new-session.spec.ts` bleibt gültig: nach „Speichern“/„Als Standard“ ist der Editor sauber, Esc
  schließt ohne Frage; der Fokus liegt danach auf dem Hinweis (`[data-slot="profile-notice"]`).
- EN-Text „Permission needed“ unverändert (Selektor `phase2-settings.spec.ts:44`).

## 7. Wünsche an den Koordinator

- **Doku (READMEs mit mehreren Ownern):** `src/web/shell/README.md` – neue Zeile `HostFacts.tsx`
  (Server-Infos, genutzt von `SettingsMenu.tsx` und `features/preferences`), bei `SettingsMenu.tsx`
  „`HostFacts`“ streichen bzw. auf `HostFacts.tsx` verweisen, „Anfrage bei offener Seite wechselt nur
  `section`“; `src/web/lib/README.md` – Zeile `zod-range.ts` (`numberRange(schema)`, R4W-21).
- Keine Contract-Änderung, keine neue Abhängigkeit.
