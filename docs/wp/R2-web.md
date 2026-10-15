# R2 – Review Web-Pakete WP-15 (Transkript) und WP-16 (Entscheidungen + Composer)

**Stand:** 15.10.2026, `main` nach `7380153` (WP-13a, WP-15, WP-16 gemergt) · **Rolle:** read-only
Review (nur diese Datei geändert) · **Schwerpunkt:** Kernfeature nicht-modale Entscheidungen
(Plan „Plan-Modus & Plan-Freigabe“), Sicherheit der Renderer, Render-/Speicherverhalten, Duplikate
zwischen WP-15 und WP-16, Bereitschaft für WP-20. Der Server-Teil von R2 folgt nach WP-13b.

Schweregrade: **[BLOCKER vor WP-20]** – vor der Verdrahtung beheben/klären · **[SOLLTE]** – vor
WP-22 (Live-Abnahme) · **[NIT]** – Kleinigkeit, bei Gelegenheit.

## Vorgehen und Checks

- Gelesen: `CLAUDE.md`, `docs/progress.md`, `docs/architecture.md` (§2.3a–j, §3.2, §5 d/e/g, §5.2,
  §6), `docs/decisions.md` (ADR-012, -016, -026, -031 … -036), `docs/wp/WP-14.md`, `WP-15.md`,
  `WP-16.md`, `docs/wp/R1-web.md` („Umsetzung“, „Finale Hinweise“), `docs/plan.md` („Chat-Ansicht“,
  „Plan-Modus & Plan-Freigabe“ vollständig, B „Speicher und Performance“, B „Tastatur“, C.3, C.4,
  C.10, C.14), Contracts `src/shared/{model,protocol,sync,status,common}.ts` (relevante Teile),
  **alle** Dateien unter `src/web/features/**` (Produktionscode vollständig, Tests/Playground
  stichprobenartig), dazu `src/web/shell/{SessionPane,SessionHeader,slots,decision-focus,shortcuts,
  ShortcutHelp,AppShell,PaneLayout}`, `src/web/state/hooks.ts`, `src/web/i18n/{en,de}.ts`,
  `src/web/App.tsx`, `main.tsx`, `eslint.config.js` (Feature-Grenzen), virtua 0.53.5
  (`VListProps`), Radix Menu 2.2.1 (`SELECTION_KEYS`).
- `pnpm check`: `tsc -b` **grün**, ESLint **grün** (0 Warnungen), Vitest **2149/2152** – 3
  Timeouts im Projekt `node` unter Volllast (`http/app.test.ts` › `/api/health`,
  `sync/hub.integration.test.ts` › Auth-Flow, `lib/process.test.ts` › „already finished
  process“; je 5 s, bekannt aus WP-16 §2.9, Flake-Fix-Runde läuft) – kein Web-Bezug.
  Gegenprobe `pnpm exec vitest run --project web`: **31 Dateien / 264 Tests grün**.
- `pnpm build`: grün, **keine** Chunk-Warnung. Start-Chunks `index` **148,45 kB** (gzip 45,4),
  `react` 218,80 kB, `vendor` 235,59 kB. Die Feature-Komponenten sind noch nicht verdrahtet
  (`APP_SLOTS = {}`), der Zuwachs von `index` (+28 kB seit R1) sind die statisch registrierten
  Wörterbücher `transcript`/`decisions`/`composer` (en + de).
- Greps über `src/web`: kein `dangerouslySetInnerHTML`/`innerHTML`/`rehype-raw`/`eval`, kein
  `any`/`as unknown as`/`@ts-ignore`/`eslint-disable`; keine Rohfarben in `features/**`; alle
  `title`/`aria-label`/`placeholder` über `t()` oder Daten (Pfade, Modellnamen).
- Kein Dev-Server, kein MCP, kein Live-`claude`. Verhalten in echtem Layout (virtua, Fokus,
  Radix-Portale) konnte nur aus Code + Tests bewertet werden (→ R2W-07).

## Gesamturteil

Beide Pakete sind sehr sorgfältig. Das Kernfeature hält seine wichtigste Zusage: **Es gibt keinen
Weg, durch Tippen, Enter oder Leertaste etwas freizugeben** – jede Freigabe (Erlauben, Immer
erlauben, Umsetzen, Antworten, Fortsetzen & umsetzen) läuft nur über Zeiger-Klick auf eine
`DecisionAction` oder `Mod+Enter` mit Fokus **in der Karte**, mit 600 ms Arm-Verzögerung je neu
gezeigter Karte, gesperrt während des Sendens/offline; nichts ist modal, nichts stiehlt den Fokus,
Variante A ist sauber umgesetzt. Renderer-Sicherheit (Markdown, ANSI, Diff, Bilder, Links) ist ohne
Befund, die Render-Isolation bei Deltas stimmt.

Die Befunde liegen an drei Stellen: **(1)** Der Composer beantwortet bei offener Entscheidung per
Enter – auch eine Entscheidung, die erst **während des Tippens** erschienen ist (keine Ziel-Sperre,
keine Arm-Verzögerung, auch Subagent-Anfragen); nie eine Freigabe, aber eine ungewollte Ablehnung
bzw. Plan-Überarbeitung (R2W-01, Nutzer-Entscheidung empfohlen). **(2)** Zwei kleine
Korrektheitslücken in Antwortpfaden (R2W-02 falsche Frage-Antwort, R2W-05 Menüpunkt antwortet per
Tastatur). **(3)** Doppelungen, die erst nach der Verdrahtung sichtbar werden: Modus-Bezeichnungen in
drei Varianten (R2W-03) und die Warteschlange dreifach (R2W-04).

**Anzahl:** 0 × BLOCKER, 7 × SOLLTE, 14 × NIT. WP-20 kann ohne Vorarbeit verdrahten.

## Geprüft ohne Befund (Auszug)

- **Variante A (architecture §2.3e, ADR-031):** `DecisionCard` rendert offen + abgelaufen und gibt
  nach Auflösung `null` zurück (`DecisionCard.tsx:20-23`); `placement:'transcript'`
  (`TranscriptCard.tsx`) hat keine Antwort-Elemente, keine Kürzel, kein `data-decision-id`, nur
  Status (Icon + Text) und „Zur Entscheidung“ → `focusDecision`; die Leiste registriert
  `useDecisionFocusHandler` (`DecisionBar.tsx:56-66`). WP-15 nutzt den Slot nur solange
  `useDecision ≠ null && outcome === null` und zeichnet den Endzustand selbst aus
  `tool_call.decision.outcome` + `input.plan` bzw. `structured.plan` bei `edited`
  (`transcript/items/PlanCard.tsx:59-131`). Kein Querimport (ESLint grün).
- **Antwort-Schutz** (`card-shell.tsx`): Enter/Leertaste auf einer fokussierten Antwort-Schaltfläche
  werden verworfen (Klick mit `detail === 0` < 1 s nach Keydown in der Karte; Auto-Repeat
  aktualisiert den Zeitstempel); `Mod+Enter` nur mit `scopeRef` der Karte, auf Nicht-Antwort-Knöpfen
  wirkungslos, Hauptaktion nur auf Karte/Feldern/Optionen; neue Karten per `decision.id` gekeyt
  (frischer Arm-Timer, nie fokussierter Knopf der Vorgängerin); nach eigener Antwort landet der Fokus
  auf der Leistenregion – **außerhalb** des Karten-Scopes, ein zweites `Mod+Enter` trifft die
  nächste Karte also nicht. `DenyForm` ruft `preventDefault`, die Registry überspringt
  `defaultPrevented` – `Mod+Enter` im Begründungsfeld lehnt nur ab, nie zusätzlich „erlauben“.
- **Nicht-modal / kein Fokus-Diebstahl:** nie `role="dialog"`, nie `autoFocus`; Menüs
  `modal={false}`, Popover nicht modal; Fokus nur nach Nutzeraktion (Zur Entscheidung, Plan
  öffnen, Mit Begründung ablehnen, Weiter planen); neue Entscheidungen über `role="status"`.
- **Absichten (ADR-012, C.4):** vier Ziele, Default `session`, project/user mit Warn-Badge (Icon +
  Text) im Menü und neben dem Knopf, „Immer erlauben“ nur mit Regeln/Ordnern und nie mit
  `acceptEdits`; „Erlauben + Edits automatisch“ separat nur bei `offer.acceptEdits`;
  `defaultToNo` macht Ablehnen zur Hauptaktion; Umsetzen sendet nur `mode` (Reihenfolge Auto, Edits
  automatisch, einzeln, Bypass rot, nie vorausgewählt; „frischer Kontext“ deaktiviert); deny +
  message / + interrupt; AskUserQuestion im Contract-Format (`buildQuestionAnswer`, Ausnahme
  R2W-02).
- **Leiste:** älteste offene zuerst, „+n weitere“ (wählt nur, fokussiert dann die Karte),
  Fragesteller (Haupt-Agent/Subagent), abgelaufen read-only mit „Fortsetzen“ /
  „Fortsetzen & umsetzen“ (Status `needs-resume`), fremde Auflösung → Karte weg + Hinweis aus
  `tool_call.decision.outcome` (keine Hinweise bei Resync, `/clear`, Session-Wechsel, eigener
  Antwort, Stopp, „Jetzt senden“), `DECISION_ALREADY_RESOLVED` als `info`-Hinweis.
- **Sicherheit (C.10):** react-markdown mit `skipHtml`, ohne rehype-Plugins, `urlTransform` +
  `a`/`img`-Renderer nur absolute `http(s)` (`safe-url.ts`), Links `noopener noreferrer`, Bilder
  werden nie geladen; Anhänge/Ergebnisbilder nur `blobPath` (same origin); ANSI-Scanner ohne
  Regex über Steuerzeichen, OSC/CSI ≠ SGR und C0 fallen weg, Ausgabe nur als React-Text; Diff,
  Plan-Panel, Optionsvorschauen, User-Text, Thinking als Text bzw. über denselben Markdown-Renderer;
  Shiki nur `shiki/core` + JS-Regex-Engine, Theme nur CSS-Variablen; Copy kopiert Rohtext.
- **Performance:** Liste `useTopLevelItemIds` + `useItem` je Zeile, Kontextwerte primitiv; keine
  WP-16-Komponente hängt an Deltas (`useDecisions`, schmale Selektoren, Outcomes-Map shallow);
  Markdown-Blöcke memoisiert (nur der letzte wird beim Streamen neu geparst), Shiki nur geschlossene
  Fences ≤ 20 000 Zeichen, Grammatiken einzeln lazy, `diff` lazy; Expansion-State übersteht
  Re-Mounts; Agent-Laufzeit tickt nur in der eigenen Komponente.
- **Konventionen:** `de: typeof en` + Vollständigkeits-/Platzhalter-Tests je Namespace, Tokens
  statt Rohfarben (Shiki/ANSI auf Tokens gemappt), Status immer Icon + Text, Fokus-Ringe auf allen
  Bedienelementen, keine `Ctrl+Alt`-Kürzel, Testdaten aus `@shared/samples`.

---

## Befunde

### SOLLTE (vor WP-22)

#### R2W-01 [SOLLTE] Composer: Enter beantwortet auch eine Entscheidung, die während des Tippens erschienen ist
- **Fundstelle:** `src/web/features/composer/Composer.tsx:87-90` (Ziel = jeweils angezeigte offene
  Entscheidung der Leiste, ohne Zeitpunkt/Herkunft), `:124-139` (`submit('primary')` →
  `respondToDecision`), `:195-204` (Hinweiszeile erscheint über dem Feld), `:219-224` (Enter);
  `composer/lib/commands.ts:23-32` (`answerFromText`); `docs/wp/WP-16.md` §2.6 Nr. 2.
- **Begründung:** Plan „Plan-Modus“: „Wer einfach in den Composer tippt, gibt Feedback (deny +
  message)“ – für **Pläne** deckt das WP-16s Wahl. Für Permissions sagt der Plan: „Composer-Text
  während einer offenen Permission = ‚Nein, stattdessen: …‘ (deny + message). **Dafür gibt es einen
  expliziten Button ‚Als Antwort senden‘**“ und „Kein Fokus-Diebstahl, solange der Nutzer tippt“.
  Heute wechselt das Enter-Ziel **unter den Händen des Nutzers**: Er schreibt (während Claude
  arbeitet) die nächste Anweisung, eine Permission erscheint in der Leiste über dem Composer, eine
  Hinweiszeile schiebt das Feld eine Zeile tiefer – Enter lehnt dann die nie gelesene Freigabe ab und
  verbraucht seinen Text als Begründung. Die Karten selbst haben dagegen 600 ms Arm-Verzögerung,
  der Composer-Pfad keine. Bei **Subagent**-Anfragen geht der Text zudem an den Subagenten statt an
  den Gesprächspartner des Nutzers. Nie eine Freigabe (die Kernregel hält), aber eine ungewollte
  Ablehnung kostet einen Turn und lenkt Claude um; ein Test für „Entscheidung erscheint beim
  Tippen“ fehlt (`Composer.test.tsx` deckt nur den Fall, dass die Entscheidung vorher da war).
- **Bewertung von WP-16 §2.6 Nr. 2:** Die Begründung (ein `next`-Prompt würde hinter der
  blockierenden Entscheidung warten) stimmt, und für Pläne ist Enter = Feedback planmäßig. Das Risiko
  liegt nicht im Grundsatz, sondern im **Zielwechsel ohne Absicht**. Empfehlung **„Ziel-Sperre“**:
  - Enter beantwortet nur die Entscheidung, die **schon angezeigt war, als der aktuelle Entwurf
    begonnen wurde** (Entwurf beim Erscheinen leer, bzw. der Nutzer kam über „Weiter planen“/„Zur
    Entscheidung“ in den Composer) **und** deren Arm-Verzögerung abgelaufen ist.
  - Sonst bleibt Enter beim normalen Verhalten (Senden/Einreihen) mit kurzem Hinweis „Neue
    Entscheidung offen – ‚Als Antwort senden‘ beantwortet sie“; der Knopf „Als Antwort senden“ (und
    „▾“) bleibt der explizite Weg.
  - Subagent-Anfragen nie per nacktem Enter, nur über den Knopf.
  - Alternativen zur Nutzer-Entscheidung: (A) Verhalten wie heute; (B) Ziel-Sperre (empfohlen);
    (C) Enter beantwortet nur Pläne, Permissions/Fragen ausschließlich per Knopf (Enter reiht dann
    ein – die Nachricht wartet bis zur Antwort, mit Hinweis).
- **Fix (Owner: WP-16 nach Nutzer-Entscheidung):** im Composer beim Übergang Entwurf `'' → nicht
  leer` die ID des angezeigten offenen Ziels festhalten (`requestComposerFocus` aus „Weiter planen“
  setzt sie ebenfalls), Enter nutzt `target` nur bei gleicher ID, `requester.kind === 'main'` (bzw.
  Plan) und abgelaufener `ARM_DELAY_MS`; Entwurf aus localStorage beim Mount → keine Sperre (Enter
  sendet normal). Tests: Entscheidung erscheint nach dem ersten Zeichen → Enter erzeugt
  `session.sendPrompt`, Entscheidung bleibt offen; Subagent-Permission + Enter → keine Antwort.

#### R2W-02 [SOLLTE] Frage-Karte: Tippen in „Andere“ behält bei Einfachauswahl die zuvor gewählte Option
- **Fundstelle:** `src/web/features/decisions/components/QuestionCard.tsx:89-101` (`otherInput`
  setzt `other: true`, lässt `selected` stehen), `:148` (Radio zeigt dann „Andere“), `:85-87`
  (Vorschau der alten Option bleibt), `:38-55` (`buildQuestionAnswer` sendet beides).
- **Begründung:** Ablauf „Option A wählen → dann in ‚Andere‘ tippen“ (ohne vorher das
  Andere-Radio zu klicken): Die UI zeigt „Andere“ als gewählt, gesendet wird aber
  `selected: ['A'], otherText: '…'` – bei einer Einfachauswahl zwei Antworten, Claude bekommt die
  verworfene Option mit. Der Test „Other … answers with free text only“ tippt nur ohne vorherige
  Auswahl. Contract-Regel „ohne `multiSelect` höchstens ein Label“ (architecture §5.2) ist formal
  erfüllt, inhaltlich nicht.
- **Fix (Owner: WP-16):** im `onChange` des Andere-Felds bei `!question.multiSelect` zusätzlich
  `selected: []` setzen (wie `onValueChange(OTHER)`); Test „erst Option, dann Andere tippen →
  `selected: []`“.

#### R2W-03 [SOLLTE] Modus-Bezeichnungen in drei Varianten; Kopf und Composer zeigen Modus/Modell doppelt
- **Fundstelle:** `src/web/i18n/en.ts:71-78` / `de.ts:66-73` (`shell.permissionMode`: „Ask“/
  „Fragen“, de „Änderungen annehmen“, „Planen“), `src/web/shell/SessionHeader.tsx:63-76`
  (Modell + Modus-Badge); `features/composer/i18n/{en,de}.ts` `mode.modes` („Manual“/„Manuell“,
  „Edits automatisch“, „Plan“); `features/decisions/i18n/*` `plan.modes`/`modesShort`;
  `features/transcript/items/decision-outcome.ts:44` (Endzustand „Freigegeben – Fragen“ über die
  Shell-Schlüssel).
- **Begründung:** Plan C.3: „‚Manual‘ ist nur das UI-Label für `'default'`“, Plan „Kopfleiste“:
  „Manual / Edits automatisch / Plan / Auto“. Nach der Verdrahtung stehen gleichzeitig „Fragen“
  (Kopf), „Manuell“ (Composer-Picker) und „Freigegeben – Fragen“ (Transkript) auf dem Schirm; de
  „Änderungen annehmen“ neben „Edits automatisch“. Kopf und Composer zeigen außerdem beide das
  Modell und den Modus (Plan sieht die Picker in der Kopfleiste vor, WP-16 hat sie in den Composer
  gelegt – vertretbar, aber dann doppelt).
- **Fix:** **WP-14** gleicht `shell.permissionMode.*` an den Plan an (en „Manual“, „Accept edits“,
  „Plan“; de „Manuell“, „Edits automatisch“, „Plan“) – **der WP-16-Wunsch ist berechtigt**.
  **WP-16** (optional, Duplikat): `composer.mode.modes` durch `shell.permissionMode.*` ersetzen.
  **WP-20** entscheidet die Platzierung: Picker im Composer lassen und im Kopf nur den Status zeigen
  (Modus-Badge/Modell im Kopf entfernen oder ausblenden, solange der Composer sichtbar ist) –
  Empfehlung, weil der Picker dort ohnehin den tatsächlichen Modus zeigt (C.3).

#### R2W-04 [SOLLTE] Warteschlange wird dreifach angezeigt
- **Fundstelle:** `src/web/features/transcript/TranscriptView.tsx:97-107` +
  `items/MessageRows.tsx:86-139` (graue Zeilen am Ende, Items mit UUID in der Queue grau);
  `features/composer/Composer.tsx:155-171`, `:194` + `components/QueueList.tsx` (Liste mit Texten
  über dem Eingabefeld); `src/web/shell/SessionHeader.tsx:38-40` (Badge „n eingereiht“);
  `docs/wp/WP-15.md` §2.6 Nr. 5.
- **Begründung:** Plan „Chat-Ansicht“: „Gequeuete Nachrichten erscheinen grau, bis sie verarbeitet
  sind“ – das leistet WP-15 im Transkript (inkl. „Wird gesendet…“ für `state:'sending'`). Die
  Composer-Liste wiederholt dieselben Texte; nach WP-20 steht jeder eingereihte Prompt zweimal
  untereinander (Transkript-Ende + Composer), dazu der Zähler im Kopf. Die Composer-Liste deckt nur
  zusätzlich die Millisekunden zwischen Klick und `ack` ab (lokal `pending`), die der Senden-Knopf
  schon per Spinner zeigt.
- **Fix (Owner: WP-16, Entscheidung WP-20/Koordinator):** Empfehlung: Transkript bleibt die
  kanonische Anzeige (Plan), Kopf-Badge bleibt; im Composer `QueueList` entfernen bzw. auf einen
  kompakten Chip „n eingereiht“ reduzieren, der bei hochgescrolltem Transkript „Zu neuesten“ auslöst.
  Damit entfällt auch die Text-Deduplizierung `pending` ↔ `detail.queue` (`Composer.tsx:155-171`).

#### R2W-05 [SOLLTE] „Ablehnen und Turn stoppen“ antwortet per Enter/Leertaste im Menü
- **Fundstelle:** `src/web/features/decisions/components/PermissionCard.tsx:162-174`
  (`DropdownMenuItem onSelect` → `useCardRespond`), `components/card-shell.tsx:272-278`
  (`useCardRespond` prüft nur `armed`/`disabled`, keine Tastenaktivierung); Radix Menu
  `SELECTION_KEYS = ['Enter', ' ']`.
- **Begründung:** WP-16 §2.2/§2.6 Nr. 1 sagt zu: „Antworten nur per Zeiger oder `Mod+Enter` – auch
  Ablehnen“ und „‚▾‘-Menüs wählen nur“. Dieser Menüpunkt antwortet direkt und reagiert auf Enter
  (Typeahead fokussiert ihn z. B. nach „a“/„d“). Er ist zudem destruktiv: `interrupt: true` stoppt
  den Turn und damit auch Hintergrund-Subagents (C.5 „Stop killt Hintergrund-Subagents“).
  Wahrscheinlichkeit gering (Menü muss offen sein), aber die dokumentierte Garantie stimmt nicht.
  Gleiches Muster im Composer-„▾“ („Jetzt senden“ bricht die offenen Haupt-Entscheidungen ab,
  `Composer.tsx:305-313`) – dort als Sende-Aktion vertretbar.
- **Fix (Owner: WP-16):** Menüpunkt öffnet nur das Ablehnungsformular im Modus „ablehnen und
  stoppen“ (Knopf als `DecisionAction`), oder er wählt wie `ChoiceMenu` nur die Ablehnungsart des
  Ablehnen-Knopfs; Test „Enter auf dem Menüpunkt antwortet nicht“.

#### R2W-06 [SOLLTE] „Vollständig laden“ rendert beliebig große Blobs ungekappt inline
- **Fundstelle:** `src/web/features/transcript/state/full-text.ts:30-43` (`response.text()` ohne
  Größengrenze), `:52` (LRU 16 Texte, ohne Größenbudget), `components/CappedContent.tsx:79-83`,
  `renderers/parts.tsx:58-81` (`TerminalOutput` → ein `<pre>` mit `AnsiText` über den ganzen Text),
  `renderers/read.tsx:86-99`; kein Blob-Limit in `src/shared/common.ts` (`LIMITS`).
- **Begründung:** Plan B „Speicher und Performance“: Output je Item 32–64 KB gekappt, „vollständig
  laden“ über HTTP. Ein `pnpm install`-/Build-Log oder ein Read großer Dateien kann mehrere MB
  haben; der ANSI-Scan plus ein einzelner Riesen-Textknoten (bzw. Shiki-Fallback als
  Zeilen-`span`s) friert den Renderer ein und hält bis zu 16 solcher Texte im Speicher. Spätestens
  in WP-22 (Live) realistisch.
- **Fix (Owner: WP-15):** Inline höchstens ein Budget anzeigen (z. B. 1 MiB bzw. 20 000 Zeilen, wie
  `DiffView` seitenweise „weitere n Zeilen“), darüber Hinweis „x MB – gekürzt angezeigt“; LRU nach
  Zeichen statt Anzahl begrenzen. Optional `Content-Length` vor dem Lesen prüfen.

#### R2W-07 [SOLLTE] Kleben am Ende, `loadEarlier`/`shift`, Fokus und CSP sind nur im echten Layout prüfbar → Pflichtfälle für WP-20
- **Fundstelle:** `src/web/features/transcript/TranscriptView.tsx:109-185` (Kleben über
  `onScroll`/`onResize`, `shift` aus der vorigen Listenform, `loadEarlier` bei `offset < 240`);
  `transcript/testing.ts` (happy-dom ohne Layout, ResizeObserver-Stub).
- **Begründung:** Das Verhalten hängt an virtua-Messungen, die happy-dom nicht liefert; die Tests
  prüfen Fenster-Rendering und `loadEarlier`, nicht das Kleben beim Streamen, das Lösen beim
  Hochscrollen, die Position nach dem Voranstellen und `Zu neuesten`. Kleinigkeit im Code: `shift`
  bleibt nach einem Voranstellen `true`, bis sich Länge/erstes Item wieder ändern – in dieser Zeit
  am Ende angehängte Queue-Zeilen (nicht Teil der Form) würden als „Shift“ behandelt
  (`:110-115`). Ebenso offen: Radix-Portale + Karten-Fokus in Edge, Seiten-CSP mit Shiki/Radix
  (R1W-23 nur teilweise umgesetzt).
- **Fix (Owner: WP-20, E2E auf FakeBackend in Edge):** Fälle (a) Streaming klebt am Ende,
  Hochscrollen löst, „Zu neuesten“; (b) `loadEarlier` beim Hochscrollen hält die Leseposition;
  (c) Enter/Leertaste/Tippen auf fokussierten Antwortknöpfen geben nie frei, `Mod+Enter` nur mit
  Karten-Fokus; (d) Freigabe in zwei Fenstern (erster Klick gewinnt, Hinweis); (e) Esc-Stopp,
  Entwurf nach Reload; (f) `securitypolicyviolation` lässt den Test scheitern. **WP-15** (NIT):
  `shift` nur für genau den Render nach dem Voranstellen setzen (z. B. Form inkl. `rows.length`).

### NIT

#### R2W-08 [NIT] `Disclosure` doppelt – Bewertung des Primitive-Wunschs (`Disclosure`/`CodeBlock`/`DiffView` nach `ui/`)
- **Fundstelle:** `src/web/features/transcript/components/Disclosure.tsx:12-58` und
  `features/decisions/components/PermissionCard.tsx:54-75` (eigene Variante mit lokalem State);
  `transcript/components/CodeBlock.tsx`, `DiffView.tsx`.
- **Bewertung:** **`Disclosure` ja** – zweimal gebaut, generisch; als `ui/disclosure.tsx`
  (kontrolliert/unkontrolliert, Trigger als echter `<button>` mit `aria-expanded`), die
  Persistenz (`useExpanded`) bleibt als dünner Wrapper im Transkript. **`CodeBlock` nein** – hängt
  an Shiki (Lazy-Chunk, `lib/highlight`, `lib/languages`) und an `state/notices` (CopyButton); in
  `ui/` würde das Primitive-Verzeichnis State und Shiki kennen. WP-16 bekommt Code ohnehin über den
  Slot `Markdown`. **`DiffView` vorerst nein** – nur das Transkript nutzt ihn, WP-16 sieht Diffs über
  `ToolInputPreview`. Ebenso `ChoiceMenu` (Split-Button-Hälfte, WP-16-Wunsch) erst, wenn ein
  zweites Feature ihn braucht. Owner: Koordinator/WP-14, Phase 2, nicht für WP-20 nötig.

#### R2W-09 [NIT] virtua-Layout-Stub nach `test/setup` – Bewertung
- **Fundstelle:** `src/web/features/transcript/testing.ts:29-88`.
- **Bewertung:** Nicht global in `test/setup/web.ts` installieren: der Stub ersetzt
  `ResizeObserver` und patcht `HTMLElement.prototype.offsetParent` – das ändert das Verhalten aller
  Web-Tests (Radix, Popover-Positionierung). Wenn überhaupt, als **opt-in-Helfer**
  (`test/helpers/layout.ts`, Koordinator). WP-20 braucht ihn nur für happy-dom-Tests des
  verdrahteten `App` – `App.test.tsx` darf Features importieren und kann den Helfer direkt aus
  `@web/features/transcript/testing` nehmen. Kein Handlungsbedarf vor WP-20.

#### R2W-10 [NIT] FakeHost-Prompt-Queue (R1W-22-Rest) – Bewertung
- **Fundstelle:** `src/web/state/fake-host.ts` (keine Queue bei `priority:'next'`),
  `features/composer/playground.tsx` (`simulateQueue` über `onCommand`).
- **Bewertung:** Nützlich für realistische Playground-Shell-Demos und Web-Komponententests, aber
  **nicht** für WP-20: dessen E2E läuft gegen den echten Server mit FakeBackend (WP-13), dort kommt
  die Queue aus `command_lifecycle`. Owner WP-14, niedrige Priorität; nach R2W-04 ggf. obsolet.

#### R2W-11 [NIT] Shortcut-Hilfe nennt die Ausnahme `Mod+Enter` in Kartenfeldern nicht – Wunsch berechtigt
- **Fundstelle:** `src/web/i18n/en.ts:111`, `de.ts:106` („…außer Esc“),
  `src/web/shell/ShortcutHelp.tsx:59-72`; `decisions/components/card-shell.tsx:154-159`
  (`allowInInputs: true`).
- **Fix (Owner: WP-14):** Einträge mit `allowInInputs` in der Hilfe kennzeichnen (z. B. Zusatz
  „auch in Feldern der Karte“) und den Beschreibungstext anpassen; `decisions.respond` erscheint nur,
  solange eine Karte gemountet ist – optional als statischer Eintrag registrieren.

#### R2W-12 [NIT] Contract-Grenzen hart kodiert (Contract-Wunsch)
- **Fundstelle:** `src/web/features/composer/lib/commands.ts:13-16` (`50_000`/`10_000`),
  `decisions/components/PermissionCard.tsx:25` (`DENY_MESSAGE_MAX`),
  `decisions/components/PlanCard.tsx:15` (`PLAN_FEEDBACK_MAX`); Contract
  `src/shared/model.ts:792`, `:817`, `:829` (Literale statt `LIMITS`).
- **Fix (Owner: Koordinator, Contract-Changelog):** `LIMITS.decisionMessageChars` (10 000) und
  `LIMITS.planFeedbackChars` (50 000) in `@shared/common`, Schemas und Web nutzen sie. Bei der
  Gelegenheit den WP-16-Wunsch umsetzen: Kommentar `contextBreakdown.autoCompactThreshold` = Token-
  Zahl (berechtigt).

#### R2W-13 [NIT] Composer-Text bei offener Frage = „Überspringen“, der Platzhalter verspricht eine Antwort
- **Fundstelle:** `src/web/features/composer/i18n/en.ts:18` („Answer in your own words…“), `de.ts:11`,
  `lib/commands.ts:27-28` (`decline + message`).
- **Fix (Owner: WP-16):** Bei genau einer Frage den Text als `answer` mit `selected: []`,
  `otherText: <Text>` senden (Contract erlaubt das), bei mehreren Fragen wie heute `decline` – und
  Platzhalter/Hinweis entsprechend („…überspringt sie mit deinem Text“ passt dann nur noch dort).

#### R2W-14 [NIT] Abgelaufene Permission/Frage im Transkript ohne Status und „Zur Entscheidung“
- **Fundstelle:** `src/web/features/transcript/items/ToolCallRow.tsx:30-54` (`DecisionLine` zeigt
  den offenen Zustand nur bei `status === 'awaiting_decision'`).
- **Begründung:** Nach einem Serverneustart (Diagramm g) ist der Tool-Call `interrupted`, die
  Entscheidung `expired` (ADR-016) – die Zeile zeigt dann weder „Abgelaufen“ noch den Sprung zur
  Leiste; Plan-Karten machen es über den Slot richtig.
- **Fix (Owner: WP-15):** in `DecisionLine` bei `outcome === null` `useDecision` abfragen und für
  `state:'expired'` „Abgelaufen – in der Leiste fortsetzen“ + „Zur Entscheidung“ zeigen.

#### R2W-15 [NIT] Plan-Karte im Transkript ohne „Plan öffnen“
- **Fundstelle:** `src/web/features/decisions/components/TranscriptCard.tsx:112-129`;
  `transcript/items/PlanCard.tsx:59-112` (Endzustand, laut WP-15 §2.7 Phase 2).
- **Begründung:** Plan: „Plan-Karte im Chat (Titel, Zusammenfassung, ‚Plan öffnen‘)“. „Plan
  öffnen“ ist keine Antwort und verträgt sich mit Variante A.
- **Fix (Owner: WP-16):** `OpenPlanButton` (ohne Inline-Fallback) in der Transkript-Karte; den
  Endzustand (WP-15) mit „Plan öffnen“ erst, wenn das Panel Pläne ohne offene Entscheidung kennt
  (Phase 2).

#### R2W-16 [NIT] „Weiter planen mit Feedback“ zweimal; Layoutsprung in der Leiste beim Tippen
- **Fundstelle:** `src/web/features/decisions/components/PlanCard.tsx:86-104` (Knopf wechselt mit
  dem Entwurf zwischen „Weiter planen“ und „Weiter planen mit Feedback“, die Knöpfe rechts davon
  wandern); `composer/Composer.tsx:177-180` (Senden-Knopf mit demselben Text).
- **Fix (Owner: WP-16):** In der Leiste immer „Weiter planen“ (fokussiert den Composer bzw. sendet
  das Feedback, Breite fix), die Beschriftung „…mit Feedback“ nur am Composer-Knopf.

#### R2W-17 [NIT] Doku: composer ↔ decisions importieren einander
- **Fundstelle:** `CLAUDE.md:52`, `src/web/features/README.md:15` („Features importieren einander
  nie“) vs. `eslint.config.js:212-223` (decisions ↔ composer erlaubt, ADR-034);
  `composer/Composer.tsx:26-32`, `decisions/components/PlanCard.tsx:7-8`.
- **Fix (Owner: Koordinator):** Ausnahme „decisions ↔ composer (beide WP-16)“ in CLAUDE.md und der
  Feature-README nennen.

#### R2W-18 [NIT] Caches nach Anzahl statt Größe; Shiki tokenisiert synchron
- **Fundstelle:** `src/web/features/transcript/lib/highlight.ts:88-118` (200 Einträge, Schlüssel =
  ganzer Code bis 20 000 Zeichen + Token-Objekte), `:106` (`codeToTokens` im Main-Thread),
  `lib/diff.ts:67-96` (100 Einträge, Schlüssel mit beiden Snippets bis je 48 Ki).
- **Fix (Owner: WP-15):** Budget nach Zeichen (z. B. 2 Mi gesamt) statt Anzahl, Schlüssel per
  Hash (`src/web/lib/hash.ts`); große Blöcke per `requestIdleCallback`/`startTransition`
  hervorheben.

#### R2W-19 [NIT] Barrierearmut: unsichtbarer Fokus auf Containern, Antwort-Hinweis nicht verknüpft
- **Fundstelle:** `src/web/features/decisions/PlanSidePanel.tsx:50-56` (`<aside tabIndex={-1}
  outline-none>` bekommt beim Öffnen den Fokus), `DecisionBar.tsx:105-110` (Leistenregion nach einer
  Antwort), `src/web/shell/SessionPane.tsx:41-46`; `decisions/components/card-shell.tsx:232-236`,
  `:257-268` (Hinweis „Enter und Leertaste antworten nie“ nur sichtbar, nicht per
  `aria-describedby` an den Antwortknöpfen).
- **Fix (Owner: WP-16, Pane-Region WP-14):** `focus-visible:ring-2` auf Panel/Leiste;
  Hinweis-ID per `aria-describedby` an `DecisionAction` hängen (Screenreader im Fokusmodus hören,
  warum Enter nichts tut).

#### R2W-20 [NIT] `SystemRow` baut eine eigene Hinweisbox statt `ui/alert`
- **Fundstelle:** `src/web/features/transcript/items/SystemRow.tsx:37-54` (`Notice` mit eigener
  Ton-Tabelle, nutzt nur `TONE_ICON`).
- **Fix (Owner: WP-15):** `Alert` aus `@web/ui/alert` mit einer kompakten Größe nutzen (ggf.
  `size`-Variante als Wunsch an WP-14).

#### R2W-21 [NIT] Start-Chunk wächst durch statische Wörterbücher; WP-20 bringt WP-16 in den Start-Chunk
- **Fundstelle:** `src/web/i18n/index.ts:4-9`; Build `index` 148,45 kB (R1: 120,6 kB).
- **Begründung:** Unkritisch (Schwelle 500 kB), aber WP-20 importiert `DecisionBar`, `Composer`,
  `DecisionCard`, `PlanSidePanel` statisch in `App.tsx` (sie sind beim Start sichtbar).
- **Fix (Owner: WP-20):** Chunk-Größen nach der Verdrahtung im Bericht nennen; später (Phase 2)
  `de`-Wörterbücher lazy laden.

---

## Bereitschaft für WP-20

**Zu verdrahten (nichts fehlt in WP-14):**
1. `src/web/App.tsx`: `APP_SLOTS = { ...TRANSCRIPT_SLOTS, DecisionBar, DecisionCard, SidePanel:
   PlanSidePanel, Composer }` als Modul-Konstante (`@web/features/transcript/slots`,
   `@web/features/decisions/{DecisionBar,DecisionCard,PlanSidePanel}`,
   `@web/features/composer/Composer`). `SessionPane` rendert bereits die Leistenregion
   (`data-decision-bar`, `data-shortcut-scope`), das Seitenpanel neben dem Transkript und den
   Composer; `NotificationCenter` und `ShortcutHelp` hängen in `AppShell`.
2. Entscheidungen beim Verdrahten: Queue-Anzeige (R2W-04), Modus/Modell Kopf vs. Composer (R2W-03),
   Enter-Verhalten (R2W-01, Nutzer).
3. E2E-Pflichtfälle aus R2W-07 plus Bundle-Bericht (R2W-21).

**Bewertung der Wünsche an WP-14 (aus WP-15/16):**

| Wunsch | Bewertung | Befund |
|---|---|---|
| Label „Manual/Manuell“ (`shell.permissionMode.default`) | **ja, vor WP-22** (Plan C.3; dazu de „Edits automatisch“, „Plan“) | R2W-03 |
| Shortcut-Hilfe `Mod+Enter` in Kartenfeldern | ja, klein | R2W-11 |
| `Disclosure` nach `ui/` | ja (Phase 2) | R2W-08 |
| `CodeBlock`, `DiffView`, `ChoiceMenu`, `QueueList` nach `ui/` | nein bzw. später (Abhängigkeiten zu Shiki/State; nur ein Nutzer) | R2W-08, R2W-04 |
| virtua-Stub nach `test/setup` | nur als opt-in-Helfer, nicht global | R2W-09 |
| FakeHost-Prompt-Queue | optional, nicht für WP-20 | R2W-10 |
| Contract-Kommentar `autoCompactThreshold` | ja (Koordinator) | R2W-12 |

## Fix-Auftrag Web (nur BLOCKER + SOLLTE)

Keine BLOCKER – WP-20 kann parallel starten. Reihenfolge = Priorität; kein Contract betroffen.

1. **R2W-01 (WP-16, nach Nutzer-Entscheidung):** Ziel-Sperre im Composer (Entwurf beginnt bei
   angezeigter Entscheidung, Arm-Verzögerung, keine Subagent-Antwort per Enter) oder die gewählte
   Alternative; Tests „Entscheidung erscheint beim Tippen“ und „Subagent + Enter“.
2. **R2W-02 (WP-16):** Andere-Feld bei Einfachauswahl leert `selected`; Test.
3. **R2W-05 (WP-16):** „Ablehnen und Turn stoppen“ nicht direkt aus dem Menü beantworten; Test
   „Enter auf Menüpunkt antwortet nicht“.
4. **R2W-03 (WP-14 + WP-16 + WP-20):** `shell.permissionMode.*` an Plan C.3 angleichen (en/de),
   Composer nutzt dieselben Schlüssel; WP-20 entscheidet Kopf-Badge/Modell vs. Composer-Picker.
5. **R2W-04 (WP-16, Entscheidung WP-20):** Composer-Queue-Liste entfernen bzw. zum Zähler-Chip
   machen; Transkript bleibt kanonisch.
6. **R2W-06 (WP-15):** Inline-Budget für „Vollständig laden“ + Größen-LRU.
7. **R2W-07 (WP-20):** E2E-Fälle (a)–(f) in Edge; WP-15 korrigiert `shift` nebenbei.

## Umsetzung (Branch `fix/r2-web`, 15.10.2026)

Koordinator-Entscheidungen: R2W-01 Variante B „Ziel-Sperre“ (ADR-040), R2W-04 Queue nur im
Transkript + Kopfzeilen-Badge (ADR-041), Picker im Composer / Kopfzeile nur Status (ADR-042),
„Manual“/„Manuell“ überall (ADR-043), WP-14-Wünsche (ADR-044), Contract-Limits (ADR-045).
Details: `docs/wp/WP-14.md` §2.11, `WP-15.md` §3, `WP-16.md` §3, architecture §2.3k.

| Befund | Umsetzung |
|---|---|
| R2W-01 | Ziel beim ersten Zeichen des Entwurfs fixiert (Haupt-Agent, ≥ 600 ms angezeigt, oder „Weiter planen“); sonst sendet Enter normal, Hinweis + expliziter Knopf „Als Antwort senden“ links der Sende-Knöpfe; wiederhergestellter Entwurf ohne Ziel; Tests inkl. Gegenprobe (Entscheidung erscheint beim Tippen → `session.sendPrompt`, keine Antwort) und Subagent + Enter |
| R2W-02 | Andere-Feld bei Einfachauswahl leert `selected`; Test |
| R2W-03 | `shell.permissionMode.*` en/de an Plan C.3, einzige Quelle für Picker, Umsetzen-Knopf, Transkript; `composer.mode.modes`/`decisions.plan.modesShort` entfernt; Kopfzeile unverändert als Status |
| R2W-04 | `QueueList` entfernt (kein Chip – „Zu neuesten“ bräuchte eine Querverbindung Composer → Transkript) |
| R2W-05 | „▾“-Einträge öffnen nur Formulare; „Ablehnen und stoppen“ ist eine `DecisionAction`; Test „Enter auf Menüpunkt antwortet nicht“ |
| R2W-06 | Inline-Budget 1 Mi Zeichen/20 000 Zeilen mit Hinweis; Blob-LRU nach Anzahl und Größe (16/8 Mi) |
| R2W-07 | nur der `shift`-NIT (Form inkl. Zeilenzahl und „Früher laden“); E2E bleibt WP-20 |
| R2W-08 | `Disclosure` in `src/web/ui/disclosure.tsx`, Transkript-Wrapper, Permission-Karte nutzt es |
| R2W-11 | Shortcut-Hilfe markiert `allowInInputs`, Beschreibung nennt Mod+Enter in der Leiste |
| R2W-12 | `LIMITS.decisionMessageChars`/`planFeedbackChars`, Schemas in `model.ts` nutzen sie (Werte gleich, keine Verschärfung nötig), Kommentar `autoCompactThreshold` = Tokens; Web: `maxLength`, Validierung, Zeichenzähler |
| R2W-13 | eine Frage: Composer-Text = `answer` mit `otherText`; Platzhalter/Hinweise je Fall |
| R2W-14 | abgelaufene Permission/Frage im Transkript mit Hinweis + „Zur Entscheidung“ |
| R2W-15 | „Plan öffnen“ in der Transkript-Karte (nur mit gemountetem Panel) |
| R2W-16 | „Weiter planen“ mit fester Beschriftung, „…mit Feedback“ nur am Composer |
| R2W-18 | teilweise: Shiki-/Diff-Cache nach Größe (`SizedLru`); Hash-Schlüssel und asynchrones Hervorheben offen |
| R2W-19 | `aria-describedby` an Antwortknöpfen, `focus-visible`-Ring an Leiste und Plan-Panel (Pane-Region WP-14 nicht geändert) |

Nicht umgesetzt (Begründung): R2W-09 (virtua-Stub global ändert alle Web-Tests; opt-in nicht nötig,
WP-20 importiert `@web/features/transcript/testing`), R2W-10 (FakeHost-Queue: `src/web/state` nicht
im Auftrag, für WP-20 nicht nötig), R2W-17 (CLAUDE.md/Feature-README gehören dem Koordinator),
R2W-20 (`Alert` braucht eine kompakte Größe in `ui/alert`), R2W-21 (WP-20).

Checks: `pnpm check` grün (103 Dateien, 2174 Tests), `pnpm build` grün ohne Chunk-Warnung (`index`
150,5 kB, `react` 218,8 kB, `vendor` 235,6 kB), Sichttest Playground (`composer/late-decision`,
`decisions/permission`, `decisions/plan`, `decisions/expired`, `transcript/large-output`,
`shell-decisions` mit `?`-Hilfe; dunkel/hell, en/de) ohne Konsolenfehler.
