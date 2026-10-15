# R1 – Review Web-Paket (WP-14)

**Stand:** 15.10.2026, `main` nach `e1fa211` (Welle 1a gemergt) · **Rolle:** read-only Review (nur
diese Datei geändert) · **Schwerpunkt:** Sicherheit, Sync-Korrektheit und API-Tauglichkeit von
`src/web/**` für Welle 1b (WP-15 Transkript, WP-16 Entscheidungen + Composer). Der Server-Teil steht
in `docs/wp/R1.md`.

Schweregrade: **[BLOCKER vor Welle 1b]** – vor dem Start von 1b klären/beheben, sonst baut ein
1b-Paket falsch, um eine Lücke herum oder zwei Pakete kollidieren · **[SOLLTE]** – vor WP-20 ·
**[NIT]** – Kleinigkeit, bei Gelegenheit.

## Vorgehen und Checks

- Gelesen: `CLAUDE.md`, `docs/progress.md`, `docs/architecture.md` (§2.1–2.4, §3.2, §5, §5.1, §7,
  §9–11), `docs/decisions.md`, `docs/wp/WP-14.md`, `docs/wp/WP-02.md` §10.3, `docs/wp/R0.md`
  („Umsetzung“), `docs/plan.md` („Web-UI“, Punkt 5, A.2, A.8, A.9, B „Tastatur“, „Speicher und
  Performance“, „Entwürfe“, C.10), `src/shared/{protocol,sync,status,http,errors,common,model}.ts`
  (relevante Teile), **alle** Dateien unter `src/web/**`, Root-Configs (`vite.config.ts`,
  `vitest.config.ts`, `repo.config.ts`, `eslint.config.js`, tsconfigs), Seiten-CSP in
  `src/server/http/app.ts:63-76`.
- `pnpm check`: **grün** – `tsc -b`, ESLint ohne Warnungen, Vitest **60 Dateien / 1451 Tests**.
- Web-Build: `pnpm exec vite build --outDir <scratchpad>` (identische Config, nur `outDir`
  umgelenkt, damit `dist/` des parallel laufenden Verifiers unangetastet bleibt): JS
  **569,46 kB** (gzip 175 kB) in **einem** Chunk, CSS 55,6 kB, Vite-Warnung „> 500 kB“.
  `index.html`: nur `<script type="module" src>` + `<link rel="stylesheet">`, **keine**
  Inline-Skripte/-Styles. URL-Grep über alle Assets: nur `http://www.w3.org/…` (SVG/XLink/MathML/
  XML-Namespaces), `json-schema.org`-IDs (zod), `https://react.dev/errors/` (Fehlertext) – nichts
  wird geladen. `FakeHost`, `msg_fake`, Szenario-IDs: 0 Treffer → Playground nicht im Bundle.
  Größte Quellen laut Sourcemap: `react-dom`, `zod`, `tailwind-merge`, eigener `state/`+`shell/`,
  Radix/floating-ui.
- Watcher-Probe: `picomatch('**/.worktrees/**')` gegen
  `D:/develop/cloudeCode/terminalWrapper/.worktrees/wp-15/src/web/App.tsx` → **true** (Beleg für
  R1W-01); chokidar 3 in Vite 8.3.4 verknüpft relative Ignore-Globs ohne `cwd` nicht mit der Wurzel
  (`normalizeIgnored`, `node_modules/vite/dist/node/chunks/node.js:11896`).
- Abhängigkeiten für 1b gesichtet: `streamdown@2.7.0` (Default-Rehype-Kette `raw → sanitize →
  harden{allowedProtocols:['*'], allowDataImages:true}`), `shiki@4.5` (Oniguruma-WASM vs.
  JS-Engine), `virtua`. Kein MCP, kein Dev-Server, kein Live-`claude`.

## Gesamturteil

WP-14 ist sauber und sorgfältig: Der Sync-Kern (`connection.ts`) setzt Handshake, Full-Resync,
Reload-Guard, Backoff, Lückenerkennung, ref-gezählte Abos, LRU-Cache, Frame-Batching, `cmdId`-Retry
und Präsenz korrekt um und ist gut getestet; Ops laufen ausschließlich über `@shared/sync`, Status
nur über `deriveDisplayStatus`. Sicherheit ist ohne Befund (kein Roh-HTML, Code-Bootstrap korrekt,
keine Tokens in URL/Storage, Bundle ohne externe Ressourcen, CSP-verträglich). Die Lücken liegen an
drei Stellen: **(1)** Hot Reload/Watch ist in Worktrees tot – genau dort arbeiten WP-15/16;
**(2)** zwei API-Stücke fehlen für 1b (abgeleitete Session-Selektoren für die gruppierte,
virtualisierte Liste; Regel für die `DecisionCard` nach Auflösung bzw. doppelte Platzierung);
**(3)** die Render-Isolation endet an Pane- und Sidebar-Ebene (jeder Delta-Frame und jede
Summary-Änderung rendert alle Slots bzw. alle Sidebar-Zeilen neu).

**Anzahl:** 3 × BLOCKER, 6 × SOLLTE, 17 × NIT.

## Geprüft ohne Befund (Auszug)

- **Sicherheit (C.10, A.8):** kein `dangerouslySetInnerHTML`, `innerHTML`, `rehype-raw`, `eval`
  in `src/web`; Platzhalter rendern nur Text (`placeholders.tsx`); einziger Link ist
  `<a href="/">` im Dev-Playground. `consumeAuthCode` entfernt `code=` **vor** dem Tausch per
  `replaceState` (auch ungültige Codes), der Code lebt nur in der Closure von
  `createAuthBootstrap`, wird nach dem Tausch verworfen, nie geloggt/gespeichert (`auth.ts`).
  WS-URL ohne Token (`ws://<location.host>/api/ws`). Storage enthält nur `clientId`, `reloadAt`
  (sessionStorage) und `theme` (localStorage). React-`style`-Props laufen über CSSOM (CSP-neutral);
  `'unsafe-inline'` in `style-src` ist wegen Radix (`ScrollArea`-`<style>`, `react-remove-scroll`)
  nötig und in WP-10 begründet. `crypto.randomUUID` braucht Secure Context – `127.0.0.1` ist einer.
- **Sync (A.2, §5):** `applySeqOps` + Gap → genau ein `subscribe{sinceSeq}` (`resyncPending`);
  Snapshot verwirft ältere Queue-Ops (WS geordnet); neue `serverInstanceId` (Hello **oder**
  Auth-Status) → Views/Summaries/Seqs weg, offene Befehle `CONNECTION_LOST`, Abos ohne `sinceSeq`;
  gleiche Instanz → Replay + Retransmit mit **derselben** `cmdId`; `buildId`/`protocolVersion`
  anders → Reload höchstens 1×/30 s je Fenster, danach Banner **ohne** Auto-Reconnect (keine
  Schleife, Ausnahme R1W-12); Close-Codes 4401/4503/4409 korrekt; Backoff 0,5 s·2ⁿ ≤ 15 s ±20 %,
  Reset nach `hello`; `send` validiert mit `cmdMessageSchema`, `ack.result` mit
  `parseCommandResult`, Timeout 60 s; Abmeldung verzögert 1,5 s, LRU 8; Deltas 1×/Frame (rAF +
  Timer-Fallback für verdeckte Fenster); Präsenz entprellt 250 ms, auch im `clientHello`;
  `sessionKey` nur im Client, `viewingEntryId` nur für den eigenen Host, `homeHost` steuert den
  Build-Vergleich.
- **Konventionen:** kein `any`; alle `title`/`aria-label`/`placeholder`/`label` in Shell/UI über
  `t()` (Ausnahmen nur Daten wie `title={path}` und Playground-Entwicklertitel laut §2.3c);
  `de: typeof en` je Wörterbuch + Laufzeittest über **alle** Namespaces; `tError` typgeprüft für
  jeden `ErrorCode`; Statusanzeige immer Icon + Text (`StatusIcon`, sr-only/Tooltip), 14 Kinds inkl.
  `needs-resume`; Fokus-Ringe auf allen interaktiven Primitives; `motion-safe:`; `Ctrl+Alt` wirft
  bei der Registrierung, AltGr-Ereignisse lösen nie aus; Radix nur in `src/web/ui`; Importgrenzen
  Web ↛ Server per tsconfig + ESLint.

---

## Befunde

### BLOCKER vor Welle 1b

#### R1W-01 [BLOCKER vor Welle 1b] Vite- und Vitest-Watcher ignorieren im Worktree jede Datei
- **Fundstelle:** `repo.config.ts:19` (`worktreeGlobs = ['**/.worktrees/**', '**/.claude/worktrees/**']`),
  `vite.config.ts:42-44` (`server.watch.ignored`), `vitest.config.ts:21-23`
  (`server.watch.ignored`); bestätigt in `docs/wp/WP-14.md` §2.8.
- **Begründung:** chokidar (in Vite 8 gebündelt) prüft **absolute** Pfade; relative Globs werden
  ohne `cwd` nicht an der Wurzel verankert. In einem Checkout unter `.worktrees/wp-15/` trifft
  `**/.worktrees/**` daher *jede* Datei (Probe oben) → kein HMR im Playground, `pnpm test:watch`
  reagiert nicht. Genau dort entwickeln WP-15/16 UI-lastig gegen den Playground. Im
  Haupt-Checkout ist das Muster für Vite sogar überflüssig: Vite beobachtet nur `root`
  (`src/web`), Config-Abhängigkeiten und importierte Dateien – nie `.worktrees/`. Unkritisch sind:
  Vitest `test.exclude` (tinyglobby, relativ zur Wurzel), ESLint `globalIgnores('.worktrees/**')`
  (relativ zur Config), tsconfig `exclude` (relativ), `tsx watch --exclude` (chokidar mit `cwd`).
  Ebenfalls fragil: `'**/dist/**'`/`'**/.tsbuild/**'` treffen jeden Pfad, der irgendwo `dist`
  enthält.
- **Fix (Owner: Koordinator, Root-Configs):** an der Wurzel verankerte Matcher-Funktionen
  (Vite-Typ `AnymatchFn` ist erlaubt), `worktreeGlobs` bleibt nur für Vitest `exclude`:
  ```ts
  // repo.config.ts
  /** True for paths inside `dir` (case-insensitive on Windows via path.relative). */
  function insideDir(dir: string): (file: string) => boolean {
    return (file) => {
      const rel = path.relative(dir, path.resolve(file));
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    };
  }

  /**
   * File-watcher ignores anchored at THIS checkout (Vite/Vitest use chokidar on absolute paths: a
   * relative glob like `**\/.worktrees/**` would also hide every file of a checkout that itself
   * lives in `.worktrees/<wp>`). `worktreeGlobs` stays for root-relative globs (Vitest exclude).
   */
  export function watchIgnores(repoRoot: string): ((file: string) => boolean)[] {
    return ['.worktrees', '.claude/worktrees', 'dist', '.tsbuild'].map((dir) => insideDir(path.join(repoRoot, dir)));
  }
  ```
  ```ts
  // vite.config.ts (server.watch)            // vitest.config.ts (server.watch)
  watch: { ignored: watchIgnores(repoRoot) },  watch: { ignored: watchIgnores(repoRoot) },
  ```
  Test (Koordinator, `test/`): `watchIgnores('D:/r')` ignoriert `D:/r/.worktrees/wp-15/src/x.ts`
  und `D:/r/dist/a.js`, aber nicht `D:/r/src/x.ts`; `watchIgnores('D:/r/.worktrees/wp-15')`
  ignoriert `D:/r/.worktrees/wp-15/src/web/App.tsx` **nicht**. Abnahme manuell im Worktree:
  `pnpm exec vite --port 5175`, Datei ändern → HMR. Danach `docs/wp/WP-14.md` §2.8 und den
  Follow-up in `docs/progress.md` schließen.

#### R1W-02 [BLOCKER vor Welle 1b] Kein Selektor für abgeleitete Session-Daten (Gruppierung, Meta)
- **Fundstelle:** `src/web/state/hooks.ts:154-162` (`useSessionState`/`useSessionView` liefern
  Objekte, die sich mit **jedem** Delta-Frame ändern), `:202-211` (`useItemIds`: flach, alle Items),
  `:149-151` (`selectSessionRecord` nicht exportiert); `docs/architecture.md:637`, plan.md B
  „Message-Routing“ (Subagent-Items unter der Agent-Karte, Phase 1 eingeklappt).
- **Begründung:** WP-15 braucht für die virtualisierte Liste **Top-Level-Zeilen**
  (`parentToolUseId === null`) und je Agent-Karte die Kind-IDs; beides darf sich bei Deltas nicht
  ändern. `useItemIds` enthält auch Subagent-Items (Zeilen mit Höhe 0 oder falsche Reihenfolge),
  `useItem` lässt sich nicht in Schleifen rufen. Ebenso brauchen WP-15/16 `hasEarlier`,
  `loading`, `unavailable`, `conversationId` – heute nur über `useSessionView`/`useSessionState`,
  also mit Re-Render pro Frame. Ohne Hook importieren die Features `clientStore` + `useStore`
  direkt und koppeln sich an die Store-Form (`state.sessions[key].view`), die WP-14 dann nie mehr
  ändern kann – in Welle 1b ist `state/` read-only.
- **Fix (Owner: WP-14, vor 1b):** in `hooks.ts`
  ```ts
  /**
   * Derived data of one session view, compared shallowly (arrays/objects of primitives or stable
   * references). `select` must be pure; cache expensive results per `view.items` (WeakMap), like
   * useItemIds. Subscribes the session.
   */
  export function useSessionSelector<T>(sessionKey: string | null, select: (view: SessionViewState) => T, fallback: T): T;
  /** { hasView, loading, unavailable, hasEarlier, conversationId } – stable across deltas. Subscribes. */
  export function useSessionMeta(sessionKey: string | null): SessionMeta;
  ```
  (Umsetzung mit `useShallow`; `selectSessionRecord` intern wiederverwenden.) Tests: Selektor auf
  Top-Level-IDs bleibt bei `item.delta` referenzgleich, ändert sich bei neuem Subagent-Item nicht
  für die Top-Level-Liste. In `WP-14.md` §2.2 und `state/README.md` dokumentieren; im WP-15-Auftrag
  vorgeben: Liste = `useSessionSelector(key, topLevelIds)` + `useItem` je Zeile.

#### R1W-03 [BLOCKER vor Welle 1b] `DecisionCard`-Slot: Verhalten nach Auflösung und Doppel-Platzierung ungeregelt
- **Fundstelle:** `src/web/shell/slots.tsx:30-35` (Props `{sessionKey, decisionId, placement}`),
  `src/web/state/hooks.ts:222-229` (`useDecision` → `null` nach `decision.resolved`),
  `src/shared/sync.ts:159-163` (Entscheidung verschwindet aus `decisions`, Outcome nur in
  `tool_call.decision`), `docs/architecture.md:183`, `docs/wp/WP-02.md:1961-1962`.
- **Begründung:** WP-15 rendert die Plan-Karte im Transkript über den Slot (`placement:
  'transcript'`), WP-16 liefert die Karte und zeigt dieselbe offene Entscheidung zusätzlich in der
  Leiste (`placement: 'bar'`). Offen ist (a) **wer nach `decision.resolved` rendert** – die Karte
  bekommt dann `null` und kennt weder `tool_call.decision.outcome` noch den Plantext, WP-15 weiß
  nicht, ob es selbst den „freigegeben/überarbeitet“-Zustand zeigen soll; (b) ob die Karte im
  Transkript **interaktiv** ist, während dieselbe Entscheidung in der Leiste bedienbar ist (zwei
  bedienbare Kopien, doppelte Kürzel-/Fokusfragen); (c) wie abgelaufene Pläne (`state:'expired'`,
  „Fortsetzen & Plan freigeben“) in beiden Platzierungen aussehen. Beide Pakete laufen parallel und
  würden das jeweils anders lösen (Lücke oder Doppelung).
- **Fix (Owner: Koordinator – Regel in `docs/architecture.md` §2.3e + WP-15/16-Aufträge;
  Code nur falls Variante B):**
  Vorschlag **Variante A (ohne Code):** `DecisionCard` rendert offene und abgelaufene
  Entscheidungen (`useDecision ≠ null`) und gibt nach Auflösung `null` zurück. `placement:'bar'`
  ist die **einzige bedienbare** Instanz; `placement:'transcript'` zeigt Plantext + Status +
  Schaltfläche „Zur Entscheidung“ (fokussiert die Leiste, kein eigener Fokus-Diebstahl). Nach der
  Auflösung zeigt WP-15 den Endzustand selbst aus `tool_call.decision.outcome` und
  `tool_call.input` (Plantext über eigenen Markdown-Renderer). **Variante B:** additives Prop
  `resolved?: ToolDecisionRef` (WP-14, `slots.tsx` + Platzhalter), damit WP-16 auch den Endzustand
  einheitlich zeichnet. Entscheidung vor dem Start von 1b.

### SOLLTE (vor WP-20)

#### R1W-04 [SOLLTE] `SessionPane` rendert alle Slots bei jedem Delta-Frame und jeder Summary-Änderung des Hosts neu
- **Fundstelle:** `src/web/shell/SessionPane.tsx:29-31` (`useSummary`, `useSessionState`,
  `useHostRecord`), `:65-88` (Header und Slots ohne Memo); `src/web/state/connection.ts:574`
  (`updates[key] = { ...record, view, loading }`), `:468-472` (`summary.upsert` → neues
  `HostRecord`).
- **Begründung:** B „Zustand-Selektoren pro Session“. `useSessionState` liefert den ganzen
  `SessionRecord` (neue Identität bei jedem angewandten Frame), `useHostRecord` den ganzen
  Host-Record, der die Summaries **aller** Sessions enthält. Folge: Beim Streaming rendert die Pane
  mit jedem angewandten Delta-Bündel neu (Hub bündelt alle 40 ms → bis ~25×/s) und mit ihr `Transcript`, `DecisionBar`, `Composer`, `SidePanel` und
  `SessionHeader`; zusätzlich bei jeder `summary.upsert` irgendeiner Session des Hosts (bei 20
  arbeitenden Sessions mehrere pro Sekunde). Genau die Komponenten von WP-15/16 hängen darunter;
  Composer-Eingaben während Streaming und Messungen im Playground werden verfälscht. Die
  Per-Item-Selektoren (`useItem`) sind korrekt – die Isolation geht eine Ebene höher verloren.
- **Fix (Owner: WP-14):** `SessionPane` nur noch über schmale Selektoren: `useSessionMeta(key)`
  (R1W-02: `hasView`, `unavailable`), `summariesLoaded` per `useStore(clientStore, s =>
  s.hosts[h]?.summariesLoaded ?? false)` (z. B. `useSummariesLoaded(hostId)`), Titel/Existenz statt
  ganzer Summary; `SessionHeader` liest seine Summary selbst und ist `memo`. Test in `App.test.tsx`:
  Render-Zähler im `Transcript`-Slot bleibt bei Deltas derselben Session und `summary.upsert` einer
  anderen Session konstant. Bis dahin im WP-15/16-Auftrag: exportierte Slot-Komponenten mit
  `memo()` umschließen.

#### R1W-05 [SOLLTE] Sidebar: jede Summary-Änderung rendert alle Zeilen neu
- **Fundstelle:** `src/web/shell/Sidebar.tsx:127-130` (`orderSessions` erzeugt neue
  `DisplayStatus`-Objekte), `:39-47`/`:188-197` (`memo(SessionRow)` mit Prop `status`),
  `src/web/lib/session-order.ts:21`.
- **Begründung:** `memo` greift nie, weil `status` bei jeder Änderung von `entries` für **jede**
  Zeile ein neues Objekt ist; jede Zeile enthält einen Radix-Tooltip. Bei n arbeitenden Sessions
  (Aktivität ≤ 1/s je Eintrag) sind das n² Zeilen-Renders pro Sekunde – „viele parallele Sessions“
  ist der Produktzweck.
- **Fix (Owner: WP-14):** `SessionRow` primitive Props geben (`kind`, `unread`, `title`,
  `lastActivityAt`, `now`) **oder** `DisplayStatus` je `StatusFacts`-Objekt in einer `WeakMap`
  cachen (bei zeitabhängigen Fakten zusätzlich nach `now` schlüsseln). Test: `summary.upsert` einer
  Session rendert nur deren Zeile.

#### R1W-06 [SOLLTE] Shortcut-API für WP-16: Esc-Handler ohne Event/Scope, Scope nur per Name
- **Fundstelle:** `src/web/shell/shortcuts.ts:177-184` (`pushEscape(handler: () => boolean)`),
  `:190-198`, `:205-208` (Scope = `closest('[data-shortcut-scope="<name>"]')`), `:274-280`
  (`useEscapeHandler`); plan.md B „Tastatur“ („Entscheidungs-Kürzel nur bei Fokus der Leiste“,
  „Stop über Esc bei leerem Composer“).
- **Begründung:** (a) Der Esc-Stapel ist global: Ein Stop-Handler von WP-16 feuert bei Esc auch,
  wenn der Fokus im Transkript oder in der Sidebar liegt – ein versehentliches Esc bricht einen
  langen Agent-Lauf ab. Der Handler bekommt weder Event noch Ziel und kann nur über
  `document.activeElement` raten. (b) Scopes sind namensbasiert: Bei zwei Panes (Split-View ist
  vorbereitet, `PaneLayout`) registrieren beide Leisten dieselbe ID/Scope; der zuletzt
  registrierte Handler gewinnt und handelt auf der **falschen** Session.
- **Fix (Owner: WP-14, additiv):** `useEscapeHandler(handler: (event: KeyboardEvent) => boolean,
  enabled, options?: { scope?: string; scopeRef?: RefObject<HTMLElement | null> })` und
  `ShortcutDefinition.scopeRef` – die Registry prüft `scopeRef.current?.contains(target)`.
  Regel im WP-16-Auftrag (Koordinator): Esc-Stop nur bei Fokus im Composer (Scope `composer`) und
  leerem Eingabefeld; Entscheidungs-Kürzel mit `scopeRef` der eigenen Leiste.

#### R1W-07 [SOLLTE] Keine API für lokale In-App-Hinweise
- **Fundstelle:** `src/web/shell/NotificationCenter.tsx:25-95` (zeigt nur Server-`notify`),
  `src/web/state/store.ts:80-84` (`ClientNotification extends Notification` aus dem Protokoll).
- **Begründung:** WP-15 (Kopieren, „Volltext laden“ fehlgeschlagen) und WP-16 (Prompt nicht
  gesendet, `DECISION_ALREADY_RESOLVED` aus anderem Fenster, Einstellungsfehler) brauchen
  kurzlebige Hinweise. Ohne API baut jedes Feature eigene Toast-Regionen (Duplikat, zwei
  Live-Regionen, uneinheitliches Verhalten); `SettingsMenu` verschluckt Fehler heute stumm
  (`SettingsMenu.tsx:20-23`, Text `settings.saveFailed` existiert, wird nie gezeigt).
- **Fix (Owner: WP-14):** `state/notices.ts`: `showNotice({ tone, text: TranslationKey, params? }
  | { tone, error: ErrorPayload }, { sessionKey?, durationMs? }) → id`, `dismissNotice(id)`,
  `useNotices()`; Darstellung in der bestehenden Region des `NotificationCenter`
  (`role="status"`, Fehler `role="alert"`), Übersetzung beim Rendern (Sprachwechsel). Alternativ
  Koordinator-Regel „Fehler nur inline an der auslösenden Komponente“ in die 1b-Aufträge.

#### R1W-08 [SOLLTE] Importgrenzen der Features nicht per ESLint erzwungen
- **Fundstelle:** `eslint.config.js:86-89` (Web: nur Server-Grenze); Regeln in `CLAUDE.md:51-53`,
  `docs/architecture.md:164-165`, `:190`, `src/web/README.md`.
- **Begründung:** „Features importieren einander nie“, „direkte `radix-ui`-Importe nur in
  `src/web/ui`“ und „nur `state/*` schreibt den Store“ sind reine Konvention. WP-15 und WP-16
  laufen parallel; ein Querimport fällt sonst erst in R2 auf.
- **Fix (Owner: Koordinator, `eslint.config.js`):** je Feature ein Block – **Achtung:** ein
  späterer Flat-Config-Block ersetzt die Optionen von `no-restricted-imports`, daher die
  Basis-Muster wiederholen:
  ```js
  const featureBoundary = (others) => ({
    regex: String.raw`^(?:@web/features/|(?:\.\./)+)(?:${others.join('|')})(?:/|$)`,
    message: 'Features never import each other – use FeatureSlots (src/web/shell/slots.tsx).',
  });
  const radixOnlyInUi = { regex: String.raw`^(?:radix-ui|@radix-ui/)`, message: 'Use the primitives from src/web/ui.' };
  const storeWriters = { name: '@web/state/store', importNames: ['clientStore', 'updateHost', 'updateSession', 'removeSessions', 'resetClientStore'], message: 'Read through @web/state/hooks; only state/* writes the store.' };
  // files: src/web/features/transcript/** → patterns: [noServerInWeb, serverOnlyPackages, radixOnlyInUi, featureBoundary(['decisions', 'composer'])], paths: [storeWriters]
  // files: src/web/features/{decisions,composer}/** → featureBoundary(['transcript']) (decisions ↔ composer gehören beide WP-16)
  // files: src/web/{shell,state,lib,i18n,playground}/** → radixOnlyInUi
  ```
  Probe per `--stdin` wie in R0 (Querimport → Fehler).

#### R1W-09 [SOLLTE] Bundle 569 kB in einem Chunk – Splitting festlegen, bevor WP-15 Markdown/Shiki bringt
- **Fundstelle:** `vite.config.ts:46-50` (kein Splitting), Build-Ausgabe oben; `docs/wp/WP-14.md`
  §2.9; plan.md B „Shiki … lädt Sprachen lazy“.
- **Begründung:** Heute schon über der Warnschwelle (react-dom, zod, Radix, tailwind-merge). WP-15
  ergänzt streamdown (unified/remark/rehype, marked), shiki (Grammatiken, Themes) und `diff`;
  eager importiert wächst der Start-Chunk um ein Vielfaches (Parse-Zeit bei jedem Fenster und nach
  jedem Build-Reload). `chunkSizeWarningLimit` hochzusetzen versteckt das nur.
- **Fix:** (1) **Koordinator** (`vite.config.ts`): Vendor-Gruppen, Warnschwelle bleibt als Wächter:
  ```ts
  build: {
    // …
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor', test: /[\\/]node_modules[\\/]/ },
          ],
        },
      },
    },
  },
  ```
  (2) **WP-15-Auftrag:** Markdown-Renderer und Diff per `React.lazy`/`import()` hinter dem
  Platzhalter-Text; Shiki über `shiki/core` + einzelne `@shikijs/langs/*` per `import()` nur für
  geschlossene Code-Blöcke; Budget z. B. „Start-Chunk ≤ 600 kB, Feature-Chunks lazy“ als
  Abnahme (`pnpm build`-Ausgabe im Bericht).

### NIT

#### R1W-10 [NIT] `useNowUntil` rendert bei **jedem** Uhr-Tick neu, nicht erst an der Deadline
- **Fundstelle:** `src/web/state/clock.ts:96-109` (Snapshot = rohes `now`), `hooks.ts:109-113`.
- **Begründung:** Sobald irgendwo `useNow(1000)` läuft (Countdown in `HostGate`/Banner, später
  Laufzeiten von Tool-Calls in WP-15), rendern alle `useDisplayStatus`-Nutzer jede Sekunde neu und
  erhalten ein neues `DisplayStatus`-Objekt. Doku verspricht „re-render when the earliest future
  deadline passes“.
- **Fix:** Snapshot = Anzahl bereits überschrittener Deadlines (ändert sich nur an der Deadline);
  `useDisplayStatus` liest die Zeit im Memo über `getClockNow()`.

#### R1W-11 [NIT] Kein Timeout für `hello`
- **Fundstelle:** `src/web/state/connection.ts:327-340`, `transport.ts:38-57`.
- **Begründung:** Nimmt der Server die Verbindung an, sendet aber kein `hello` (hängender Prozess),
  bleibt der Client unbegrenzt in `connecting` ohne Retry-Knopf.
- **Fix:** Timer (z. B. 10 s) nach `openTransport`; ohne `hello` → `closeTransport()` +
  `scheduleReconnect(CONNECTION_LOST)`; Test.

#### R1W-12 [NIT] Reload-Guard ohne sessionStorage → Reload-Schleife
- **Fundstelle:** `src/web/state/client-id.ts:35-43`, `lib/storage.ts:27-33`,
  `connection.ts:384-391`.
- **Begründung:** Ist sessionStorage gesperrt (Richtlinie, Profilfehler), liefert `read()` immer
  `null` → jeder Versionskonflikt lädt sofort neu, endlos.
- **Fix:** `storageAvailable(kind)` in `lib/storage.ts`; ohne Storage kein Auto-Reload (direkt
  Banner); Test.

#### R1W-13 [NIT] Sekunden-Countdown in einer Live-Region
- **Fundstelle:** `src/web/shell/ShellBanners.tsx:53-56` in `Banner role="status"`
  (`ui/alert.tsx:81`), `HostGate.tsx:43-53`.
- **Begründung:** Screenreader sagen jede Sekunde „Neuer Versuch in n Sekunden“ an.
- **Fix:** Countdown mit `aria-live="off"` (bzw. nur die Zahl `aria-hidden` und den Text einmalig).

#### R1W-14 [NIT] Kleine Duplikate von Shared-Regeln
- **Fundstelle:** `src/web/state/hooks.ts:83` (`${host.hostId}:${summary.entryId}`),
  `connection.ts:367` (Präfix `${hostId}:`) statt `makeSessionKey`/`parseSessionKey`;
  `src/web/shell/EmptyState.tsx:39` (`cwd.toLowerCase()`) statt `windowsPathKey` (`@shared/paths`,
  CLAUDE.md „Pfadregeln … nie duplizieren“).
- **Fix:** Shared-Helfer verwenden.

#### R1W-15 [NIT] Fehlerparameter werden nie angezeigt
- **Fundstelle:** `src/web/i18n/errors.en.ts`/`errors.de.ts` (kein Platzhalter), `i18n/index.ts:114-125`.
- **Begründung:** `PATH_REJECTED.reason` (UNC, ADS …), `COMMAND_TIMEOUT.name`,
  `PROFILE_*.flag/index` gehen verloren; Objekt-Parameter würden als `[object Object]` erscheinen.
- **Fix:** Unterwörterbuch `errors.reasons.<PathIssue>` o. ä. und Platzhalter in den betroffenen
  Texten; Objektwerte überspringen statt `String(value)`.

#### R1W-16 [NIT] `Alt+1…9` in Eingabefeldern bricht Windows-Alt-Codes
- **Fundstelle:** `src/web/shell/Sidebar.tsx:137-149` (`allowInInputs: true`), `shortcuts.ts:114-121`.
- **Begründung:** Alt+Numpad-Ziffern (z. B. Alt+0169) wechseln die Session und unterdrücken das
  Zeichen im Composer.
- **Fix:** In `matchesShortcut` Alt-Kombinationen mit `event.code.startsWith('Numpad')` ignorieren.

#### R1W-17 [NIT] Versionskonflikt-Text passt nicht, wenn nur ein Bundle neu gebaut wurde
- **Fundstelle:** `src/web/i18n/en.ts:170-171` (+ `de.ts`).
- **Begründung:** Läuft der Server mit altem `dist/server.js`, während `dist/web` neu ist, hilft
  „Reload to continue“ nicht (gleicher Konflikt nach dem Reload, dann Banner).
- **Fix:** Text um „falls es bleibt: Parallax neu starten“ ergänzen.

#### R1W-18 [NIT] Store-Reste nach Full-Resync bzw. verspätetem Snapshot
- **Fundstelle:** `connection.ts:439-447` → `releaseNow` (`:606-618`) legt nach `fullResync` leere
  Records an; `:480-490` speichert einen `session.snapshot` auch ohne Abo (nie im LRU, nie verdrängt).
- **Fix:** `releaseNow` ohne `updateSession`, wenn kein Record existiert; Snapshots/Ops ohne Abo und
  ohne Cache-Eintrag verwerfen.

#### R1W-19 [NIT] `NotificationCenter`: Timer ohne Cleanup, `handled` wächst
- **Fundstelle:** `src/web/shell/NotificationCenter.tsx:29`, `:47-49`.
- **Fix:** Timer-IDs merken und beim Unmount löschen; `handled` auf aktuelle IDs beschneiden.

#### R1W-20 [NIT] Slots `Markdown`/`ToolInputPreview` ohne `sessionKey`
- **Fundstelle:** `src/web/shell/slots.tsx:36-39`.
- **Begründung:** Gekappte Input-Strings und Bilder liegen als Blob **pro Host**
  (`/api/blob/:id`); ohne `sessionKey` kann der Renderer bei Multi-Host nicht den richtigen Host
  wählen. Additiv nachrüstbar, aber billiger vor 1b.
- **Fix:** optionales `sessionKey?: string` in beiden Slot-Props (+ Platzhalter), WP-16 reicht es
  durch.

#### R1W-21 [NIT] Speicher-Schlüssel für Entwürfe ohne Regel
- **Fundstelle:** `src/web/lib/storage.ts:10-17` („All keys … one place“), architecture §2.4
  (Entwürfe in `features/composer/state/`).
- **Begründung:** WP-16 kann `STORAGE_KEYS` nicht erweitern (read-only) und erfindet eigene Präfixe.
- **Fix:** Helfer `storageKey(namespace, …parts)` (`parallax.<feature>.<name>`) bzw. Regel im
  WP-16-Auftrag: `parallax.composer.draft.<sessionKey>`, bei jeder Änderung schreiben (Reload nach
  neuer `buildId`!), bei `summary.remove` löschen.

#### R1W-22 [NIT] FakeHost-Lücken für 1b-Demos
- **Fundstelle:** `src/web/state/fake-host.ts:402-419` (`decision.respond` ohne `item.upsert` von
  `tool_call.decision`), `:450` (`session.interrupt` stoppt kein Streaming, keine Queue in
  `detail.queue`), `:471-472` (`transcript.loadEarlier` immer leer).
- **Begründung:** Über `onCommand` umgehbar, aber WP-15/16 müssten dieselben Server-Simulationen
  doppelt bauen.
- **Fix:** Standardverhalten ergänzen (Outcome ins `tool_call`, Queue bei `priority:'next'`
  während `working`, Interrupt beendet Streaming, `loadEarlier` aus einem Vorrat älterer Items) oder
  im WP-15/16-Auftrag ausdrücklich auf `onCommand` verweisen.

#### R1W-23 [NIT] Dev-Umgebung: fester Port 5173 und keine CSP im Dev-Server
- **Fundstelle:** `vite.config.ts:36-37` (`strictPort`), Seiten-CSP nur im Server
  (`src/server/http/app.ts:63-76`).
- **Begründung:** WP-15, WP-16 und der Verifier wollen gleichzeitig Playgrounds starten; CSP-Fehler
  (z. B. Shiki-WASM, Inline-Styles) zeigen sich erst im gebauten Bundle (WP-20).
- **Fix:** In den Aufträgen Ports festlegen (`pnpm exec vite --port 5175` WP-15, `5176` WP-16);
  optional Dev-CSP über `server.headers` mit `html.cspNonce` (Vite 8 unterstützt beides);
  spätestens WP-20: E2E lauscht auf `securitypolicyviolation` und schlägt fehl.

#### R1W-24 [NIT] Token-/Konventions-Kleinkram
- **Fundstelle:** `src/web/ui/dialog.tsx:32` (`bg-black/45` statt Token, z. B. `--overlay`);
  `ui/tooltip.tsx:13-19` (jeder `Tooltip` mit eigenem `Provider` – Delay/`skipDelayDuration` des
  App-Providers wirkungslos); `state/theme.test.tsx:23` (`as unknown as MediaQueryList`, CLAUDE.md
  „kein `any` … auch nicht über `as`“, R0).
- **Fix:** Overlay-Token in `index.css`; Provider nur in `TooltipProvider`; Test-Stub typisieren.

#### R1W-25 [NIT] Kleine Komfort-Hooks fehlen
- **Fundstelle:** `src/web/state/{hooks,theme}.ts`.
- **Begründung:** WP-15 braucht das aufgelöste Theme (Shiki hell/dunkel), WP-16 den Verbindungs-
  status des Hosts einer Session (Senden deaktivieren) und ggf. Fokus/Typing; heute nur aus
  Bausteinen zusammensetzbar (`resolveTheme(useSettings().theme, useSystemPrefersDark())`,
  `useConnectionStatus(parseSessionKey(key)?.hostId)`, `clientStore.presence` ohne Hook).
- **Fix:** `useResolvedTheme()`, `useSessionConnectionStatus(sessionKey)`, `useWindowPresence()`.

#### R1W-26 [NIT] Multi-Host-Reste in der Shell
- **Fundstelle:** `src/web/shell/Sidebar.tsx:126`, `:186` (Profile nur vom lokalen Host für alle
  Einträge), `ShellEffects.tsx:22` (Settings nur lokal – Phase 1 korrekt).
- **Fix:** Profil über `useHostState(entry.hostId)` auflösen, sobald ein zweiter Host möglich ist.

---

## Hinweise für die Aufträge WP-15/16 (keine WP-14-Befunde, Koordinator übernimmt)

- **streamdown 2.7 ist nicht sicher per Default:** Default-Rehype-Kette ist `raw → sanitize →
  harden{allowedProtocols:['*'], allowedLinkPrefixes:['*'], allowDataImages:true}`. WP-15 setzt
  `rehypePlugins` **explizit ohne `rehype-raw`**, Links nur `http:`/`https:` (Sanitize-Default
  erlaubt sonst `mailto`, `irc`, `xmpp`), Bilder → Link/Platzhalter (CSP `img-src 'self' data:
  blob:` blockiert fremde Bilder ohnehin), keine Mermaid/KaTeX in Phase 1, eingebaute
  englische Control-Texte über die Übersetzungs-Props mit `t()` belegen oder Controls abschalten.
- **Shiki und CSP:** Die Oniguruma-Engine braucht WebAssembly; `script-src 'self'` ohne
  `'wasm-unsafe-eval'` blockiert das. WP-15 nutzt `createJavaScriptRegexEngine` (`shiki/core` +
  `shiki/engine/javascript`), lädt lazy (R1W-09), Themes dual über CSS-Variablen/`.dark`.
- **Render-Isolation:** Slot-Komponenten `memo()` (bis R1W-04 behoben); Liste über
  `useSessionSelector` + `useItem` (R1W-02); Composer liest `useSessionDetail`, nie
  `useSessionView`.
- **Entscheidungen:** Karten nie `role="dialog"` (die Registry behandelt Dialoge als Overlay und
  reicht Esc dann nicht weiter), kein `autoFocus` bei neuen Entscheidungen, Kürzel nur mit Scope der
  eigenen Leiste, Fokus in die Leiste nur durch Nutzeraktion; Regel aus R1W-03 übernehmen.
- **Composer:** Entwürfe nach R1W-21, Esc-Stop nach R1W-06, `reportTyping()` bei Eingabe.
- **Tests:** `startScenario()`/`FakeHost` nutzen globale Stores – `running.stop()` und
  `resetClientStore()` in `afterEach`; nur ein `<PlaygroundScenario>` je Demo.

## Fix-Auftrag Web (nur BLOCKER + SOLLTE)

Reihenfolge = Priorität. Kein Contract betroffen (`src/shared/**` bleibt unverändert).

**Vor Welle 1b (BLOCKER):**
1. **R1W-01 (Koordinator):** `watchIgnores(repoRoot)` (an der Wurzel verankerte Matcher) in
   `repo.config.ts`; `vite.config.ts` und `vitest.config.ts` `server.watch.ignored` umstellen;
   Test in `test/`; HMR im Worktree manuell prüfen; WP-14.md §2.8/Follow-up schließen.
2. **R1W-02 (WP-14):** `useSessionSelector(key, select, fallback)` und `useSessionMeta(key)` in
   `state/hooks.ts` + Tests + Doku (`WP-14.md` §2.2, `state/README.md`).
3. **R1W-03 (Koordinator, ggf. WP-14):** Regel für `DecisionCard` (Variante A empfohlen: Leiste
   einzig bedienbar, Transkript-Platzierung lesend mit „Zur Entscheidung“, Endzustand rendert WP-15
   aus `tool_call.decision`) in `docs/architecture.md` §2.3e und den WP-15/16-Aufträgen; bei
   Variante B additives Prop `resolved?: ToolDecisionRef` in `slots.tsx`.

**Vor WP-20 (SOLLTE; R1W-04 am besten gleich mit 2):**
4. **R1W-04 (WP-14):** `SessionPane` auf schmale Selektoren (`useSessionMeta`,
   `summariesLoaded`), `SessionHeader` memo; Render-Zähler-Test.
5. **R1W-05 (WP-14):** Sidebar-Zeilen mit primitiven Props bzw. `DisplayStatus`-Cache; Test.
6. **R1W-06 (WP-14 + Koordinator):** Esc-Handler mit Event und `scope`/`scopeRef`,
   `ShortcutDefinition.scopeRef`; Esc-Stop-Regel in den WP-16-Auftrag.
7. **R1W-07 (WP-14 oder Koordinator-Regel):** `state/notices.ts` + Anzeige im
   `NotificationCenter` (inkl. `settings.saveFailed`) **oder** Regel „Fehler nur inline“.
8. **R1W-08 (Koordinator):** ESLint-Blöcke für Feature-Grenzen, Radix nur in `ui/`, keine
   Store-Writer-Importe in Features; `--stdin`-Probe.
9. **R1W-09 (Koordinator + WP-15-Auftrag):** `codeSplitting`-Gruppen in `vite.config.ts`;
   Lazy-Regeln und Chunk-Budget für Markdown/Shiki/Diff in den WP-15-Auftrag.
