# src/web/features/decisions – Entscheidungen (WP-16, Plan-Komfort WP-56)

Nicht-modale Entscheidungen (Plan „Plan-Modus & Plan-Freigabe“, Review A.6/A.10, ADR-012,
architecture §2.3e Variante A): angedockte Leiste über dem Composer, Permission-, Frage- und
Plan-Karten, Plan im Seitenpanel. Die Leiste ist die **einzige bedienbare** Instanz; nichts
stiehlt den Fokus, Tippen kann nie freigeben.

| Datei | Inhalt |
|---|---|
| `DecisionBar.tsx` | Slot `DecisionBar` (`memo`): älteste offene Entscheidung (bzw. die per „+n weitere“ gewählte), Fragesteller, `useDecisionFocusHandler` („Zur Entscheidung“), höfliche Ansage neuer Entscheidungen, Hinweis bei Auflösung in einem anderen Fenster, Fokus bleibt nach eigener Antwort in der Leiste; Startfehler eines frischen Kontexts nach dem Schließen der Karte als Notice (WP-56) |
| `DecisionCard.tsx` | Slot `DecisionCard` (`memo`): `placement: 'bar'` bedienbar, `'transcript'` lesend (Plantext, Status, „Zur Entscheidung“); offen + abgelaufen, nach Auflösung `null` |
| `PlanSidePanel.tsx` | Slot `PlanPanel` (`memo`): dünner Wrapper, lädt `components/PlanPanel` als eigenen Chunk (Skeleton als Fallback); Rahmen, Esc/„Schließen“ und Fokus-Rückgabe übernimmt der Panel-Host `@web/shell/side-panel` (ADR-150) |
| `components/PlanPanel.tsx` | Tab „Plan“ (WP-56, ADR-148): Versionswahl (`plan.list`, neueste zuerst, Status je Version), Ansicht „Plan“ / „Änderungen zu v(n−1)“ (lazy `PlanDiff`), Plan-Datei live während eines `Write` (aus `inputPartial`), danach per `GET /api/file` (nach jedem fertigen Write/Edit neu; Fallback: Plan der Entscheidung), `FileLink`, „Zur Entscheidung“, Leerzustand „Noch kein Plan“; bleibt nach der Freigabe nutzbar |
| `components/PlanDiff.tsx` | Zeilen-Diff zweier Planstände (`@web/lib/diff`, `ui/diff-view`), eigener Chunk |
| `components/card-shell.tsx` | Kartenrahmen + Antwort-Schutz: nur Klick oder `Mod+Enter` (Leiste fokussiert), Enter/Leertaste auf Antwort-Schaltflächen lösen nie aus (Hinweis per `aria-describedby`), Arm-Verzögerung `ARM_DELAY_MS` (600 ms) je neuer Karte (auch vom Composer genutzt, ADR-040), gesperrt während des Sendens/offline; `DecisionAction`, `DecisionArmDelayContext` |
| `components/PermissionCard.tsx` | Einmal / immer (Ziel session·local·project·user, project/user markiert) / + Edits automatisch / ablehnen; „▾“ öffnet nur Formulare (mit Begründung bzw. Begründung optional + Turn stoppen, R2W-05); `defaultToNo`, `suppressAlwaysAllowRule` (keine Ziele); Eingabe über `Disclosure` (`@web/ui`) |
| `components/QuestionCard.tsx` | AskUserQuestion: Optionen mit Beschreibung und Markdown-Vorschau, „Andere“ (bei Einfachauswahl schließt sie die Option aus, R2W-02), Notizen, Mehrfachauswahl; mehrere Fragen als Tabs (`@web/ui/tabs`: Header als Tab-Name, Häkchen sobald beantwortet, „Nächste Frage“ fokussiert den nächsten Tab; Entwürfe bleiben beim Wechsel; Tabs antworten nie); `buildQuestionAnswer` (Contract-Format) |
| `components/PlanCard.tsx`, `plan-parts.tsx` | „Plan vN bereit · [Umsetzen ▾] [Weiter planen] [Plan öffnen] · Kontext“; Split-Button (Auto / Edits automatisch / Manuell; Bypass rot) mit Umschalter „Mit frischem Kontext“ (`approve_fresh_context`, ab 60 % Kontext „Empfohlen“ + Punkt am ▾, nie vorausgewählt; Fehler in der Karte als `Alert role="alert"`), letzte Wahl in `parallax.decisions.approveMode` + `parallax.decisions.approveFresh` (Bypass nie); „Weiter planen“ mit fester Beschriftung (R2W-16); `OpenPlanButton` öffnet/schließt den Tab per Anfrage `sidePanel`, auch in der Transkript-Karte (nur mit gemountetem Panel-Host, sonst inline) |
| `components/ExpiredCard.tsx` | Abgelaufen (ADR-016): read-only, „Fortsetzen“ (`session.resume`), Plan: „Fortsetzen & umsetzen“ (auch mit frischem Kontext) |
| `components/TranscriptCard.tsx`, `QueueMenu.tsx`, `ChoiceMenu.tsx`, `RequesterLabel.tsx`, `DecisionView.tsx` | Lesende Karte, „+n weitere“, „▾“-Auswahl (wählt nur, antwortet nie; Umschalter `toggles`, Markierung `indicator`), Fragesteller, Weiche je Art |
| `state/bar-store.ts` | Feature-State: angezeigte Entscheidung je Session, Plan im Panel (`setPanelPlan`/`usePlanPanel`) und gewählte Panel-Ansicht (`choosePlanView`), Fehler eines frischen Starts je Session, in diesem Fenster beantwortete Entscheidungen, gemerkte Umsetzen-Wahl; offener Tab und gemounteter Host liegen in `@web/shell/side-panel/state` |
| `state/plan-data.ts` | Daten des Plan-Tabs: `plan.list`, `plan.read` (Cache, unveränderlich je Version), Plan-Datei über `GET /api/file` (Naht `setPlanFileReader` für Playground/Tests), Plan-Datei-Aufrufe des Transkripts |
| `lib/respond.ts` | `respondToDecision` (Fehler als Notice), `respondInCard` (Fehler für die Karte), `failsBeforeResolving`, `resumeSession` (nur Absichten) |
| `lib/plan.ts`, `lib/tool-input.ts`, `lib/outcomes.ts`, `lib/use-resolved-notices.ts` | Plantitel/-zusammenfassung, Modus-Reihenfolge, Schwelle „frischer Kontext empfohlen“; Input-Zusammenfassung; Outcomes aus `tool_call.decision`; Hinweise bei fremder Auflösung |
| `lib/partial-json.ts`, `lib/plan-file.ts`, `lib/plan-versions.ts` | Rein: toleranter Leser eines Strings aus gestreamtem JSON; Plan-Datei-Regel (bekannter Pfad bzw. `.md` im Plan-Modus) und Live-Text; Versionen zusammenführen, Status-Texte, automatische Ansicht |
| `lib/demo-data.ts`, `lib/demo-host.ts`, `lib/demo-plan.ts`, `lib/demo-session.tsx`, `lib/testing.tsx` | Beispielsessions (aus `@shared/samples`, mit Plan-Versionen und Plan-Dateien), FakeHost-Runner (`plan.list`/`plan.read` je Entry, Plan-Dateien), gestreamter Plan-Write und Plan-Freigabe, Playground-Rahmen, Test-Harness – nur Playground/Tests |
| `playground.tsx` | Demos `decisions/*` (u. a. `plan-live`, `plan-versions`, `plan-approved(-fresh)`, `plan-fresh`, `plan-fresh-errors`) + `slots` (`DecisionBar`, `DecisionCard`, `PlanPanel`) |
| `i18n/{en,de}.ts` | Namespace `decisions` |

Details, Entscheidungen und Schnittstellen: `docs/wp/WP-16.md`, Plan-Komfort `docs/wp/WP-56.md`.
