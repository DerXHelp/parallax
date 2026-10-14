# src/server/lib – Server-Helfer

Einziger Ort für generische Server-Helfer. **Vor dem Anlegen eines Helfers greppen**, ob es ihn
schon gibt (auch in `src/shared`).

- `logger.ts` – der Logger (pino). Platzhalter aus WP-00; WP-10 ergänzt Redaction, Rotation
  (pino-roll) unter `PARALLAX_HOME/logs` und Pretty-Ausgabe im Dev-Modus.
- Geplant: Pfad-Helfer (case-insensitive Vergleiche, `cwd` exakt behalten, UNC/Device/ADS-Filter),
  Prozess-Helfer (`taskkill /PID <pid> /T /F`, `windowsHide: true`).
