# src/web/lib – Web-Helfer (WP-14)

Einziger Ort für generische Web-Helfer. **Vor dem Anlegen greppen**, ob es den Helfer schon
gibt (auch in `src/shared`, z. B. `@shared/paths` für Pfadregeln).

| Datei | Inhalt |
|---|---|
| `cn.ts` | Klassen zusammenführen (clsx + tailwind-merge), shadcn-Konvention |
| `ids.ts` | `newClientId()` (`cl_` + 32 Hex), `newCmdId()` (UUID) |
| `backoff.ts` | `backoffDelay(attempt, options, random)`, `DEFAULT_BACKOFF` (0,5 s → 15 s, ±20 %) |
| `hash.ts` | `#a=1&flag`-Parameter: `parseHash`, `formatHash`, `getHashParam`, `setHashParam` |
| `storage.ts` | sicheres `localStorage`/`sessionStorage` (`readStorage`, `writeStorage`, `storageAvailable`, `STORAGE_KEYS` inkl. `sidebarMode`), Feature-Schlüssel `storageKey(namespace, …parts)` → `parallax.<namespace>.<…>` |
| `path-display.ts` | nur Anzeige: `pathTail(path, n)` (`D:\1\2\3\4` → `3\4`), `shortPath(path, n)` (`…\3\4`), `splitPathTail(path, n)` → `{ head, separator, last }` (`head + separator + last = pathTail`; Ansicht kürzt nur `head`, das letzte Segment bleibt ganz – WP41-02, `shell/navigation/PathTail.tsx`) |
| `zod-jitless.ts` | Seiteneffekt-Modul (erster Import in `main.tsx`): zod ohne `eval`-JIT (CSP) |
| `session-order.ts` | `orderSessions(entries, now)` – Sidebar-Reihenfolge (sortBucket, Aktivität, Anzeigetitel); Phase 2 (WP-35): `flatSidebarOrder` (angeheftete zuerst), `groupSessions`/`groupedOrder` (Gruppe = `windowsPathKey(cwd)`, je Host), `archivedOrder`, `nextWaiting` (Alt+N, zyklisch), `waitingFirst`, `pinnedFirst` |
| `fuzzy.ts` | `fuzzyScore(query, text)` (null = kein Treffer; Wortanfänge, Folgen, ohne Akzente), `fuzzyFilter(items, query, keys, options?)` (jedes Wort in irgendeinem Schlüssel, beste zuerst; `options.strict` verwirft Streutreffer, `options.keyPenalty` lässt frühere Schlüssel knappe Gleichstände gewinnen – V3-03) – WP-35, genutzt von WP-36/37 |
| `model-name.ts` | `shortModelName(model)` – opus/sonnet/haiku/fable oder der Custom-Name |
| `windows.ts` | `openSessionWindow(entryId)` (`window.open(…,'popup,noopener')`, ADR-116), `sessionWindowUrl` |
| `account-limits.ts` | `limitBars(info, now)` – 5-h- und Wochenfenster aus `RateLimitInfo.windows` (sonst Ereignisfenster), abgelaufene Fenster ausgeblendet (R4W-06); `limitDeadlines(infos, dayMs)` (Zeitpunkte für `useNowUntil`), `LIMIT_WINDOWS` |
| `conversations.ts` | `earlierConversations(conversations, current)` – ohne die aktuelle, neueste zuerst (ADR-107) |
| `clipboard.ts` | `copyText(text)` → `false` statt Fehler (ohne sicheren Kontext, abgelehnt) |
| `session-title.ts` | `sessionTitle(summary)` – Anzeigetitel: Server-Titel oder Ordnername, solange der Titel leer ist (V2-05) |
| `version.ts` | `compareVersions(a, b)`, `cliVersionStatus(cli, required)` – Versionsregel C.7 für die Anzeige (wie der Server, R3-01) |
| `media-types.ts` | `extensionForMediaType(type)` (eine Endungstabelle: PNG, JPEG, WebP, GIF, SVG, PDF; ohne Parameter, Groß-/Kleinschreibung egal, unbekannt → `null`; R4W-21), `fileNameForMediaType(name, type, fallback?)` – nur Anzeige/Benennung, genutzt von Composer (Anhangsnamen) und Transkript („Speichern unter“) |
| `zod-range.ts` | `numberRange(schema)` → `{min, max}` aus `.min()`/`.max()` eines zod-Number-Schemas (ohne Grenze ±Infinity) – Bereiche aus dem Contract statt Literalen (R4W-21), genutzt von `features/{preferences,profiles}` |
| `return-focus.ts` | `useReturnFocus(open, fallback?)` → `onCloseAutoFocus` für Dialoge ohne Trigger (Fokus beim Öffnen merken, beim Schließen zurück, sonst `fallback()`; R4W-04), `focusedElement()` (null für `<body>`), `focusElement(el)` (nur verbunden, sichtbar, nicht `inert`) |

In Welle 1b read-only; feature-spezifische Helfer liegen in `features/<f>/lib/`.
