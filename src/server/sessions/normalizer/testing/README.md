# testing – Test-Harness des Normalizers (WP-12)

`harness.ts` spielt Fixtures (aufgezeichnet oder synthetisch) so ab, wie die Engine (WP-13) den
Normalizer bedient: `input` → `registerPrompt`, `canUseTool`/`decision` → `attachDecision`,
`conversation_reset` → `startConversation` + Op `conversation.reset`, `exit` → `finalizeOpen`.
`replayStatus` leitet zusätzlich die Status-Ereignisse ab und füttert `reduceStatus`.
Deterministisch (Zeiten aus Timestamps/tMs, IDs aus `@shared/samples`, Blobs per SHA-256).
Nur für Tests – nicht im Produktionscode importieren. WP-13 darf es für FakeBackend-Tests nutzen.
