# src/web/features/profiles – Profil-Editor (Phase 2)

Owner: **WP-36**. Auftrag und Ergebnis: `docs/wp/WP-36.md`.

Profilliste und Editor (Name, Farbe, executable, `configDir`, Env mit Maskierung, Args mit
Befunden je Zeile, `contextWindow`, Vorgaben), „Als Standard“, „Profil testen“, Löschschutz – über
die Host-Befehle `profile.*` (ADR-101, ADR-102). Die Einstellungsseite (WP-38) rendert ihn über den
Slot `ProfilesSettings` (`src/web/shell/slots.tsx`); WP-40 setzt den Slot in `App.tsx`.

| Pfad | Inhalt |
| --- | --- |
| `index.ts` | exportiert `ProfilesSettings` (Slot) |
| `ProfilesSettings.tsx` | Bereich „Profile“: Liste links, Editor rechts (schmal: untereinander), Rückfrage bei ungespeicherten Änderungen, Hinweise nach Speichern/Löschen/Standard |
| `components/ProfileList.tsx` | Liste (Farbe, Name, Standard/Eingebaut, Claude-Code-Zustand, Sessions, Befunde), „Neues Profil“ |
| `components/ProfileEditor.tsx` | `SavedProfileEditor` (lädt per `profile.get`), `NewProfileEditor`; Live-Prüfung `profile.validate` (400 ms), Speichern, Standard, Testen, Löschen mit Rückfrage |
| `components/{ColorPicker,EnvTable,ArgList,OptionMenu,FieldNotes,TestResult}.tsx` | Bausteine des Editors |
| `lib/draft.ts` | Arbeitskopie (`ProfileDraft`) ↔ `ProfileInput` (`buildInput`, zod an der Grenze), Grenzen aus `profileInputSchema`, `placeIssues` (Befunde an Feld/Zeile), `draftKey`, `configDirChanged` |
| `lib/secrets.ts` | `isSecretEnvKey` (gleiche Regel wie der Server) |
| `lib/demo-host.ts` | nur Tests/Playground: `FakeProfileServer` (`profile.*`), Demo-Profile, `startProfilesDemo` |
| `playground.tsx` | Demos: Dialog (mit/ohne Vorbelegung), Ordner-Browser, Editor; Slot `ProfilesSettings` für die Einstellungsseite des Playgrounds (Test: `playground.test.tsx`) |
| `i18n/{en,de}.ts` | Namensraum `profiles` (registriert in `src/web/i18n/index.ts`) |

Importgrenzen: kein Import aus anderen Features (ESLint), Store nur über `@web/state/hooks`;
Shell-Bausteine (`FolderBrowser`, `profile-status`, `profile-issues`) aus `src/web/shell/new-session`.
