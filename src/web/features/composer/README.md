# src/web/features/composer – Composer (WP-16)

Eingabe einer Session (Plan „Chat-Ansicht → Interaktion“, B „Tastatur“, „Entwürfe“, C.1, C.3).

| Datei | Inhalt |
|---|---|
| `Composer.tsx` | Slot `Composer` (`memo`): Enter sendet, Umschalt+Enter bricht um; während Claude arbeitet `priority: 'next'` (Warteschlange sichtbar), „Jetzt senden“ (`'now'`), Stopp + Esc bei leerem Feld (`useEscapeHandler` mit `scopeRef`); bei offener Entscheidung (die der Leiste) = Antwort: Freigabe ablehnen + Text, Frage überspringen + Text, Plan „Weiter planen mit Feedback“ (nie Freigabe); „Stattdessen als neue Nachricht senden“; `reportTyping()`; Senden nur bei offener Verbindung, Fehler stellen den Text wieder her |
| `ModePicker.tsx` | Tatsächlicher Modus (Summary `permissionMode`, sonst `detail.init`), Manuell / Edits automatisch / Plan / Auto, Bypass rot nur mit `allowsBypass`; `session.setPermissionMode`, kein optimistisches Label |
| `ModelPicker.tsx` | `detail.models` (sonst `session.refreshModels` beim Öffnen), `session.setModel` („Default“ → `null`), Aufwand (`session.setEffort`) bei `supportsEffort`, Fast-Schalter (`session.setFastMode`) bei `supportsFastMode` |
| `ContextGauge.tsx` | Prozent + Balken (Gauge-Primitive, 70 %/85 %), Klick: Fakten + Aufschlüsselung (`session.getContext`), „Jetzt komprimieren“ sendet `/compact` |
| `components/QueueList.tsx` | Eingereihte Nachrichten (`detail.queue` + lokal „wird gesendet“) |
| `state/drafts.ts` | Entwürfe je Session (`parallax.composer.draft.<sessionKey>`, bei jeder Änderung geschrieben) |
| `state/focus.ts` | `requestComposerFocus` (nur nach Nutzeraktion, z. B. „Weiter planen“) |
| `lib/commands.ts` | `sendPrompt`, `interruptSession`, `answerFromText`, `textLimit` |
| `playground.tsx` | Demos `composer/*` (mit simulierter Warteschlange) + `slots` (`Composer`) |
| `i18n/{en,de}.ts` | Namespace `composer` |

Details: `docs/wp/WP-16.md`.
