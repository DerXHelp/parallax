# src/server/lib – Server-Helfer

Einziger Ort für generische Server-Helfer. **Vor dem Anlegen eines Helfers greppen**, ob es ihn
schon gibt (auch in `src/shared`). Ownership je Datei (R0-02, ADR-017) – ein Paket ändert nur seine
eigenen Dateien; fehlt etwas in einer fremden Datei, wird es im Bericht angefragt (kein Duplikat):

| Datei | Owner | Inhalt |
| --- | --- | --- |
| `logger.ts` | WP-10 | der Logger (pino). Platzhalter aus WP-00; WP-10 ergänzt Redaction, Rotation (pino-roll) unter `PARALLAX_HOME/logs`, Pretty-Ausgabe im Dev-Modus |
| `ids.ts` | WP-10 | `newId('en' \| 'cv' \| 'dc' \| 'pf')` mit `node:crypto` |
| `paths.ts` | WP-10 | Pfad-Helfer: `assertSafePath(path)` (→ `CommandError(PATH_REJECTED, {reason})`), `checkCwd(cwd)` (+ `CWD_NOT_FOUND`/`CWD_NOT_DIRECTORY`) |
| `process.ts` | WP-11 | `runFile`, `spawnHidden`, `killProcessTree` (`taskkill /PID <pid> /T /F`) |

Signaturen: `docs/architecture.md` §2.2. Die **Pfadregeln** selbst (UNC/Device/ADS, reservierte
Namen, case-insensitiver Vergleich) stehen nur in `@shared/paths`; `paths.ts` ruft sie auf und
implementiert sie nicht neu. Prozesse: immer `shell: false`, `windowsHide: true`, nur `.exe` (C.7).
