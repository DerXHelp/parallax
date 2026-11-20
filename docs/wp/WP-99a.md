# WP-99a – Eingebettetes Terminal: Server

Auftrag: `docs/wp/WP-99.md` („Aufteilung“, 99a), Branch `feature/konsole`, 20.11.2026. Grundlage: Spike
`docs/wp/WP-98.md`, Contract `src/shared/terminal.ts` und `src/server/terminal/ports.ts` (unverändert).

## Ergebnis

Neu in `src/server/terminal/` (jeweils mit `*.test.ts` daneben):

| Datei | Inhalt |
| --- | --- |
| `ring.ts` | Scrollback je Terminal (256 KiB). Kürzen am ersten `\n` hinter dem Schnittpunkt, wenn es innerhalb von 4 KiB liegt, sonst hart |
| `poller.ts` | Ein gemeinsamer Timer (unref), Lese-Budget, reihum, ein Frame je Socket, Terminal und Tick, Exit-Prüfung |
| `service.ts` | `createTerminalService(options)` → `TerminalService` |
| `socket.ts` | `registerTerminalRoute(app, options)` → `TerminalRoute` |
| `fakePty.ts` | `createFakePtyFactory()` für Tests, Dev und E2E |
| `conpty.live.test.ts` | Opt-in gegen die echte Pseudokonsole (`PARALLAX_CONPTY_TEST=1`, nur Windows) |

Geändert: `conpty.ts`:
- `ConPty extends PtyProcess` (`pid` als Zahl, `read` → `Buffer`); `ConPtyOptions = PtySpawnOptions`.
- Neu `createConPtyFactory()` → `PtyFactory | null` und `conPtyUnavailableReason()` → `'platform' | 'ffi'`.
- Ctrl+C-Lösung und Reihenfolge beim Schließen unverändert.

Keine Änderung an Contracts, Ports, `http/**`, `app/**` oder `package.json`; keine neue Abhängigkeit.

### Exportierte Signaturen

```ts
// service.ts
export function createTerminalService(options: TerminalServiceOptions): TerminalService;
export interface TerminalServiceOptions extends TerminalServiceDeps {
  now?: () => number;                       // ms, Standard Date.now
  logger?: Logger;
  timers?: Timers;                          // sessions/lib/timers, Standard realTimers (unref)
  killTree?: (pid: number) => Promise<void>; // z. B. killProcessTree; fehlt → kein Rückfall
  isRunning?: (pid: number) => boolean;     // Standard isProcessAlive
  launch?: TerminalLaunch;                  // Standard resolveShellLaunch(…, 'embedded')
  checkCwd?: (cwd: string) => Promise<void>;
  env?: NodeJS.ProcessEnv; fs?: FsProbe; regKeyQuery?: RegKeyQuery; gitFinder?: GitFinder;
}

// socket.ts
export function registerTerminalRoute(app: FastifyInstance, options: TerminalRouteOptions): TerminalRoute;
export interface TerminalRouteOptions {
  service: TerminalService;
  authorize(request: FastifyRequest): ErrorPayload | null;
  onRevoked?: (listener: () => void) => () => void;
  logger?: Logger;
  timing?: Partial<TerminalSocketTiming>;   // helloTimeoutMs, heartbeatMs, invalidWindowMs, closeGraceMs
}
export interface TerminalRoute {
  handleSocket(socket: TerminalSocket): void;
  closeAll(code: number, reason: string): void;
  connections(): number;
}
```

## Was der Koordinator verdrahten muss

1. **Wächter** `http/origin.ts`: `API_PATHS.terminalWs` als Routenklasse `ws` (wie `API_PATHS.ws`, `READ_METHODS`).
   Sonst antwortet der onRequest-Hook mit `INVALID_MESSAGE {reason: 'upgrade_not_allowed'}`.
2. **Route** `http/app.ts`: neue Option, z. B. `terminal?: TerminalService`. Nach dem Hub:
   `registerTerminalRoute(app, { service: options.terminal, authorize: (request) => authorize(request,
   API_PATHS.terminalWs, true), onRevoked: (listener) => auth.onRevoked(listener), logger: log })`.
   - Die Abmeldung von `onRevoked` macht die Route selbst (Hook `onClose`).
   - Beim Server-Ende schließt das `preClose` des WebSocket-Plugins alle Sockets, auch diese.
3. **Komposition** `app/compose.ts`:
   - SdkBackend: `createConPtyFactory()`; bei null `unavailableReason: conPtyUnavailableReason()`.
   - FakeBackend: `createFakePtyFactory()`.
   - `createTerminalService({ pty, unavailableReason, entry, settings: () => settings.console, killTree:
     killProcessTree, gitFinder })`. `entry` liefert `{cwd, archived}` des Eintrags oder null.
   - Den `GitFinder` mit `createShellCommands` teilen (ein Cache).
   - `host.terminalAvailable = service.available`.
   - Archivieren → `closeEntry(id, 'archived')`, Entfernen → `closeEntry(id, 'removed')`.
   - Server-Ende → `await service.closeAll()` vor `app.close()`.

## Entscheidungen und Abweichungen

- **Exit mit Nachlauf:** Nach dem ersten `exitCode() !== null` wird mindestens `EXIT_GRACE_MS` (50 ms) weiter normal
  gelesen, bis ein Read leer bleibt, höchstens `EXIT_DRAIN_MAX_MS` (1 s). Erst dann folgen `close()`, `exited` und
  `exit`.
  - conhost rendert einen Moment nach dem Prozessende, so geht das letzte Bild nicht verloren.
  - Die Regel „ein Frame je Tick“ bleibt, weil kein Extra-Read anfällt.
  - Ein pausierter Socket oder weiterschreibende Kinder enden spätestens nach 1 s.
- **Rückfall `killTree`:** `ConPty.exitCode()` kennt nach `close()` nichts mehr, weil das Prozess-Handle zu ist.
  - Deshalb prüft `isRunning(pid)` (Standard `isProcessAlive`) alle 100 ms, höchstens 2 s lang.
  - `closeAll` wartet auf diese Prüfungen; ohne `killTree` gibt es keine.
- **Gleichzeitige `open`:** Laufende Öffnungen sind gegen die Grenzen reserviert.
  - `closeEntry` erhöht eine Epoche je Eintrag. Eine Öffnung, die vorher begann, scheitert danach mit
    `SESSION_ARCHIVED` bzw. `ENTRY_NOT_FOUND`.
  - Schließt der anfragende Socket während der Prüfungen, startet nichts.
- Nach `closeAll` antworten neue `open` mit `TERMINAL_UNAVAILABLE {reason: 'disabled'}` (ein im Contract genannter
  Grund); `welcome` meldet dann `available: false`.
- Stille Fälle:
  - `detach` eines unbekannten Terminals (idempotent).
  - `input` an ein beendetes Terminal.
  - `resize` eines beendeten Terminals.
  - `resize` schickt kein `terminals` (nur Öffnen, Exit und Schließen ändern die Liste).
- **Ungültige Nachrichten:** `INVALID_MESSAGE {reason}` mit `binary`, `json`, `schema`, `too_large`, `duplicate_hello`
  bzw. vor `hello` `hello_required` (dann 4400).
  - Größte Nachricht: `6 × inputMaxChars + 1024` = 394 240 Bytes, jedes Zeichen als `\u001b` maskiert.
  - Die Grenze prüft der Handler, weil `maxPayload` des gemeinsamen `ws`-Servers (4 MiB) für alle Routen gilt.
- Replay-Frames tragen höchstens 65 535 Bytes Nutzlast, ein Frame ist also höchstens 64 KiB groß.
- Nach dem Schubs bei `attach` steht die Info auf der Größe von `attach`. An der Breitengrenze 500 geht der Schubs
  eine Spalte schmaler.
- Ein harter Schnitt im Ring überspringt UTF-8-Folgebytes; eine Escape-Sequenz kann angeschnitten sein, das
  Neuzeichnen nach dem Schubs gleicht das aus.
- Exit-Codes kommen ungekürzt als vorzeichenlose 32 Bit von `GetExitCodeProcess`, ein Ctrl+C-Ende also als
  3221225786.
- Zeit-Naht: `Timers`/`realTimers` aus `sessions/lib/timers.ts` wiederverwendet; die Tests nutzen
  `createManualTimers`.

## Stolpersteine

- `pnpm exec prettier --write` und `eslint` liefen nur über `src/server/terminal`. `tsc` war nicht erlaubt; die Typen
  sind von Hand geprüft. Der volle `pnpm check` steht beim Koordinator aus.
- `fakePty.ts` braucht `no-control-regex` als Ausnahme mit Begründung (ESC-Sequenzen werden verworfen).

## Checks

- `pnpm exec vitest run src/server/terminal`: 10 Dateien, 78 Tests grün. Die 3 Live-Tests sind ohne Opt-in
  übersprungen.
- `pnpm exec eslint src/server/terminal`: sauber.
- Live, einmal (`PARALLAX_CONPTY_TEST=1`): 3 von 3 grün.
  - cmd: Echo, Resize, `exit 5`.
  - Dienst Ende zu Ende mit echter ConPTY: `open`, `attach`, `input`, `exit 7` und `close` einer laufenden Shell.
  - `close` beendet Shell und `ping -t` ohne `taskkill`.
  - Danach keine übrigen `cmd`/`ping`-Prozesse; kein Fenster.
