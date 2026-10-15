# src/server/backend – AgentBackend-Implementierungen (WP-13)

Port-Interface `AgentBackend` (Contract aus WP-02) mit `SdkBackend` (echtes
`@anthropic-ai/claude-agent-sdk`, installiertes `claude`) und `FakeBackend` (Szenario-DSL,
spielt Fixtures ab, wartet auf Entscheidungen, simuliert Crashes). `pnpm dev` nutzt das
FakeBackend (`--backend=fake`), `pnpm dev:live` das SdkBackend.

- **Ports (eingefroren seit WP-02, Änderung nur per Contract-Änderung):** `types.ts` –
  `AgentBackend`, `AgentSession`, `BackendEvent`, `PermissionRequest`, `OutgoingPrompt`,
  Verlaufstypen; `fixture.ts` – Fixture-Format v1 (einzige Quelle, `scripts/record/format.ts`
  re-exportiert), `parseFixture`, `loadFixture`, Payload-Views. Beide samt Tests gehören nicht WP-13.
- Alle übrigen Dateien hier gehören WP-13. FakeBackend-Szenarien ohne aufgezeichnetes Fixture als
  `.ts`-Module in `fake/` (Fixture-Format v1, mit `fixtureEventSchema` geprüft), nie `.jsonl` (R0-06).
- Spawn über `lib/process.ts`, Prozessbaum-Kill über `killProcessTree` (C.8); der Spawn-Wrapper liest
  stderr selbst (F.16).
- R2-Fixes: SdkBackend-Bereitschaft (`supportedModels`, auch vor den C.1-Flag-Settings) mit eigenem
  Timeout `readyMs` 60 s (R2-04); Betas nur mit gültigem Header-Namen (R2-11); FakeBackend behält
  höchstens `keepSessions` (50) beendete Sessions/Starts (R2-12). Kleine Helfer aus `lib/async.ts`.
