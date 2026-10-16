# test – Test-Infrastruktur

- `setup/` – Test-Umgebung (Kern `home.ts` → `ensureTestEnv`, ADR-083/WP22-07):
  - `PARALLAX_HOME` ist **immer** ein eigenes Temp-Verzeichnis (`parallax-test-*` direkt im OS-Temp).
    Das Vitest-globalSetup (`global.ts`) und `e2e/global-setup.ts` legen es bei jedem Lauf frisch an
    und löschen es danach; die Worker (`env.ts`) behalten nur dieses. Jedes andere geerbte Home – das
    echte `%LOCALAPPDATA%\Parallax`, ein Ordner darin, ein nicht temporärer Ordner, das Temp-Home
    eines laufenden Servers (Tests aus einer Parallax-Session) – wird ersetzt (Hinweis auf stderr);
    das echte Datenverzeichnis verweigert `assertNotRealHome` zusätzlich hart.
  - `PARALLAX_PORT` ist immer `0`. Geerbte Server-Steuervariablen (`PARALLAX`, `PARALLAX_ENTRY_ID`,
    `PARALLAX_BACKEND`, `_DEV`, `_HOST`, `_LOG_LEVEL`, `_VALIDATE`, `_TOASTS`) werden entfernt;
    Werkzeug-Schalter wie `PARALLAX_LIVE*` und `PARALLAX_E2E_SKIP_BUILD` bleiben.
  - `web.ts`: RTL-Cleanup und längeres `asyncUtilTimeout` für Web-Tests; `env.test.ts`: Tests dazu.
- `fixtures/sdk/` – bereinigte SDK-Message-Streams (`*.jsonl`) aus `pnpm record` (WP-01).

Unit- und Integrationstests liegen als `*.test.ts(x)` **neben dem Code** in `src/**`. E2E-Tests:
`e2e/README.md` (`pnpm e2e` mit FakeBackend; Live-Smoke `e2e/live` nur mit `PARALLAX_LIVE=1` und
Nutzer-Freigabe, `docs/sdk-upgrade.md`).
