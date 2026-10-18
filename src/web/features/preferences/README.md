# src/web/features/preferences – Einstellungsseite (Phase 2)

Owner: **WP-38**. Auftrag und Ergebnis: `docs/wp/WP-38.md`.

Die Einstellungsseite als Slot `SettingsPage` (`src/web/shell/slots.tsx`): ein großer Dialog
(modal erlaubt – Sessions laufen weiter, Esc schließt) mit den Bereichen links (vertikale Tabs,
Pfeiltasten) und dem gewählten Bereich rechts. Geöffnet über die Shell-Anfrage
`{kind: 'settings', section?}` (`src/web/shell/requests.ts`), deren Handler `SettingsMenu.tsx`
registriert (Menüeintrag „Einstellungen…“). Jede Änderung geht sofort per `settings.update` mit dem
ganzen Top-Level-Feld an den Server; Töne und ihre Zustellung liegen in `src/web/notifications/`.

| Pfad | Inhalt |
| --- | --- |
| `index.ts` | `SettingsPage`, `PREFERENCES_SLOTS` (für `App.tsx`, WP-40) |
| `SettingsPage.tsx` | Dialog, Bereiche (`SETTINGS_SECTIONS`), Start-Bereich aus der Anfrage; bei offener Seite wechselt eine `settings`-Anfrage nur den Bereich (eigener Handler, kein Neumontieren); „Profile“ bleibt nach dem ersten Besuch montiert (`forceMount` + `hidden`), Punkt am Reiter bei ungespeicherten Änderungen; Schließen (Esc, X, Klick daneben) mit ungespeichertem Profil fragt inline (R4W-01); Speicherfehler im Dialog (`role="alert"`, „Ausblenden“), Fokus zurück an die Stelle vor dem Öffnen |
| `sections/GeneralSection.tsx` | Sprache, Design (Radiogruppen; Namen aus dem Shell-Namensraum `settings`) |
| `sections/NotificationsSection.tsx` | Tabelle über `NOTIFICATION_KINDS` (Toast, Ton, Klang, Anhören), Lautstärke (`ui/slider.tsx`; Zeiger: bei `onValueCommit`, Tastatur: 300 ms nach der letzten Taste, R4W-17), „Nicht stören“, Fokus-Regel, Fertig-Schwelle, „Klick öffnet die Session“ (ohne `systemIntegration` deaktiviert mit Begründung), Warnung `PROTOCOL_HANDLER_FAILED` |
| `sections/SessionsSection.tsx` | Leerlauf-Schlaf (an/aus, Minuten), Prompt-Vorschläge |
| `sections/ServerSection.tsx` | Port (leer = `DEFAULT_PORT` aus `@shared/model`, aktueller Port aus `HostState.port`), Autostart + „Fenster öffnen“ (deaktiviert mit Begründung: ohne `systemIntegration` bzw. ohne Autostart, R4W-18), Warnung `AUTOSTART_FAILED` |
| `sections/AboutSection.tsx` | Server-Infos über `HostFacts` aus `shell/HostFacts.tsx` (eine Quelle, auch im Einstellungsmenü) |
| `components/SettingField.tsx` | Zeile: Label (`for` nur bei beschriftbarem Steuerelement, `labelFor`), Beschreibung, Begründung „deaktiviert“, Steuerelement (`aria-describedby` per Render-Prop), `SettingList` |
| `components/NumberField.tsx` | Ganzzahl-Feld: speichert bei Enter/Verlassen, ungültig → Fehler am Feld (`aria-invalid`), nichts gesendet |
| `components/HostWarnings.tsx` | Host-Warnungen bestimmter Codes neben ihrer Einstellung |
| `state/settings-editor.ts` | `useSettingsEditor()`: gespeicherte Settings + noch unbestätigte Änderungen (Schalter bewegen sich sofort, zweite Änderung baut auf der ersten auf), Rücknahme + `error` bei Ablehnung; der Fehler bleibt, bis das Feld gespeichert oder ausgeblendet ist; nach dem Schließen geht er in die Hinweis-Region (R4W-16) |
| `lib/limits.ts` | Grenzen aus den zod-Schemas über `numberRange` (`src/web/lib/zod-range.ts`): `IDLE_MINUTES`, `DONE_SECONDS`, `PORT_RANGE`; `parseWholeNumber` |
| `playground.tsx` | Demos je Bereich (mit/ohne Systemintegration, mit Warnungen), Ton-Vorhören; `slots` für die Shell-Demos |
| `i18n/{en,de}.ts` | Namensraum `preferences` (auch der Menüeintrag, Ton-Namen und der Hinweis „Töne aktivieren“) |

Importgrenzen: kein Import aus anderen Features (ESLint), Store nur über `@web/state/*`-Hooks; den
Profil-Editor liefert WP-36 über den Slot `ProfilesSettings`.
