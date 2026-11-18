# src/server/multihost – Rolle „Mehrere Rechner“

Plan `docs/wp/WP-75.md` §4.1, ADR-224. Ein Rechner ist aus (Default), freigebend (`remote/`) oder steuernd (`hosts/`),
nie beides. Gespeichert in `multi-host.json`, geändert nur über `multiHost.configure`.

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `ports.ts` | `RoleSide`, `MultiHostService` | Koordinator (eingefroren) |
| übrige | Rollen-Store, `multiHost.configure`, Umschalten der Seiten | WP-78 |
