# src/web/lib – Web-Helfer (WP-14)

Einziger Ort für generische Web-Helfer. **Vor dem Anlegen greppen**, ob es den Helfer schon
gibt (auch in `src/shared`, z. B. `@shared/paths` für Pfadregeln).

- `cn.ts` – Klassen zusammenführen (clsx + tailwind-merge), shadcn-Konvention.
- `ids.ts` (WP-14) – Client-IDs (`cl_…`, `cmdId`) mit `crypto.randomUUID()`.

In Welle 1b read-only; feature-spezifische Helfer liegen in `features/<f>/lib/`.
