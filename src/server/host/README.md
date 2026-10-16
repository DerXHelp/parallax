# src/server/host – Host-Dienste (Phase 2)

Owner: **WP-33**. Auftrag: `docs/wp/WP-33.md`.

Host-Befehle, die keine Session betreffen (ADR-101), als `HostCommandHandler`
(`src/server/sync/ports.ts`): der Ordner-Browser `fs.listDirectory` (ADR-119). Die Profil-Befehle
`profile.*` liefert WP-32 in `src/server/claude/`. Die Engine routet nach Namen
(`HOST_COMMAND_NAMES` in `@shared/protocol`), WP-40 verdrahtet die Handler in `app/compose.ts`.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `fsCommands.ts` | `createFsCommands({ fs?, home?, platform?, driveTimeoutMs? })` → `HostCommandHandler` (`names: ['fs.listDirectory']`), `DirFs`, `DirEntry`, `nodeDirFs`, `DRIVE_TIMEOUT_MS`, `isHiddenName`, `childPath`, `parentPath` | Ordner-Browser, nur lesend |

**`fs.listDirectory` (ADR-119, WP-30 §4.12):**
- `path: null` → Wurzeln: Benutzerordner (`kind: 'home'`, entfällt bei unsicherem Pfad, z. B.
  servergespeichertes Profil) und jedes Laufwerk `A:`…`Z:`, dessen `stat('X:\')` binnen
  `driveTimeoutMs` (1,5 s) antwortet. Langsame/fehlende Laufwerke entfallen; ein Laufwerk, dessen
  letztes `stat` noch hängt, bekommt kein zweites (libuv hat vier Threadpool-Threads – hängende
  Netzlaufwerke dürfen nicht jeden fs-Aufruf des Servers blockieren, R8).
- Sonst: `windowsPathIssue` → `PATH_REJECTED {reason}`; `assertNoUnsafeLink` (`lib/paths.ts`,
  `lstat`/`readlink` je Segment, R1-17) → `PATH_REJECTED {reason: 'link_target'}`; `stat` +
  `readdir(withFileTypes)`; nur Ordner und Links auf Ordner (Ziel wie ein Pfad geprüft, unsichere
  Links fehlen und werden nie verfolgt); `hidden` = Punkt-Name oder `$Recycle.Bin`, `System Volume
  Information`, `$WinREAgent`, `Recovery`, `Config.Msi` (ohne `showHidden` weggelassen); sortiert
  case-insensitiv; mehr als `LIMITS.fsListMax` → `truncated` (die ersten behalten).
- Pfade = Eingabe + Name exakt (Trennzeichen im Stil der Eingabe, kein `realpath`); `parent` =
  übergeordneter Ordner, `null` an der Laufwerkswurzel.
- Fehler: ENOENT → `CWD_NOT_FOUND`, kein Ordner → `CWD_NOT_DIRECTORY`, EACCES/EPERM →
  `FOLDER_NOT_READABLE {path}`.

Tests: `fsCommands.test.ts` mit Temp-Baum (echte Junctions, auch eine verwaiste), Fake-`DirFs` für
den Symlink auf `\\server\share` (braucht sonst Admin-Rechte), `truncated`, Fehlercodes und Wurzeln
mit Fake-Laufwerken und Timeout.
