# src/server/multihost – Rolle „Mehrere Rechner“

Plan `docs/wp/WP-75.md` §4.1, ADR-224. Ein Rechner ist aus (Default), freigebend (`remote/`) oder steuernd (`hosts/`),
nie beides. Gespeichert in `multi-host.json`, geändert nur über `multiHost.configure`. Umsetzung und Verdrahtung:
`docs/wp/WP-78a.md`.

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `ports.ts` | `RoleSide`, `MultiHostService` | Koordinator (eingefroren) |
| `store.ts` | `multi-host.json` (strikt, ohne `.bak`; neuere Version oder unlesbar → Rolle aus, Speichern gesperrt) | WP-78a |
| `service.ts` | `createMultiHostService` – `multiHost.configure`, Umschalten der Seiten, `start`/`stop`, `onChange` | WP-78a |

Regeln: Zielrolle `share` oder `control` nur, wenn die andere Seite keine Kopplung hat (`REMOTE_ROLE_CONFLICT`, auch über
„aus“). Erst die neue Seite aktivieren (Prüfungen), dann die Datei schreiben; jeder Fehler stellt den alten Stand her.
