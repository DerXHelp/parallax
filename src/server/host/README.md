# src/server/host – Host-Dienste (Phase 2)

Owner: **WP-33**. Auftrag: `docs/wp/WP-33.md`.

Host-Befehle, die keine Session betreffen (ADR-101), als `HostCommandHandler`
(`src/server/sync/ports.ts`): der Ordner-Browser `fs.listDirectory` (ADR-119). Die Profil-Befehle
`profile.*` liefert WP-32 in `src/server/claude/`. Die Engine routet nach Namen
(`HOST_COMMAND_NAMES` in `@shared/protocol`), WP-40 verdrahtet die Handler in `app/compose.ts`.

Module legt WP-33 an (`fsCommands.ts`) und trägt sie hier ein.
