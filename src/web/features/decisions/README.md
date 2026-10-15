# src/web/features/decisions – Entscheidungen (WP-16)

Nicht-modale Entscheidungen (Plan „Plan-Modus & Plan-Freigabe“, Review A.6/A.10, ADR-012,
architecture §2.3e Variante A): angedockte Leiste über dem Composer, Permission-, Frage- und
Plan-Karten, Plan im Seitenpanel. Die Leiste ist die **einzige bedienbare** Instanz; nichts
stiehlt den Fokus, Tippen kann nie freigeben.

| Datei | Inhalt |
|---|---|
| `DecisionBar.tsx` | Slot `DecisionBar` (`memo`): älteste offene Entscheidung (bzw. die per „+n weitere“ gewählte), Fragesteller, `useDecisionFocusHandler` („Zur Entscheidung“), höfliche Ansage neuer Entscheidungen, Hinweis bei Auflösung in einem anderen Fenster, Fokus bleibt nach eigener Antwort in der Leiste |
| `DecisionCard.tsx` | Slot `DecisionCard` (`memo`): `placement: 'bar'` bedienbar, `'transcript'` lesend (Plantext, Status, „Zur Entscheidung“); offen + abgelaufen, nach Auflösung `null` |
| `PlanSidePanel.tsx` | Slot `SidePanel` (`memo`): ganzer Plan als Markdown (Slot `Markdown`), Esc/„Schließen“ gibt den Fokus an „Plan öffnen“ zurück, bleibt nach der Auflösung als Kopie lesbar |
| `components/card-shell.tsx` | Kartenrahmen + Antwort-Schutz: nur Klick oder `Mod+Enter` (Leiste fokussiert), Enter/Leertaste auf Antwort-Schaltflächen lösen nie aus (Hinweis per `aria-describedby`), Arm-Verzögerung `ARM_DELAY_MS` (600 ms) je neuer Karte (auch vom Composer genutzt, ADR-040), gesperrt während des Sendens/offline; `DecisionAction`, `DecisionArmDelayContext` |
| `components/PermissionCard.tsx` | Einmal / immer (Ziel session·local·project·user, project/user markiert) / + Edits automatisch / ablehnen; „▾“ öffnet nur Formulare (mit Begründung bzw. Begründung optional + Turn stoppen, R2W-05); `defaultToNo`, `suppressAlwaysAllowRule` (keine Ziele); Eingabe über `Disclosure` (`@web/ui`) |
| `components/QuestionCard.tsx` | AskUserQuestion: Optionen mit Beschreibung und Markdown-Vorschau, „Andere“ (bei Einfachauswahl schließt sie die Option aus, R2W-02), Notizen, Mehrfachauswahl; `buildQuestionAnswer` (Contract-Format) |
| `components/PlanCard.tsx`, `plan-parts.tsx` | „Plan vN bereit · [Umsetzen ▾] [Weiter planen] [Plan öffnen] · Kontext“; Split-Button (Auto / Edits automatisch / Manuell; Bypass rot; „mit frischem Kontext“ deaktiviert), letzte Wahl in `parallax.decisions.approveMode`; „Weiter planen“ mit fester Beschriftung (R2W-16); `OpenPlanButton` auch in der Transkript-Karte (nur mit gemountetem Panel) |
| `components/ExpiredCard.tsx` | Abgelaufen (ADR-016): read-only, „Fortsetzen“ (`session.resume`), Plan: „Fortsetzen & umsetzen“ |
| `components/TranscriptCard.tsx`, `QueueMenu.tsx`, `ChoiceMenu.tsx`, `RequesterLabel.tsx`, `DecisionView.tsx` | Lesende Karte, „+n weitere“, „▾“-Auswahl (wählt nur, antwortet nie), Fragesteller, Weiche je Art |
| `state/bar-store.ts` | Feature-State: angezeigte Entscheidung je Session, offenes/gemountetes Plan-Panel (`usePlanPanelMounted`), in diesem Fenster beantwortete Entscheidungen, gemerkte Umsetzen-Wahl |
| `lib/respond.ts` | `respondToDecision`, `resumeSession` (nur Absichten, Fehler als Notice) |
| `lib/plan.ts`, `lib/tool-input.ts`, `lib/outcomes.ts`, `lib/use-resolved-notices.ts` | Plantitel/-zusammenfassung, Modus-Reihenfolge; Input-Zusammenfassung; Outcomes aus `tool_call.decision`; Hinweise bei fremder Auflösung |
| `lib/demo-data.ts`, `lib/demo-host.ts`, `lib/demo-session.tsx`, `lib/testing.tsx` | Beispielsessions (aus `@shared/samples`), FakeHost-Runner, Playground-Rahmen, Test-Harness – nur Playground/Tests |
| `playground.tsx` | Demos `decisions/*` + `slots` (`DecisionBar`, `DecisionCard`, `SidePanel`) |
| `i18n/{en,de}.ts` | Namespace `decisions` |

Details, Entscheidungen und Schnittstellen: `docs/wp/WP-16.md`.
