# src/web/lib – Web-Helfer (WP-14)

Einziger Ort für generische Web-Helfer. **Vor dem Anlegen greppen**, ob es den Helfer schon
gibt (auch in `src/shared`, z. B. `@shared/paths` für Pfadregeln).

| Datei | Inhalt |
|---|---|
| `cn.ts` | Klassen zusammenführen (clsx + tailwind-merge), shadcn-Konvention |
| `ids.ts` | `newClientId()` (`cl_` + 32 Hex), `newCmdId()` (UUID) |
| `backoff.ts` | `backoffDelay(attempt, options, random)`, `DEFAULT_BACKOFF` (0,5 s → 15 s, ±20 %) |
| `hash.ts` | `#a=1&flag`-Parameter: `parseHash`, `formatHash`, `getHashParam`, `setHashParam` |
| `storage.ts` | sicheres `localStorage`/`sessionStorage` (`readStorage`, `writeStorage`, `STORAGE_KEYS`) |
| `path-display.ts` | `pathTail(path, n)` – nur Anzeige (`D:\1\2\3\4` → `3\4`) |
| `session-order.ts` | `orderSessions(entries, now)` – Sidebar-Reihenfolge (sortBucket, Aktivität) |

In Welle 1b read-only; feature-spezifische Helfer liegen in `features/<f>/lib/`.
