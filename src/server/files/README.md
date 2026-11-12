# src/server/files – Datei-Dienst (Phase 3)

Owner: **WP-53** (außer `ports.ts`: Koordinator, eingefroren). Auftrag und Ergebnis:
`docs/wp/WP-53.md` (Design: `docs/wp/WP-50.md`, ADR-140 … ADR-146, ADR-151).

Metadaten und Inhalte von Dateien, auf die sich eine Session bezieht (Viewer, Dateiverweise,
Dateien-Panel, @-Picker), sowie der Start externer Programme (Editor, Explorer, Standardprogramm).
Jeder Zugriff läuft durch **eine** Prüfung: `resolveAllowedPath` aus `lib/paths.ts` (ADR-141:
Stringfilter → Richtlinie am angefragten String ohne fs-Zugriff → `lstat`/`readlink` je Segment →
`realpath` + Stringfilter → Richtlinie am Ziel). Wurzeln: `cwd`, Profil-`additionalDirectories`,
Anhangordner; dazu einzelne Dateien aus dem Session-Index. Jeder fs-Aufruf hat 3 s Timeout
(`lib/fsTimeout.ts`, `guardFileFs`). Dateiinhalte landen nie im Log.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `ports.ts` | `FileEntryInfo`, `FileEntryLookup`, `FileContent`, `FileContentProvider`, `FileService` (nur Typen) | Koordinator |
| `service.ts` | `createFileService(deps) → FileService`, `FileServiceDeps`, `FILE_COMMAND_NAMES`, `FILE_STAT_PARALLEL` (8), `ROOT_CACHE_MS` (60 s) | Host-Befehle `file.stat`, `file.statMany`, `file.open`, `files.session`, `files.project`, `editor.detect`; `open()` für `GET /api/file`; `observeOps` (Index + Projektlisten-Cache); `flush()`. Physische Wurzeln je Eintrag gecacht (60 s, Wechsel von cwd/add-dirs verwirft sofort) |
| `fileFs.ts` | `FileFs`, `nodeFileFs`, `guardFileFs(fs, guard)`, `FileStats`, `FileDirEntry` | fs-Naht (lstat, readlink, realpath, stat, readHead, createReadStream, readdir); Tests zählen Aufrufe |
| `stat.ts` | `statAllowed(fs, file, {truncation})`, `classifyFile`, `isPreviewable`, `isTextKind`, `createTruncationCache`, `TruncationCache`, `TRUNCATION_CACHE_MAX` (256), `utf8SizeBound`, `decodedUtf8Size`, `StatOptions`, `TEXT_MEDIA_TYPE`, `SVG_MEDIA_TYPE` | `FileInfo`: Magic-Bytes (png, jpeg, gif, webp, bmp, ico, pdf), `svg` per Endung, sonst Text-Erkennung (64 KiB), `markdown` per Endung, Ordner `directory`; `previewable` nach ADR-142. `truncated` genau wie die Kürzung von `readTextContent` (CR3-04, ADR-157): Quelle > `fileTextBytes` oder UTF-8-Form > `fileTextBytes`; gelesen wird nur, wenn die Obergrenze aus Größe und Kodierung (windows-1252 ×3, UTF-16 ×1,5, UTF-8 ×3 außerhalb des geprüften Kopfs) über der Grenze liegt, Ergebnis je Dateiversion (Pfad, Größe, mtime) im LRU-Cache des Dienstes; `open()` (HTTP) überspringt die Prüfung |
| `content.ts` | `openContent`, `readTextContent` | Antwort von `GET /api/file`: Text als UTF-8, am Zeilenende vor `fileTextBytes` gekürzt; Bild/PDF als Stream ≤ `fileBinaryBytes` (sonst `PAYLOAD_TOO_LARGE`); binär/Ordner `UNSUPPORTED_MEDIA_TYPE` |
| `sessionIndex.ts` | `createSessionIndex`, `recordsOfItem`, `isTaskOutputFile`, `byLastAtDesc`, `SESSION_FILES_FILE`, `SESSION_INDEX_DEBOUNCE_MS`, `FILE_WRITE_TOOLS` | Index „Dateien dieser Session“ (ADR-145): fertige `tool_call` Read/Write/Edit/MultiEdit/NotebookEdit/ExitPlanMode + `task.outputFile` nur in der Form der CLI-Task-Daten `…\tasks\<taskId>.output` (ADR-152, Tiefenverteidigung); `entries/<id>/files.json` (JsonStore, 2 s entprellt, ≤ `sessionFilesMax`); einmaliger Backfill aus allen Transkripten |
| `projectFiles.ts` | `createProjectFiles`, `parseLsFiles`, `GIT_LS_FILES_ARGS` und Grenzen | `files.project` (ADR-151): `git ls-files` (absolutes git.exe, fsmonitor aus, 5 s, 8 MB), sonst Walk (keine Links, Ignore-Liste, Tiefe ≤ 12, 3 s); ≤ `projectFilesMax`; Cache 30 s |
| `editors.ts` | `findEditor`, `createEditorFinder`, `EDITOR_CACHE_MS`, `resolveEditorExecutable`, `editorArguments`, `detectEditors`, `EDITOR_EXE_NAMES` | Editor-Presets (ADR-144): Override → App Paths → Uninstall-`InstallLocation` → Standardordner, jeder Kandidat sofort geprüft (kein `reg.exe` nach dem ersten Treffer); Treffer je Preset 60 s gemerkt (vor Gebrauch erneut geprüft, Fehlschläge nie), `editor.detect` sucht immer neu (R5-04); Platzhalter je Argument |
| `open.ts` | `createSystemLauncher(deps)`, `createRecordingOpener(options)`, `ProgramLauncher`, `OpenRequest` | Programmstart-Naht: echt über `spawnGui`/`spawnExplorer` (`lib/process.ts`; Editor mit seinem eigenen Ordner als Arbeitsordner, R5-02), Fake protokolliert `file.open (fake): <ziel> <pfad>` und startet nichts |
| `testing.ts` | `fakeTranscripts`, `entryLookup`, `countingFileFs` | **nur Tests** (auch WP-60): Transkript-Fake, Eintrags-Lookup, zählendes Dateisystem |

**`file.open`:** Richtlinie wie oben, dann `editor` (nur Dateien, sonst `VALIDATION_FAILED
{reason: 'directory'}`; Preset `system` = `default`), `explorer` (Datei markiert, Ordner geöffnet),
`default` (nur Dateien, `isDefaultProgramAllowed` für den angefragten **und** den physischen Pfad,
sonst `FILE_TYPE_BLOCKED`). Gestartet wird immer der physische Pfad.

**Tests starten nie Programme:** Spawn, Registry und git hängen an Nähten; `createRecordingOpener`
ist der Standard-Launcher von `createFileService`, wenn keiner übergeben wird.
