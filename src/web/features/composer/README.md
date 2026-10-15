# src/web/features/composer – Composer (WP-16)

Eingabe einer Session (Plan „Chat-Ansicht → Interaktion“, B „Tastatur“, „Entwürfe“, C.1, C.3).

| Datei | Inhalt |
|---|---|
| `Composer.tsx` | Slot `Composer` (`memo`): Enter sendet, Umschalt+Enter bricht um; während Claude arbeitet `priority: 'next'` (die Warteschlange zeigen Transkript + Kopfzeilen-Badge, ADR-041), „Jetzt senden“ (`'now'`), Stopp + Esc bei leerem Feld (`useEscapeHandler` mit `scopeRef`); **Ziel-Sperre** (ADR-040): Enter beantwortet die offene Entscheidung der Leiste nur, wenn sie beim ersten Zeichen des Entwurfs schon ≥ Arm-Verzögerung angezeigt war und vom Haupt-Agent stammt (bzw. per „Weiter planen“ gewählt wurde) – Freigabe ablehnen + Text, eine Frage beantworten (Text als „Andere“), mehrere Fragen überspringen + Text, Plan „Weiter planen mit Feedback“ (nie Freigabe); sonst sendet Enter normal und „Als Antwort senden“ ist der explizite Weg; „Stattdessen als neue Nachricht senden“; Zeichenzähler ab 80 % des Limits; `reportTyping()`; Senden nur bei offener Verbindung, Fehler stellen Text (und Ziel) wieder her |
| `ModePicker.tsx` | Tatsächlicher Modus (Summary `permissionMode`, sonst `detail.init`), Labels `shell.permissionMode.*` (Manuell / Edits automatisch / Plan / Auto, ADR-043), Bypass rot nur mit `allowsBypass`; `session.setPermissionMode`, kein optimistisches Label |
| `ModelPicker.tsx` | `detail.models` (sonst `session.refreshModels` beim Öffnen), `session.setModel` („Default“ → `null`), Aufwand (`session.setEffort`) bei `supportsEffort`, Fast-Schalter (`session.setFastMode`) bei `supportsFastMode` |
| `ContextGauge.tsx` | Prozent + Balken (Gauge-Primitive, 70 %/85 %), Klick: Fakten + Aufschlüsselung (`session.getContext`), „Jetzt komprimieren“ sendet `/compact` |
| `state/drafts.ts` | Entwürfe je Session (`parallax.composer.draft.<sessionKey>`, bei jeder Änderung geschrieben) |
| `state/focus.ts` | `requestComposerFocus(sessionKey, decisionId?)` (nur nach Nutzeraktion, z. B. „Weiter planen“ – mit `decisionId` wird sie das Enter-Ziel) |
| `lib/commands.ts` | `sendPrompt`, `interruptSession`, `answerFromText`, `textLimit` (`LIMITS.*`), `isSingleQuestion` |
| `playground.tsx` | Demos `composer/*` (mit simulierter Warteschlange, `late-decision` für die Ziel-Sperre) + `slots` (`Composer`) |
| `i18n/{en,de}.ts` | Namespace `composer` |

Details: `docs/wp/WP-16.md`.
