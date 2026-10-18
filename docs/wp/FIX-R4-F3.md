# FIX-R4-F3 – Profile, Neue Session, Einstellungen (Ergebnis)

> Fix-Paket F3 der Fix-Runde nach R4/V3 (`docs/wp/FIX-R4.md` §2). Worktree `.worktrees/fix-f3`,
> Branch `fix/r4-f3`, Basis `main` = `29f3256`. Grundlage: `docs/wp/R4-web.md`, `docs/wp/V3.md`,
> ADR-123/124/126, Contract-Changelog „R4 (K)“.

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
| **V3-01 Teil 2** lange Pfade sprengen die Dialoge | `NewSessionForm`: alle Raster mit `grid-cols-[minmax(0,1fr)]`, Projekt-Knöpfe `min-w-0` + Ellipse (`title` = voller Pfad); `FolderBrowser`: Brotkrumenleiste nach jedem Ordnerwechsel ans Ende gescrollt (`scrollLeft = scrollWidth`) | `FolderBrowser.test` „keeps the end of a long breadcrumb bar …“ (ohne Fix `scrollLeft` 0); Layout per Sichtprüfung (§3) |
| **V3-04** Fokus nach „Neue Session“ auf `body` | `NewSessionDialog` merkt sich beim Öffnen (`show`) das fokussierte Element und gibt ihm in `onCloseAutoFocus` den Fokus zurück (Muster `SettingsPage`, nicht `useReturnFocus` von F2); nach „Session anlegen“ weiter das Eingabefeld der neuen Session | `NewSessionDialog.test` „Esc and the close button give the focus back to the opener“ |
| **V3-06** Vorgaben überlaufen, Aktionsleiste | Vorgaben einspaltig (`max-w-sm`, `minmax(0,1fr)`), `OptionMenu`-Knopf `min-w-0` + Ellipse + `title`; Bereich „Profile“ ohne Innenabstand unten (`pb-0`), die klebende Aktionsleiste hat ihn selbst (`pb-4`) – kein Durchscheinen unter ihr | Sichtprüfung (§3) |
| V3-12 (WP-36/38) | `SettingField`: `<label for>` nur bei beschriftbarem Steuerelement (`labelFor`, Lautstärke `false`, nur-`below` ohne `for`); Profil-Editor: „Farbe“/„Programm“ als `span` mit `id` (Gruppen über `aria-labelledby`), kein `<label>` ohne Feld | `SettingsPage.test` „the volume label points at no element“, `ProfilesSettings.test` „labels …“ |
| V3-13 (WP-36/38) | DE: Standard-Badge „Standardprofil“ (Liste, Editor, Profilwahl) statt „Standard Standard“; „Kontextfenster (Tokens)“; Ereignis „Braucht Freigabe“ (EN „Needs permission“) wie der Status | `ProfilesSettings.test` „speaks German“, `SettingsPage.test` Ereignistabelle |
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

(folgt)

## 4. Checks

(folgt)

## 5. Live-Prüfpunkte für WP-41

- R4W-01: Profil ändern → „Allgemein“ → zurück (Entwurf da); Esc/X/Klick daneben → Rückfrage in Edge.
- R4W-17: Lautstärke mit gehaltener Pfeiltaste – ein Ton nach dem Loslassen, ein `settings.update`.
- V3-04: „Neue Session“ über den Sidebar-Knopf öffnen, Esc → Fokus auf dem Knopf.

## 6. Wünsche an den Koordinator

- **Doku (READMEs mit mehreren Ownern):** `src/web/shell/README.md` – neue Zeile `HostFacts.tsx`
  (Server-Infos, genutzt von `SettingsMenu.tsx` und `features/preferences`), bei `SettingsMenu.tsx`
  „`HostFacts`“ streichen bzw. auf `HostFacts.tsx` verweisen, „Anfrage bei offener Seite wechselt nur
  `section`“; `src/web/lib/README.md` – Zeile `zod-range.ts` (`numberRange(schema)`, R4W-21).
- Keine Contract-Änderung, keine neue Abhängigkeit.
