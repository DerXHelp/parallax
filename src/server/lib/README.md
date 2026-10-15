# src/server/lib – Server-Helfer

Einziger Ort für generische Server-Helfer. **Vor dem Anlegen eines Helfers greppen**, ob es ihn
schon gibt (auch in `src/shared`). Ownership je Datei (R0-02, ADR-017) – ein Paket ändert nur seine
eigenen Dateien; fehlt etwas in einer fremden Datei, wird es im Bericht angefragt (kein Duplikat):

| Datei | Owner | Inhalt |
| --- | --- | --- |
| `logger.ts` | WP-10 | der Logger (pino): `logger` (Singleton), `createLogger`, `initLogging` (Rotation per pino-roll unter `PARALLAX_HOME/logs`, Pretty im Dev-Modus), `registerSecret`/`unregisterSecret`, `redactText` (registrierte Secrets, Bearer, `sk-ant-…`, Cookie-Werte, `*_TOKEN=` und JSON-Schlüssel `"…TOKEN|SECRET|PASSWORD|API_KEY":"…"` in jeder Tiefe), `REDACT_PATHS` |
| `ids.ts` | WP-10 | `newId('en' \| 'cv' \| 'dc' \| 'pf')`, `newUuid()`, `newToken()` (32 Byte base64url) mit `node:crypto` |
| `paths.ts` | WP-10 | Pfad-Helfer: `assertSafePath(path)` (→ `CommandError(PATH_REJECTED, {reason})`), `checkCwd(cwd)` (+ `CWD_NOT_FOUND`/`CWD_NOT_DIRECTORY`), `resolveAllowedPath(path, roots)` (realpath + Allowlist, `PATH_NOT_ALLOWED`; Grenze: Datei-Symlinks auf UNC, R1-17), `fsErrorCode(error)` |
| `process.ts` | WP-11 | `runFile`, `RunFileFn`, `spawnHidden` (`onStderr`), `killProcessTree` (`taskkill /PID <pid> /T /F`), `assertSpawnableFile` (nur **absolute** `.exe`-Pfade, R1-04), `systemTool(name)` (System32-Pfad), `processInfo`/`processStartTime`, `childProcesses(pid)`, `isProcessAlive`, `errnoCode` |
| `windows.ts` | WP-11 | `FsProbe`/`nodeFsProbe`/`createMemoryFs` (geprüfter Dateizugriff, Fake für Tests), `getEnvVar` (case-insensitiv), `searchPath` (where im Prozess, nie das cwd), `resolveCmdShim` (npm-Shim → `.exe`), `resolveExecutable(name, env)` (nackter Name → absolute `.exe`) – aus `claude/` verschoben (R1-08) |
| `registry.ts` | WP-11 | `reg.exe` per System32-Pfad: `regQuery` (`/ve`), `regKeyQuery`, `parseRegDefaultValue`, `parseRegValues`, `expandRegValue`, `readPersistentEnvironment` (HKCU/HKLM `Environment`, für `buildEnv`, ADR-021) |
| `edge.ts` | WP-11 | `findEdge({regQuery, fs, env})` (App Paths HKCU/HKLM 64/32, dann Program Files/LocalAppData) – für Preflight und Launcher (WP-21), aus `claude/preflight.ts` verschoben (R1-08) |

Signaturen: `docs/architecture.md` §2.2. Die **Pfadregeln** selbst (UNC/Device/ADS, reservierte
Namen, case-insensitiver Vergleich) stehen nur in `@shared/paths`; `paths.ts` ruft sie auf und
implementiert sie nicht neu. Prozesse: immer `shell: false`, `windowsHide: true`, nur absolute
`.exe`-Pfade (C.7, R1-04) – nackte Programmnamen vorher mit `resolveExecutable`/`systemTool`
auflösen (libuv würde sonst zuerst im `cwd` des Kindes suchen).
