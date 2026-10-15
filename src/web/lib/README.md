# src/web/lib – Web-Helfer (WP-14)

Einziger Ort für generische Web-Helfer. **Vor dem Anlegen greppen**, ob es den Helfer schon
gibt (auch in `src/shared`, z. B. `@shared/paths` für Pfadregeln).

| Datei | Inhalt |
|---|---|
| `cn.ts` | Klassen zusammenführen (clsx + tailwind-merge), shadcn-Konvention |
| `ids.ts` | `newClientId()` (`cl_` + 32 Hex), `newCmdId()` (UUID) |
| `backoff.ts` | `backoffDelay(attempt, options, random)`, `DEFAULT_BACKOFF` (0,5 s → 15 s, ±20 %) |
| `hash.ts` | `#a=1&flag`-Parameter: `parseHash`, `formatHash`, `getHashParam`, `setHashParam` |
| `storage.ts` | sicheres `localStorage`/`sessionStorage` (`readStorage`, `writeStorage`, `storageAvailable`, `STORAGE_KEYS`), Feature-Schlüssel `storageKey(namespace, …parts)` → `parallax.<namespace>.<…>` |
| `path-display.ts` | nur Anzeige: `pathTail(path, n)` (`D:\1\2\3\4` → `3\4`), `shortPath(path, n)` (`…\3\4`) |
| `zod-jitless.ts` | Seiteneffekt-Modul (erster Import in `main.tsx`): zod ohne `eval`-JIT (CSP) |
| `session-order.ts` | `orderSessions(entries, now)` – Sidebar-Reihenfolge (sortBucket, Aktivität, Anzeigetitel) |
| `session-title.ts` | `sessionTitle(summary)` – Anzeigetitel: Server-Titel oder Ordnername, solange der Titel leer ist (V2-05) |
| `version.ts` | `compareVersions(a, b)`, `cliVersionStatus(cli, required)` – Versionsregel C.7 für die Anzeige (wie der Server, R3-01) |

In Welle 1b read-only; feature-spezifische Helfer liegen in `features/<f>/lib/`.
