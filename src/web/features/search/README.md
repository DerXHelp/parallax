# src/web/features/search – Volltextsuche (Ausbau 1)

Owner: **WP-115**. Auftrag: `docs/wp/WP-110.md` §3.6, §6 und §8; Entscheidung ADR-255; Ergebnis `docs/wp/WP-115.md`.

Feature importiert keine anderen Features; Querverbindungen über `src/web/shell/requests.ts` (`search.open`,
`revealItem`). Nur Rechner mit `HostState.features.search`.

| Datei | Inhalt |
|---|---|
| `index.ts` | `SEARCH_SLOTS` (Slot `SearchDialog`, Verdrahtung in `App.tsx` durch den Koordinator). Eager nur der Slot: nimmt die Anfrage `search.open {text?}` und Strg+Umschalt+F (`SEARCH_SHORTCUT_KEYS`, auch im Textfeld) – ohne suchenden Rechner bleiben beide frei (`false`). Der Dialog ist ein Lazy-Chunk, geladen beim ersten Öffnen; jede Anfrage baut den Inhalt neu auf (Text aus Strg+K ersetzt den alten) |
| `SearchDialog.tsx` | Dialog (Default-Export): Combobox-Feld (`ui/command-list`, `maxLength = LIMITS.searchTextMax`), Schalter „Archivierte einbeziehen“ (Standard an) und „Werkzeugausgaben“, Status (`aria-live`), Treffer gruppiert je Session (`role="group"`: Titel, Projekt = Repository bei Worktrees, Archiviert, Rechner-Badge, Zahl, Zeit), je Treffer Art und Ausschnitt mit `<mark>`; Fehler eines Rechners als `Alert role="alert"`, gekürzte Antwort als Hinweis. Pfeile/Bild-Tasten, Enter oder Klick: Session wählen (Archiv-Ansicht passend), Dialog schließen, Fokus ins Eingabefeld der Session, `revealSearchHit`. Esc schließt, Fokus zurück. Text und Schalter bleiben im Modulspeicher (`resetSearchMemory` für Tests) |
| `lib/use-content-search.ts` | `useSearchHosts()` (dieser Rechner zuerst, dann die anderen in Anzeige-Reihenfolge: `features.search`, offene Verbindung, `canSendTo(…, 'search.query')`), `useContentSearch(query, hosts, delayMs)` – entprellt (`SEARCH_DEBOUNCE_MS` beim Tippen, 0 beim Öffnen und für Schalter), ab `LIMITS.searchTextMin` Zeichen, ein `search.query` je Rechner, Antworten im Ack; `SEARCH_FAILED {superseded}` still ignoriert; während eine neue Anfrage läuft, bleiben die alten Treffer sichtbar (`stale`) |
| `lib/results.ts` | rein: `mergeHostHits` (neueste zuerst über alle Rechner, Gleichstand nach Rechner-Reihenfolge), `groupHits` (je Session in Reihenfolge des neuesten Treffers, `start` = Index der ersten Option), `snippetParts` (Bereiche klemmen, sortieren, überlappende/anstoßende zusammenfassen, leere verwerfen – nie HTML) |
| `lib/reveal.ts` | `revealSearchHit(request)`: schickt `revealItem`, wiederholt alle `REVEAL_RETRY_MS`, bis ein Transkript es nimmt (höchstens `REVEAL_TIMEOUT_MS`); ein neuer Sprung bricht einen wartenden ab (`cancelPendingReveal`) |
| `i18n/{en,de}.ts` | Namensraum `search` (eager registriert in `src/web/i18n/dictionaries.ts`) |
| `*.test.ts(x)`, `i18n/i18n.test.ts` | Dialog mit FakeHost (`onCommand` für `search.query`): frei ohne Rechner, sofortige Anfrage mit Text, Entprellen und Schalter, `superseded`/Fehler, Tastatur → Session + `revealItem`, wartender Sprung; reine Helfer; Wörterbuch-Parität und jeder Schlüssel benutzt |

Der Sprung selbst liegt im Transkript (`features/transcript/state/reveal.ts`, WP-115): Item im geladenen Teil →
scrollen und kurz markieren; weiter zurück → `loadEarlier`; andere Konversation → Ausschnitt per
`transcript.loadAround`.
