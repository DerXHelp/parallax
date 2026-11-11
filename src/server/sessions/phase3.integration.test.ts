/**
 * WP-51 – Phase 3 in the engine through the real manager with the FakeBackend, memory stores and a
 * virtual clock: attachments (images, PDFs, files – ADR-146) and pastes, the attachment folder of
 * every start, `session.stopTask` (ADR-149), `plan.list`/`plan.read` and `latestPlanVersion`
 * (ADR-148), the derived detail fields `planFile`/`todos`, "implement with a fresh context"
 * (ADR-147) and the CR2 regression of `pendingRename`. Everything published passes the hub-like
 * validation of the memory publisher.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, type EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  currentConversation,
  type DecisionRecord,
  type PlanDecision,
  type TranscriptItem,
  type UserMessageItem,
} from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import {
  sampleBlobId,
  sampleDecisionRecord,
  sampleEntry,
  sampleExternalHandoff,
  sampleId,
  sampleTime,
} from '@shared/samples';
import { eventsScenario, type FakeScenario, type FakeScriptContext } from '../backend/fakeBackend';
import {
  clearCommand,
  closeGate,
  dslContext,
  frame,
  input,
  events as join,
  streamedText,
  toEvents,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
  type DslContext,
} from '../backend/fake/dsl';
import { FAKE_SHOT_PNG_BASE64 } from '../backend/fake/image';
import { FAKE_BACKGROUND_MS } from '../backend/fake/phase3';
import { implementPlanText } from '../backend/fake/plan';
import { CANCEL_DENY, abortedByDecision, ask, type Turn } from '../backend/fake/turn';
import type { StartSessionRequest } from '../backend/types';
import { nextMacrotask } from '../lib/async';
import { CommandError } from '../sync/ports';
import { system } from './normalizer/synthetic/build';
import { MEMORY_ATTACHMENTS_HOME } from './testing/memoryStores';
import {
  HARNESS_CWD,
  createEngineHarness,
  type CommandInput,
  type EngineHarness,
  type EngineHarnessOptions,
} from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PNG = Buffer.from(FAKE_SHOT_PNG_BASE64, 'base64');
const PDF = Buffer.from('%PDF-1.4\n% fake document\n%%EOF\n', 'latin1');
const FRESH_DENY_MESSAGE = 'The user chose to implement the plan in a fresh session.';

type PermissionResultOf = Awaited<ReturnType<StartSessionRequest['canUseTool']>>;
type RespondInput = Extract<CommandInput, { name: 'decision.respond' }>;
type PlanResponseInput = Extract<RespondInput['response'], { kind: 'plan' }>['response'];

const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

async function setup(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const h = await createEngineHarness(options);
  harnesses.push(h);
  return h;
}

async function restart(
  h: EngineHarness,
  options: Partial<EngineHarnessOptions> = {},
): Promise<EngineHarness> {
  harnesses.splice(harnesses.indexOf(h), 1);
  expect(h.errors).toEqual([]);
  const next = await h.restart(options);
  harnesses.push(next);
  return next;
}

async function idleEntry(h: EngineHarness, prompt = 'Reply with exactly: OK'): Promise<EntryId> {
  const entryId = await h.create(prompt);
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
  return entryId;
}

async function untilIdle(h: EngineHarness, entryId: EntryId): Promise<void> {
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
}

async function view(h: EngineHarness, entryId: EntryId) {
  const v = await h.manager.loadView(entryId);
  if (v === null) throw new Error(`no view for ${entryId}`);
  return v;
}

function sent(h: EngineHarness, entryId: EntryId) {
  return h.sessions(entryId).flatMap((s) => s.sent);
}

/** The latest state of every item published for the entry (by id). */
function items(h: EngineHarness, entryId: EntryId): TranscriptItem[] {
  const byId = new Map<string, TranscriptItem>();
  for (const op of h.publisher.opsOf(entryId)) if (op.op === 'item.upsert') byId.set(op.item.id, op.item);
  return [...byId.values()];
}

function userMessage(h: EngineHarness, entryId: EntryId, id: string): UserMessageItem | undefined {
  return items(h, entryId).find((i): i is UserMessageItem => i.kind === 'user_message' && i.id === id);
}

function toolCallOf(h: EngineHarness, entryId: EntryId, toolName: string, filePath?: string) {
  return items(h, entryId).find(
    (i) =>
      i.kind === 'tool_call' &&
      i.toolName === toolName &&
      (filePath === undefined ||
        (typeof i.input === 'object' &&
          i.input !== null &&
          !Array.isArray(i.input) &&
          i.input.file_path === filePath)),
  );
}

function detailPatches(h: EngineHarness, entryId: EntryId) {
  return h.publisher.opsOf(entryId).flatMap((op) => (op.op === 'detail.patch' ? [op.patch] : []));
}

function attachmentsDir(entryId: EntryId): string {
  return `${MEMORY_ATTACHMENTS_HOME}\\entries\\${entryId}\\attachments`;
}

function freshPrompt(plan: string, planFile: string | null): string {
  return `Implement the following approved plan.${planFile === null ? '' : `\nPlan file: ${planFile}`}\n\n${plan}`;
}

/** Waits for the open plan decision of `version` (fake:plan) and returns it. */
async function openPlan(h: EngineHarness, entryId: EntryId, version = 1): Promise<PlanDecision> {
  const find = (): PlanDecision | undefined =>
    h.publisher
      .opsOf(entryId)
      .flatMap((op) =>
        op.op === 'decision.upsert' &&
        op.decision.kind === 'plan' &&
        op.decision.version === version &&
        op.decision.state === 'open'
          ? [op.decision]
          : [],
      )
      .at(0);
  await h.waitFor(() => find() !== undefined && h.facts(entryId).decisions.plan === 1);
  await h.settle();
  const decision = find();
  if (decision === undefined) throw new Error(`no plan decision v${String(version)}`);
  return decision;
}

async function planEntry(h: EngineHarness): Promise<{ entryId: EntryId; decision: PlanDecision }> {
  const entryId = await h.create('fake:plan');
  return { entryId, decision: await openPlan(h, entryId) };
}

function respondPlan(h: EngineHarness, entryId: EntryId, decisionId: string, response: PlanResponseInput) {
  return h.cmd({ name: 'decision.respond', entryId, decisionId, response: { kind: 'plan', response } });
}

function respondPlanError(
  h: EngineHarness,
  entryId: EntryId,
  decisionId: string,
  response: PlanResponseInput,
) {
  return h.cmdError({ name: 'decision.respond', entryId, decisionId, response: { kind: 'plan', response } });
}

/** Records every PermissionResult the engine answers (call before the first start). */
function captureResults(h: EngineHarness): PermissionResultOf[] {
  const results: PermissionResultOf[] = [];
  const start = h.backend.start.bind(h.backend);
  h.backend.start = (req) =>
    start({
      ...req,
      canUseTool: async (request, signal) => {
        const result = await req.canUseTool(request, signal);
        results.push(result);
        return result;
      },
    });
  return results;
}

function scriptContext(ctx: FakeScriptContext): DslContext {
  return dslContext({
    sessionId: ctx.sessionId,
    ids: ctx.ids,
    model: ctx.state.model,
    permissionMode: ctx.state.permissionMode,
    cwd: ctx.req.cwd,
    timestamp: () => ctx.now().toISOString(),
  });
}

/**
 * FakeBackend timing for `fake:background` (WP-52): speed 1, every short delay on the next
 * macrotask, the task's long waits (`FAKE_BACKGROUND_MS / 2`) never end – the task runs until
 * `stopTask` (a sleeping task is a resting point of `settle()`).
 */
const HOLD_BACKGROUND: EngineHarnessOptions['fakeTiming'] = {
  speed: 1,
  sleep: (ms) => (ms >= FAKE_BACKGROUND_MS / 2 ? new Promise<void>(() => undefined) : nextMacrotask()),
};

/**
 * Rule (a) on its own: the plan file is written in the default mode (rule b does not apply), the
 * `ExitPlanMode` request with its `planFilePath` comes afterwards.
 */
function retroPlanScenario(planFilePath: string): FakeScenario {
  return {
    kind: 'script',
    name: 'retro-plan',
    run: async (ctx) => {
      const c = scriptContext(ctx);
      const prompt = await ctx.nextInput();
      const turn: Turn = { prompt: prompt.uuid, toolUseId: null };
      const writeId = c.ids.toolUseId();
      await ctx.play(
        join(
          turnOpen(c, prompt.uuid),
          toolUseBlock(c, 'Write', { file_path: planFilePath, content: '# Plan' }, { toolUseId: writeId }),
          toolResultMessage(c, writeId, `File created successfully at: ${planFilePath}`),
        ),
      );
      const exitId = c.ids.toolUseId();
      const input = { plan: '# Plan', planFilePath };
      await ctx.play(toolUseBlock(c, 'ExitPlanMode', input, { toolUseId: exitId }));
      const result = await ask(ctx, c, turn, 'ExitPlanMode', input, exitId, {
        requiresUserInteraction: true,
      });
      if (CANCEL_DENY(result)) {
        await abortedByDecision(ctx, c, turn);
        return;
      }
      await ctx.play(
        join(
          toolResultMessage(c, exitId, 'User has approved your plan. You can now start coding.'),
          streamedText(c, 'Done.'),
          turnClose(c, prompt.uuid),
        ),
      );
    },
  };
}

/** Prompt of an attachment command (sendPrompt). */
function sendWith(
  entryId: EntryId,
  text: string,
  blobIds: readonly string[],
  pastes?: string[],
): Extract<CommandInput, { name: 'session.sendPrompt' }> {
  return {
    name: 'session.sendPrompt',
    entryId,
    prompt: {
      text,
      attachments: blobIds.map((blobId) => ({ blobId })),
      ...(pastes === undefined ? {} : { pastes }),
    },
  };
}

// =====================================================================================
// Attachments (ADR-146)
// =====================================================================================

describe('attachments (ADR-146)', () => {
  it('image and PDF → image and document blocks in list order, then the text; item and queue keep every ref', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const image = h.stores.blobs.put(PNG, 'image/png', 'shot.png');
    const pdf = h.stores.blobs.put(PDF, 'application/pdf', 'spec.pdf');
    const { messageUuid } = await h.cmd({
      name: 'session.sendPrompt',
      entryId,
      prompt: { text: 'Compare both', attachments: [{ blobId: pdf.blobId }, { blobId: image.blobId }] },
    });
    expect(sent(h, entryId).at(-1)?.content).toEqual([
      { type: 'document', mediaType: 'application/pdf', base64: PDF.toString('base64'), title: 'spec.pdf' },
      { type: 'image', mediaType: 'image/png', base64: FAKE_SHOT_PNG_BASE64 },
      { type: 'text', text: 'Compare both' },
    ]);
    expect(h.stores.attachments.materialized).toEqual([]);
    await h.settle();
    expect(userMessage(h, entryId, messageUuid)).toMatchObject({
      text: { text: 'Compare both' },
      attachments: [pdf, image],
    });
    const queued = detailPatches(h, entryId).flatMap((p) => p.queue ?? []);
    expect(queued.find((q) => q.messageUuid === messageUuid)).toMatchObject({ attachments: [pdf, image] });
  });

  it('file → materialized into the entry folder; only the SENT text ends with the path block', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const csv = h.stores.blobs.put('a,b\n1,2\n', 'application/octet-stream', 'data.csv');
    const log = h.stores.blobs.put('build failed', 'application/octet-stream', null);
    const { messageUuid } = await h.cmd(sendWith(entryId, 'Summarize the files', [csv.blobId, log.blobId]));
    const csvPath = `${attachmentsDir(entryId)}\\${csv.blobId.slice(0, 16)}\\data.csv`;
    const logPath = `${attachmentsDir(entryId)}\\${log.blobId.slice(0, 16)}\\${log.blobId.slice(0, 16)}.bin`;
    expect(h.stores.attachments.materialized).toEqual([
      { entryId, blobId: csv.blobId, name: 'data.csv', path: csvPath },
      { entryId, blobId: log.blobId, name: null, path: logPath },
    ]);
    expect(sent(h, entryId).at(-1)?.content).toEqual([
      { type: 'text', text: `Summarize the files\n\nAttached files:\n- ${csvPath}\n- ${logPath}` },
    ]);
    await h.settle();
    // The transcript and the queue show what the user typed (the path block is for the CLI only).
    expect(userMessage(h, entryId, messageUuid)).toMatchObject({
      text: { text: 'Summarize the files' },
      attachments: [csv, log],
    });
    const queued = detailPatches(h, entryId).flatMap((p) => p.queue ?? []);
    expect(queued.find((q) => q.messageUuid === messageUuid)).toMatchObject({
      text: { text: 'Summarize the files' },
      attachments: [csv, log],
    });
  });

  it('file without text → the path block is the whole text; mixed with an image the block comes first', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const file = h.stores.blobs.put('x', 'application/octet-stream', 'x.bin');
    const image = h.stores.blobs.put(PNG, 'image/png', 'shot.png');
    await h.cmd(sendWith(entryId, '', [file.blobId, image.blobId]));
    const path = `${attachmentsDir(entryId)}\\${file.blobId.slice(0, 16)}\\x.bin`;
    expect(sent(h, entryId).at(-1)?.content).toEqual([
      { type: 'image', mediaType: 'image/png', base64: FAKE_SHOT_PNG_BASE64 },
      { type: 'text', text: `Attached files:\n- ${path}` },
    ]);
  });

  it('session.create with a file: the entry exists first, its folder takes the file, the start gets the folder', async () => {
    const h = await setup();
    const file = h.stores.blobs.put('trace', 'application/octet-stream', 'build.log');
    const { entryId } = await h.cmd({
      name: 'session.create',
      cwd: HARNESS_CWD,
      prompt: { text: 'Why did the build fail?', attachments: [{ blobId: file.blobId }] },
    });
    const path = `${attachmentsDir(entryId)}\\${file.blobId.slice(0, 16)}\\build.log`;
    expect(h.stores.attachments.materialized).toEqual([
      { entryId, blobId: file.blobId, name: 'build.log', path },
    ]);
    expect(h.backend.starts[0]?.attachmentsDir).toBe(attachmentsDir(entryId));
    expect(h.session(entryId).sent[0]?.content).toEqual([
      { type: 'text', text: `Why did the build fail?\n\nAttached files:\n- ${path}` },
    ]);
    // The title comes from the typed text.
    expect(h.summary(entryId).title).toBe('Why did the build fail?');
    await untilIdle(h, entryId);
  });

  it('error rows: BLOB_NOT_FOUND, UNSUPPORTED_MEDIA_TYPE, PAYLOAD_TOO_LARGE (PDF, file, total) – nothing sent or materialized', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const before = sent(h, entryId).length;
    const file = h.stores.blobs.put('ok', 'application/octet-stream', 'ok.txt');
    const missing = sampleBlobId(42);
    expect(await h.cmdError(sendWith(entryId, 'x', [file.blobId, missing]))).toEqual({
      code: 'BLOB_NOT_FOUND',
      params: { blobId: missing },
    });
    const text = h.stores.blobs.put('plain', 'text/plain', 'notes.txt');
    expect(await h.cmdError(sendWith(entryId, 'x', [text.blobId]))).toEqual({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      params: { blobId: text.blobId, mediaType: 'text/plain' },
    });
    const bigPdf = h.stores.blobs.put(Buffer.alloc(LIMITS.pdfBytes + 1, 1), 'application/pdf', 'big.pdf');
    expect(await h.cmdError(sendWith(entryId, 'x', [bigPdf.blobId]))).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      params: { blobId: bigPdf.blobId, bytes: LIMITS.pdfBytes + 1, max: LIMITS.pdfBytes },
    });
    const bigFile = h.stores.blobs.put(
      Buffer.alloc(LIMITS.fileAttachmentBytes + 1, 2),
      'application/octet-stream',
      'big.bin',
    );
    expect(await h.cmdError(sendWith(entryId, 'x', [bigFile.blobId]))).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      params: {
        blobId: bigFile.blobId,
        bytes: LIMITS.fileAttachmentBytes + 1,
        max: LIMITS.fileAttachmentBytes,
      },
    });
    // Images and PDFs together stay within attachmentsTotalBytes (files do not count).
    const pdfA = h.stores.blobs.put(Buffer.alloc(9_000_000, 3), 'application/pdf', 'a.pdf');
    const pdfB = h.stores.blobs.put(Buffer.alloc(9_000_000, 4), 'application/pdf', 'b.pdf');
    const image = h.stores.blobs.put(Buffer.alloc(2_500_000, 5), 'image/png', 'c.png');
    expect(
      await h.cmdError(sendWith(entryId, 'x', [file.blobId, pdfA.blobId, pdfB.blobId, image.blobId])),
    ).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      params: { bytes: 20_500_000, max: LIMITS.attachmentsTotalBytes },
    });
    expect(sent(h, entryId)).toHaveLength(before);
    expect(h.stores.attachments.materialized).toEqual([]);
    // session.create with a bad attachment creates nothing.
    expect(
      (
        await h.cmdError({
          name: 'session.create',
          cwd: HARNESS_CWD,
          prompt: { text: 'x', attachments: [{ blobId: text.blobId }] },
        })
      ).code,
    ).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(h.manager.listSummaries()).toHaveLength(1);
  });

  it('without an attachment store: files → UNSUPPORTED_MEDIA_TYPE, images still work, no attachmentsDir', async () => {
    const h = await setup({ attachments: false });
    const entryId = await idleEntry(h);
    expect(h.backend.starts[0]?.attachmentsDir).toBeNull();
    const file = h.stores.blobs.put('x', 'application/octet-stream', 'x.bin');
    expect(await h.cmdError(sendWith(entryId, 'x', [file.blobId]))).toEqual({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      params: { blobId: file.blobId, mediaType: 'application/octet-stream' },
    });
    const image = h.stores.blobs.put(PNG, 'image/png', 'shot.png');
    const pdf = h.stores.blobs.put(PDF, 'application/pdf', 'spec.pdf');
    await h.cmd(sendWith(entryId, 'Look', [image.blobId, pdf.blobId]));
    expect(
      sent(h, entryId)
        .at(-1)
        ?.content.map((c) => c.type),
    ).toEqual(['image', 'document', 'text']);
    expect(h.stores.attachments.materialized).toEqual([]);
  });

  it('session.create: a failing materialize ends like a failed start (entry in error, nothing started)', async () => {
    const h = await setup();
    const file = h.stores.blobs.put('x', 'application/octet-stream', 'x.bin');
    h.stores.attachments.materialize = (_entryId, blobId) =>
      Promise.reject(new CommandError(makeError('BLOB_NOT_FOUND', { blobId })));
    // Like every start failure of session.create: the entry exists, the error is in its summary.
    const { entryId, messageUuid } = await h.cmd({
      name: 'session.create',
      cwd: HARNESS_CWD,
      prompt: { text: 'Read it', attachments: [{ blobId: file.blobId }] },
    });
    expect(messageUuid).toBeNull();
    expect(h.facts(entryId)).toMatchObject({ runState: 'error', errorCode: 'BLOB_NOT_FOUND' });
    expect(h.stores.registry.get(entryId)?.lastError).toMatchObject({
      code: 'BLOB_NOT_FOUND',
      params: { blobId: file.blobId },
    });
    expect(h.backend.starts).toEqual([]);
  });
});

// =====================================================================================
// Pastes (ADR-146)
// =====================================================================================

describe('pastes (ADR-146)', () => {
  it('pastes contained in the text → inlinePastes; none → no field', async () => {
    const h = await setup();
    const { entryId } = await h.cmd({
      name: 'session.create',
      cwd: HARNESS_CWD,
      prompt: { text: 'Look at this:\nERROR 42 at line 7', pastes: ['ERROR 42 at line 7'] },
    });
    await untilIdle(h, entryId);
    expect(h.session(entryId).sent[0]?.inlinePastes).toEqual(['ERROR 42 at line 7']);
    await h.cmd(sendWith(entryId, 'A: one\nB: two', [], ['A: one', 'B: two']));
    expect(sent(h, entryId).at(-1)?.inlinePastes).toEqual(['A: one', 'B: two']);
    await untilIdle(h, entryId);
    await h.cmd(sendWith(entryId, 'No pastes', []));
    expect(Object.keys(sent(h, entryId).at(-1) ?? {}).sort()).toEqual(['content', 'priority', 'uuid']);
  });

  it('a paste missing from the text → VALIDATION_FAILED {reason paste_not_in_text, index}; nothing sent or created', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const before = sent(h, entryId).length;
    expect(await h.cmdError(sendWith(entryId, 'only this', [], ['only', 'that']))).toEqual({
      code: 'VALIDATION_FAILED',
      params: { reason: 'paste_not_in_text', index: 1 },
    });
    expect(sent(h, entryId)).toHaveLength(before);
    expect(
      await h.cmdError({ name: 'session.create', cwd: HARNESS_CWD, prompt: { text: 'x', pastes: ['y'] } }),
    ).toEqual({ code: 'VALIDATION_FAILED', params: { reason: 'paste_not_in_text', index: 0 } });
    expect(h.manager.listSummaries()).toHaveLength(1);
  });
});

// =====================================================================================
// attachmentsDir of every start (ADR-146, C.11)
// =====================================================================================

describe('attachmentsDir', () => {
  it('create, resume and resume after a restart pass the entry folder', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.close', entryId });
    await h.cmd({ name: 'session.resume', entryId });
    expect(h.backend.starts.map((s) => s.attachmentsDir)).toEqual([
      attachmentsDir(entryId),
      attachmentsDir(entryId),
    ]);
    const next = await restart(h);
    await next.cmd({ name: 'session.resume', entryId });
    expect(next.backend.starts.map((s) => s.attachmentsDir)).toEqual([attachmentsDir(entryId)]);
  });

  it('a failing dir() is logged and the session starts without the folder', async () => {
    const h = await setup();
    h.stores.attachments.dir = () => Promise.reject(new Error('disk full'));
    const entryId = await idleEntry(h);
    expect(h.backend.starts[0]?.attachmentsDir).toBeNull();
    expect(h.facts(entryId).runState).toBe('idle');
  });
});

// =====================================================================================
// session.stopTask (ADR-149)
// =====================================================================================

describe('session.stopTask (ADR-149)', () => {
  it('a background task: agent.stopTask, the effect comes as task_notification stopped; then TASK_NOT_FOUND', async () => {
    const h = await setup({ fakeTiming: HOLD_BACKGROUND });
    const entryId = await h.create('fake:background');
    await h.waitFor(() => h.facts(entryId).backgroundTasks === 1);
    await h.settle();
    const [task] = (await view(h, entryId)).detail.backgroundTasks;
    if (task === undefined) throw new Error('no background task');
    // The CLI holds idle back while the agent runs.
    expect(h.facts(entryId).runState).not.toBe('idle');
    expect(await h.cmd({ name: 'session.stopTask', entryId, taskId: task.taskId })).toEqual({});
    expect(h.session(entryId).controls).toContainEqual({ method: 'stopTask', args: [task.taskId] });
    // The command answers at once; the effect comes from the CLI (task_notification stopped).
    await h.waitFor(() => h.facts(entryId).backgroundTasks === 0);
    await untilIdle(h, entryId);
    const agent = toolCallOf(h, entryId, 'Agent');
    expect(agent?.kind === 'tool_call' ? agent.task?.status : null).toBe('stopped');
    expect(await h.cmdError({ name: 'session.stopTask', entryId, taskId: task.taskId })).toEqual({
      code: 'TASK_NOT_FOUND',
      params: { taskId: task.taskId },
    });
  });

  it('a running tool-call task (not in backgroundTasks) can be stopped too', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000005a1' });
    const prompt = c.ids.uuid();
    const toolUseId = c.ids.toolUseId();
    const taskId = 'task_foreground';
    const events = join(
      input(c, prompt, 'research'),
      turnOpen(c, prompt),
      toolUseBlock(
        c,
        'Agent',
        { subagent_type: 'general-purpose', description: 'Research', prompt: 'Look around.' },
        { toolUseId },
      ),
      toEvents([
        frame(
          c,
          system(0, 'task_started', {
            task_id: taskId,
            tool_use_id: toolUseId,
            description: 'Research',
            subagent_type: 'general-purpose',
            is_backgrounded: false,
            task_type: 'local_agent',
          }),
        ),
      ]),
      input(c, c.ids.uuid(), 'never sent'),
      closeGate(),
    );
    const h = await setup({ scenario: () => eventsScenario('foreground-task', events) });
    const entryId = await h.create('research');
    await h.waitFor(() => {
      const call = toolCallOf(h, entryId, 'Agent');
      return call?.kind === 'tool_call' && call.task?.taskId === taskId;
    });
    await h.settle();
    expect(h.facts(entryId).backgroundTasks).toBe(0);
    expect(await h.cmd({ name: 'session.stopTask', entryId, taskId })).toEqual({});
    expect(h.session(entryId).controls).toContainEqual({ method: 'stopTask', args: [taskId] });
  });

  it('error rows: SESSION_NOT_RUNNING, TASK_NOT_FOUND, CLAUDE_CONTROL_FAILED, SESSION_EXTERNAL, SESSION_ARCHIVED, ENTRY_NOT_FOUND', async () => {
    const external = sampleEntry({
      id: sampleId('en', 3),
      lastRunState: 'external',
      external: sampleExternalHandoff(),
    });
    const archived = sampleEntry({ id: sampleId('en', 4), archived: true, lastRunState: 'sleeping' });
    const h = await setup({ seed: { entries: [external, archived] }, fakeTiming: HOLD_BACKGROUND });
    const stop = (entryId: EntryId, taskId = 'task_x'): CommandInput => ({
      name: 'session.stopTask',
      entryId,
      taskId,
    });
    expect(await h.cmdError(stop(external.id))).toEqual({
      code: 'SESSION_EXTERNAL',
      params: { entryId: external.id },
    });
    expect((await h.cmdError(stop(archived.id))).code).toBe('SESSION_ARCHIVED');
    expect((await h.cmdError(stop(sampleId('en', 99)))).code).toBe('ENTRY_NOT_FOUND');
    const dormant = await h.create(null);
    expect(await h.cmdError(stop(dormant))).toEqual({
      code: 'SESSION_NOT_RUNNING',
      params: { entryId: dormant },
    });

    const start = h.backend.start.bind(h.backend);
    h.backend.start = (req) => {
      const agent = start(req);
      agent.stopTask = () => Promise.reject(new Error('control channel closed'));
      return agent;
    };
    const entryId = await h.create('fake:background');
    await h.waitFor(() => h.facts(entryId).backgroundTasks === 1);
    await h.settle();
    const [task] = (await view(h, entryId)).detail.backgroundTasks;
    if (task === undefined) throw new Error('no background task');
    expect(await h.cmdError(stop(entryId, 'task_unknown'))).toEqual({
      code: 'TASK_NOT_FOUND',
      params: { taskId: 'task_unknown' },
    });
    expect(await h.cmdError(stop(entryId, task.taskId))).toEqual({
      code: 'CLAUDE_CONTROL_FAILED',
      params: { method: 'stopTask' },
    });
    // Nothing changed: the agent still runs.
    expect(h.facts(entryId).backgroundTasks).toBe(1);
  });
});

// =====================================================================================
// plan.list / plan.read / latestPlanVersion (ADR-148)
// =====================================================================================

describe('plan versions (ADR-148)', () => {
  it('live: latestPlanVersion per version, previousVersionPlan, plan.list ascending with stored, plan.read; archived too', async () => {
    const h = await setup();
    const { entryId, decision: v1 } = await planEntry(h);
    expect(detailPatches(h, entryId).filter((p) => p.latestPlanVersion !== undefined)).toEqual([
      expect.objectContaining({ latestPlanVersion: 1 }),
    ]);
    expect((await view(h, entryId)).detail.latestPlanVersion).toBe(1);
    // The fake writes the plan file for real, below the harness's filesRoot (WP-52).
    expect(v1.planFilePath?.startsWith(`${h.filesRoot}\\`)).toBe(true);
    await respondPlan(h, entryId, v1.id, { behavior: 'revise', feedback: 'Add a test step' });
    const v2 = await openPlan(h, entryId, 2);
    expect(v2.previousVersionPlan).toBe(v1.plan);
    expect(v2.planFilePath).toBe(v1.planFilePath);
    expect((await view(h, entryId)).detail.latestPlanVersion).toBe(2);
    await respondPlan(h, entryId, v2.id, { behavior: 'approve', mode: 'default' });
    await untilIdle(h, entryId);

    const { versions } = await h.cmd({ name: 'plan.list', entryId });
    expect(versions).toEqual([
      {
        version: 1,
        decisionId: v1.id,
        conversationId: v1.conversationId,
        createdAt: v1.createdAt,
        resolvedAt: expect.any(String) as string,
        outcome: { type: 'plan_revised' },
        planFilePath: v1.planFilePath,
        stored: true,
      },
      {
        version: 2,
        decisionId: v2.id,
        conversationId: v2.conversationId,
        createdAt: v2.createdAt,
        resolvedAt: expect.any(String) as string,
        outcome: { type: 'plan_approved', mode: 'default', edited: false, freshContext: false },
        planFilePath: v2.planFilePath,
        stored: true,
      },
    ]);
    expect(await h.cmd({ name: 'plan.read', entryId, version: 2 })).toEqual({ version: 2, text: v2.plan });

    await h.cmd({ name: 'session.setArchived', entryId, archived: true });
    expect((await h.cmd({ name: 'plan.list', entryId })).versions.map((v) => v.version)).toEqual([1, 2]);
    expect(await h.cmd({ name: 'plan.read', entryId, version: 1 })).toEqual({ version: 1, text: v1.plan });
    expect(await h.cmdError({ name: 'plan.read', entryId, version: 3 })).toEqual({
      code: 'PLAN_NOT_FOUND',
      params: { version: 3 },
    });
  });

  it('after a restart: dormant plan.list, latestPlanVersion in the view, previousVersionPlan read from plans/v1.md', async () => {
    const h = await setup();
    const { entryId, decision: v1 } = await planEntry(h);
    await respondPlan(h, entryId, v1.id, { behavior: 'approve', mode: 'default' });
    await untilIdle(h, entryId);
    const next = await restart(h);
    expect(next.facts(entryId).runState).toBe('sleeping');
    expect(
      (await next.cmd({ name: 'plan.list', entryId })).versions.map((v) => [v.version, v.stored]),
    ).toEqual([[1, true]]);
    expect((await view(next, entryId)).detail.latestPlanVersion).toBe(1);
    await next.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:plan' } });
    const v2 = await openPlan(next, entryId, 2);
    expect(v2.previousVersionPlan).toBe(v1.plan);
    expect(detailPatches(next, entryId).some((p) => p.latestPlanVersion === 2)).toBe(true);
  });

  it('external and seeded: a missing or unreadable file → stored false, plan.read PLAN_NOT_FOUND', async () => {
    const entry = sampleEntry({ lastRunState: 'external', external: sampleExternalHandoff() });
    const approved: DecisionRecord = sampleDecisionRecord({
      resolvedAt: sampleTime(5),
      outcome: { type: 'plan_approved', mode: 'default', edited: false, freshContext: false },
      decision: null,
    });
    const revised: DecisionRecord = sampleDecisionRecord({
      id: sampleId('dc', 9),
      toolUseId: 'toolu_01Decision9',
      createdAt: sampleTime(6),
      resolvedAt: sampleTime(7),
      outcome: { type: 'plan_revised' },
      planVersion: 2,
      decision: null,
    });
    const third: DecisionRecord = sampleDecisionRecord({
      id: sampleId('dc', 10),
      toolUseId: 'toolu_01Decision10',
      createdAt: sampleTime(8),
      resolvedAt: sampleTime(9),
      outcome: { type: 'plan_revised' },
      planVersion: 3,
      decision: null,
    });
    const h = await setup({
      seed: {
        entries: [entry],
        // Unsorted on disk: plan.list sorts by version.
        decisions: [{ entryId: entry.id, records: [third, approved, revised] }],
        plans: [
          { entryId: entry.id, version: 1, text: '# Plan v1' },
          { entryId: entry.id, version: 3, text: '# Plan v3' },
        ],
      },
    });
    const readPlan = h.stores.decisions.readPlan.bind(h.stores.decisions);
    h.stores.decisions.readPlan = (entryId, version) =>
      version === 3 ? Promise.reject(new Error('EACCES')) : readPlan(entryId, version);
    const { versions } = await h.cmd({ name: 'plan.list', entryId: entry.id });
    expect(versions.map((v) => [v.version, v.stored, v.outcome?.type])).toEqual([
      [1, true, 'plan_approved'],
      [2, false, 'plan_revised'],
      [3, false, 'plan_revised'],
    ]);
    expect(await h.cmd({ name: 'plan.read', entryId: entry.id, version: 1 })).toEqual({
      version: 1,
      text: '# Plan v1',
    });
    expect(await h.cmdError({ name: 'plan.read', entryId: entry.id, version: 2 })).toEqual({
      code: 'PLAN_NOT_FOUND',
      params: { version: 2 },
    });
    expect((await view(h, entry.id)).detail.latestPlanVersion).toBe(3);
    expect(h.facts(entry.id).runState).toBe('external');
  });
});

// =====================================================================================
// planFile (ADR-148)
// =====================================================================================

describe('planFile (ADR-148)', () => {
  it('(a) retroactive: a Write in the default mode becomes the plan file once the decision names it', async () => {
    const planPath = `${HARNESS_CWD}\\PLAN.md`;
    const h = await setup({ scenario: () => retroPlanScenario(planPath) });
    const entryId = await h.create('plan it');
    const decision = await openPlan(h, entryId);
    expect(decision.planFilePath).toBe(planPath);
    const write = toolCallOf(h, entryId, 'Write', planPath);
    if (write?.kind !== 'tool_call' || write.result === null) throw new Error('no plan write');
    const expected = { path: planPath, updatedAt: write.result.at, toolUseId: write.toolUseId };
    // Not set by the Write itself (default mode, no decision yet) – only with the decision.
    const patches = h.publisher
      .opsOf(entryId)
      .filter(
        (op) =>
          (op.op === 'detail.patch' && op.patch.planFile !== undefined) ||
          (op.op === 'decision.upsert' && op.decision.kind === 'plan'),
      )
      .map((op) => op.op);
    expect(patches).toEqual(['decision.upsert', 'detail.patch']);
    expect((await view(h, entryId)).detail.planFile).toEqual(expected);
    await respondPlan(h, entryId, decision.id, { behavior: 'approve', mode: 'default' });
    await untilIdle(h, entryId);
    expect((await view(h, entryId)).detail.planFile).toEqual(expected);
  });

  it('fake:plan (plan mode, rule b and a): set at the plan Write; stays after approval; /clear → null', async () => {
    const h = await setup();
    const { entryId, decision } = await planEntry(h);
    const planPath = decision.planFilePath ?? '';
    const write = toolCallOf(h, entryId, 'Write', planPath);
    if (write?.kind !== 'tool_call' || write.result === null) throw new Error('no plan write');
    const expected = { path: planPath, updatedAt: write.result.at, toolUseId: write.toolUseId };
    expect((await view(h, entryId)).detail.planFile).toEqual(expected);
    expect(detailPatches(h, entryId).filter((p) => p.planFile !== undefined)).toEqual([
      { planFile: expected },
    ]);
    await respondPlan(h, entryId, decision.id, { behavior: 'approve', mode: 'acceptEdits' });
    await untilIdle(h, entryId);
    // The implementation wrote hello.txt (not the plan): the plan file stays.
    expect(toolCallOf(h, entryId, 'Write', `${HARNESS_CWD}\\hello.txt`)).toBeDefined();
    expect((await view(h, entryId)).detail.planFile).toEqual(expected);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: '/clear' } });
    await h.waitFor(() => h.publisher.opsOf(entryId).some((op) => op.op === 'conversation.reset'));
    await untilIdle(h, entryId);
    expect((await view(h, entryId)).detail).toMatchObject({
      planFile: null,
      todos: null,
      latestPlanVersion: 1,
    });
  });

  it('(b) in plan mode the last finished Write/Edit of a .md file; kept across a restart', async () => {
    const c = dslContext({
      sessionId: '5e550000-0000-4000-8000-0000000005b1',
      permissionMode: 'plan',
      cwd: HARNESS_CWD,
    });
    const prompt = c.ids.uuid();
    const design = c.ids.toolUseId();
    const notes = c.ids.toolUseId();
    const failed = c.ids.toolUseId();
    const designPath = `${HARNESS_CWD}\\docs\\design.md`;
    const events = join(
      input(c, prompt, 'design it'),
      turnOpen(c, prompt),
      toolUseBlock(c, 'Write', { file_path: designPath, content: '# Design' }, { toolUseId: design }),
      toolResultMessage(c, design, `File created successfully at: ${designPath}`),
      toolUseBlock(
        c,
        'Write',
        { file_path: `${HARNESS_CWD}\\notes.txt`, content: 'x' },
        { toolUseId: notes },
      ),
      toolResultMessage(c, notes, 'File created successfully'),
      toolUseBlock(
        c,
        'Edit',
        { file_path: `${HARNESS_CWD}\\other.md`, old_string: 'a', new_string: 'b' },
        { toolUseId: failed },
      ),
      toolResultMessage(c, failed, 'String to replace not found in file.', { isError: true }),
      streamedText(c, 'The design is in docs/design.md.'),
      turnClose(c, prompt),
      closeGate(),
    );
    const h = await setup({ scenario: () => eventsScenario('plan-mode', events) });
    const entryId = await h.create('design it', { permissionMode: 'plan' });
    await untilIdle(h, entryId);
    const write = toolCallOf(h, entryId, 'Write', designPath);
    if (write?.kind !== 'tool_call' || write.result === null) throw new Error('no design write');
    const expected = { path: designPath, updatedAt: write.result.at, toolUseId: design };
    expect((await view(h, entryId)).detail.planFile).toEqual(expected);
    const next = await restart(h);
    expect((await view(next, entryId)).detail.planFile).toEqual(expected);
  });
});

// =====================================================================================
// todos (ADR-149)
// =====================================================================================

function todoEvents(c: DslContext, prompt: string, extra: ReturnType<typeof join> = []) {
  const todoWrite = c.ids.toolUseId();
  const create1 = c.ids.toolUseId();
  const create2 = c.ids.toolUseId();
  const update = c.ids.toolUseId();
  const ids = { todoWrite, create1, create2, update };
  const todos = [
    { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
    { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
  ];
  const events = join(
    input(c, prompt, 'plan the work'),
    turnOpen(c, prompt),
    toolUseBlock(c, 'TodoWrite', { todos }, { toolUseId: todoWrite }),
    toolResultMessage(c, todoWrite, 'Todos have been modified successfully.', {
      toolUseResult: { oldTodos: [], newTodos: todos },
    }),
    toolUseBlock(
      c,
      'TaskCreate',
      { subject: 'Write tests', description: 'Cover the parser', activeForm: 'Writing tests' },
      { toolUseId: create1 },
    ),
    toolResultMessage(c, create1, 'Task #1 created successfully: Write tests', {
      toolUseResult: { task: { id: '1', subject: 'Write tests' } },
    }),
    toolUseBlock(c, 'TaskCreate', { subject: 'Ship it', description: 'Release' }, { toolUseId: create2 }),
    toolResultMessage(c, create2, 'Task #2 created successfully: Ship it', {
      toolUseResult: { task: { id: '2', subject: 'Ship it' } },
    }),
    toolUseBlock(c, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { toolUseId: update }),
    toolResultMessage(c, update, 'Updated task #1 status', {
      toolUseResult: { success: true, taskId: '1', updatedFields: ['status'] },
    }),
    streamedText(c, 'Working on it.'),
    turnClose(c, prompt),
    extra,
    closeGate(),
  );
  return { events, ids };
}

const TASKS = [
  { id: '1', content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
  { id: '2', content: 'Ship it', status: 'pending', activeForm: null },
];

describe('todos (ADR-149)', () => {
  it('TodoWrite (todo_write), then TaskCreate/TaskUpdate (tasks) as detail.patch; /clear → null', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000005c1' });
    const prompt = c.ids.uuid();
    const clear = c.ids.uuid();
    const { events, ids } = todoEvents(
      c,
      prompt,
      join(
        input(c, clear, '/clear'),
        clearCommand(c, { prompt: clear, newSessionId: '5e550000-0000-4000-8000-0000000005c2' }),
      ),
    );
    const h = await setup({ scenario: () => eventsScenario('todos', events) });
    const entryId = await h.create('plan the work');
    await untilIdle(h, entryId);
    const lists = detailPatches(h, entryId).flatMap((p) => (p.todos === undefined ? [] : [p.todos]));
    expect(lists[0]).toEqual({
      source: 'todo_write',
      items: [
        { id: '0', content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
        { id: '1', content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
      ],
      updatedAt: expect.any(String) as string,
      toolUseId: ids.todoWrite,
    });
    expect(lists.at(-1)).toEqual({
      source: 'tasks',
      items: TASKS,
      updatedAt: expect.any(String) as string,
      toolUseId: ids.update,
    });
    expect((await view(h, entryId)).detail.todos).toEqual(lists.at(-1));
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: '/clear' } });
    await h.waitFor(() => h.publisher.opsOf(entryId).some((op) => op.op === 'conversation.reset'));
    await untilIdle(h, entryId);
    expect((await view(h, entryId)).detail.todos).toBeNull();
  });

  it('seeded from the transcript after a restart', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000005c3' });
    const { events, ids } = todoEvents(c, c.ids.uuid());
    const h = await setup({ scenario: () => eventsScenario('todos', events) });
    const entryId = await h.create('plan the work');
    await untilIdle(h, entryId);
    const next = await restart(h);
    expect((await view(next, entryId)).detail.todos).toEqual({
      source: 'tasks',
      items: TASKS,
      updatedAt: expect.any(String) as string,
      toolUseId: ids.update,
    });
  });

  it('limits: at most todoItemsMax items, texts capped (the hub validation passes)', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000005c4' });
    const prompt = c.ids.uuid();
    const todoWrite = c.ids.toolUseId();
    const todos = Array.from({ length: LIMITS.todoItemsMax + 5 }, (_, i) => ({
      content: i === 0 ? 'x'.repeat(5000) : `Step ${String(i)}`,
      status: i === 1 ? 'blocked' : 'pending',
    }));
    const events = join(
      input(c, prompt, 'many'),
      turnOpen(c, prompt),
      toolUseBlock(c, 'TodoWrite', { todos }, { toolUseId: todoWrite }),
      toolResultMessage(c, todoWrite, 'Todos have been modified successfully.'),
      turnClose(c, prompt),
      closeGate(),
    );
    const h = await setup({ scenario: () => eventsScenario('many-todos', events) });
    const entryId = await h.create('many');
    await untilIdle(h, entryId);
    const list = (await view(h, entryId)).detail.todos;
    expect(list?.items).toHaveLength(LIMITS.todoItemsMax);
    expect(list?.items[0]?.content.length).toBeLessThanOrEqual(2000);
    // Unknown status → pending (tolerant).
    expect(list?.items[1]).toMatchObject({ id: '1', status: 'pending' });
  });
});

// =====================================================================================
// Implement with a fresh context (ADR-147)
// =====================================================================================

describe('approve_fresh_context (ADR-147)', () => {
  it('open decision: deny + interrupt, outcome, process closed, new conversation without resume, exact first prompt', async () => {
    const h = await setup();
    const results = captureResults(h);
    const { entryId, decision } = await planEntry(h);
    const before = h.stores.registry.get(entryId);
    if (before === undefined) throw new Error('no entry');
    const old = currentConversation(before);
    expect(old.sessionId).not.toBeNull();

    const { outcome } = await respondPlan(h, entryId, decision.id, {
      behavior: 'approve_fresh_context',
      mode: 'acceptEdits',
    });
    expect(outcome).toEqual({
      type: 'plan_approved',
      mode: 'acceptEdits',
      edited: false,
      freshContext: true,
    });
    // 1. the open request got deny + interrupt with the fixed message.
    expect(results).toEqual([
      expect.objectContaining({ behavior: 'deny', message: FRESH_DENY_MESSAGE, interrupt: true }),
    ]);
    // 3. the old process is gone; 4. a new one without resume in the chosen mode.
    const [first, second] = h.sessions(entryId);
    expect(h.sessions(entryId)).toHaveLength(2);
    expect(first?.state).toBe('exited');
    expect(h.backend.starts.at(-1)).toMatchObject({
      resumeSessionId: null,
      permissionMode: 'acceptEdits',
      attachmentsDir: attachmentsDir(entryId),
    });
    // 5. the first prompt: header, plan file, empty line, plan – nothing else (no client_composed).
    const prompt = second?.sent[0];
    expect(second?.sent).toHaveLength(1);
    expect(prompt?.content).toEqual([
      { type: 'text', text: freshPrompt(decision.plan, decision.planFilePath) },
    ]);
    expect(prompt?.priority).toBe('next');
    expect(Object.keys(prompt ?? {}).sort()).toEqual(['content', 'priority', 'uuid']);

    const reset = h.publisher
      .opsOf(entryId)
      .find((op): op is Extract<SessionOp, { op: 'conversation.reset' }> => op.op === 'conversation.reset');
    expect(reset).toMatchObject({
      previousConversationId: old.id,
      trigger: 'fresh_session',
      hasEarlier: true,
    });
    const entry = h.stores.registry.get(entryId);
    expect(entry?.permissionMode).toBe('acceptEdits');
    expect(entry?.conversations).toHaveLength(2);
    expect(entry?.conversations[0]).toMatchObject({
      id: old.id,
      sessionId: old.sessionId,
      endReason: 'fresh_session',
    });
    expect(entry?.conversations[0]?.endedAt).not.toBeNull();
    expect(entry?.conversations[1]).toMatchObject({
      id: reset?.conversationId,
      endedAt: null,
      endReason: null,
    });
    // 2. outcome persisted, plan version stored.
    expect(h.stores.decisions.records(entryId)[0]?.outcome).toEqual(outcome);
    expect(h.stores.decisions.plan(entryId, 1)).toBe(decision.plan);

    await untilIdle(h, entryId);
    expect(currentConversation(h.stores.registry.get(entryId) ?? before).sessionId).not.toBe(old.sessionId);
    const v = await view(h, entryId);
    expect(v.decisions).toEqual([]);
    expect(v.detail).toMatchObject({
      conversationId: reset?.conversationId,
      planFile: null,
      todos: null,
      latestPlanVersion: 1,
    });
    expect(v.items.find((i) => i.kind === 'user_message')).toMatchObject({
      text: { text: freshPrompt(decision.plan, decision.planFilePath) },
    });
    // The fake CLI recognizes the fresh-context prompt (WP-52) and counts the plan lines.
    const answer = implementPlanText(freshPrompt(decision.plan, decision.planFilePath));
    expect(v.items.some((i) => i.kind === 'assistant_text' && i.text === answer)).toBe(true);
    expect((await h.cmd({ name: 'plan.list', entryId })).versions[0]?.outcome).toEqual(outcome);
  });

  it('editedPlan → edited true and the edited plan in the first prompt', async () => {
    const h = await setup();
    const { entryId, decision } = await planEntry(h);
    const editedPlan = '## Plan\n- Only update the README.\n';
    const { outcome } = await respondPlan(h, entryId, decision.id, {
      behavior: 'approve_fresh_context',
      mode: 'default',
      editedPlan,
    });
    expect(outcome).toEqual({ type: 'plan_approved', mode: 'default', edited: true, freshContext: true });
    expect(h.session(entryId).sent[0]?.content).toEqual([
      { type: 'text', text: freshPrompt(editedPlan, decision.planFilePath) },
    ]);
    await untilIdle(h, entryId);
  });

  it('expired decision after a restart: no deny (nothing open), the card closes, the new conversation starts', async () => {
    const h = await setup();
    const { entryId, decision } = await planEntry(h);
    const next = await restart(h);
    const results = captureResults(next);
    const [expired] = await next.decisions(entryId);
    expect(expired).toMatchObject({ id: decision.id, state: 'expired' });
    const { outcome } = await respondPlan(next, entryId, decision.id, {
      behavior: 'approve_fresh_context',
      mode: 'default',
    });
    expect(outcome).toEqual({ type: 'plan_approved', mode: 'default', edited: false, freshContext: true });
    expect(next.backend.starts).toHaveLength(1);
    expect(next.backend.starts[0]).toMatchObject({ resumeSessionId: null, permissionMode: 'default' });
    expect(next.session(entryId).sent[0]?.content).toEqual([
      { type: 'text', text: freshPrompt(decision.plan, decision.planFilePath) },
    ]);
    await untilIdle(next, entryId);
    expect(results).toEqual([]);
    expect(await next.decisions(entryId)).toEqual([]);
    expect(next.facts(entryId).decisions.expired).toBe(0);
    expect(next.publisher.opsOf(entryId)).toContainEqual(
      expect.objectContaining({ op: 'conversation.reset', trigger: 'fresh_session' }),
    );
  });

  it('rows: bypass without permission → MODE_NOT_ALLOWED, mode not offered → DECISION_OPTION_UNAVAILABLE, unknown → DECISION_NOT_FOUND', async () => {
    const h = await setup();
    const { entryId, decision } = await planEntry(h);
    expect(
      (
        await respondPlanError(h, entryId, decision.id, {
          behavior: 'approve_fresh_context',
          mode: 'bypassPermissions',
        })
      ).code,
    ).toBe('MODE_NOT_ALLOWED');
    expect(
      (await respondPlanError(h, entryId, decision.id, { behavior: 'approve_fresh_context', mode: 'plan' }))
        .code,
    ).toBe('DECISION_OPTION_UNAVAILABLE');
    expect(
      (
        await respondPlanError(h, entryId, sampleId('dc', 77), {
          behavior: 'approve_fresh_context',
          mode: 'default',
        })
      ).code,
    ).toBe('DECISION_NOT_FOUND');
    // Nothing happened: the decision is still open, one process.
    expect((await h.decisions(entryId)).map((d) => d.state)).toEqual(['open']);
    expect(h.sessions(entryId)).toHaveLength(1);
  });

  it('with work (a queued prompt) → SESSION_BUSY; the decision stays open', async () => {
    // CR-06: the shutdown ends a waiting session with queued work by taskkill – here the fake exits.
    const holder: { h: EngineHarness | null } = { h: null };
    const h = await setup({
      proc: {
        killProcessTree: (pid) => {
          holder.h?.backend.sessions.find((s) => s.pid === pid && s.state !== 'exited')?.crash(1);
          return Promise.resolve();
        },
      },
    });
    holder.h = h;
    const { entryId, decision } = await planEntry(h);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Also update the docs' } });
    expect(
      await respondPlanError(h, entryId, decision.id, { behavior: 'approve_fresh_context', mode: 'default' }),
    ).toEqual({ code: 'SESSION_BUSY', params: { entryId } });
    expect((await h.decisions(entryId)).map((d) => d.state)).toEqual(['open']);
    expect(h.sessions(entryId)).toHaveLength(1);
  });

  it('double click: the second answer → SESSION_BUSY, a later one → DECISION_ALREADY_RESOLVED; one new process', async () => {
    const h = await setup();
    const { entryId, decision } = await planEntry(h);
    const response: PlanResponseInput = { behavior: 'approve_fresh_context', mode: 'default' };
    const [first, second] = await Promise.allSettled([
      respondPlan(h, entryId, decision.id, response),
      respondPlan(h, entryId, decision.id, response),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(
      second.status === 'rejected' && second.reason instanceof CommandError ? second.reason.error : null,
    ).toEqual({
      code: 'SESSION_BUSY',
      params: { entryId },
    });
    expect((await respondPlanError(h, entryId, decision.id, response)).code).toBe(
      'DECISION_ALREADY_RESOLVED',
    );
    expect(h.sessions(entryId)).toHaveLength(2);
    await untilIdle(h, entryId);
  });

  it('a start failure ends like a failed start; the old conversation stays reachable', async () => {
    let failCwd = false;
    const h = await setup({
      checkCwd: (cwd) =>
        failCwd ? Promise.reject(new CommandError(makeError('CWD_NOT_FOUND', { cwd }))) : Promise.resolve(),
    });
    const { entryId, decision } = await planEntry(h);
    const before = h.stores.registry.get(entryId);
    if (before === undefined) throw new Error('no entry');
    const old = currentConversation(before);
    failCwd = true;
    expect(
      await respondPlanError(h, entryId, decision.id, { behavior: 'approve_fresh_context', mode: 'default' }),
    ).toEqual({ code: 'CWD_NOT_FOUND', params: { cwd: HARNESS_CWD } });
    expect(h.facts(entryId)).toMatchObject({ runState: 'error', errorCode: 'CWD_NOT_FOUND' });
    expect(h.stores.registry.get(entryId)?.lastError?.code).toBe('CWD_NOT_FOUND');
    // The old request was denied (the outcome stays), the new conversation has no Claude session.
    expect(h.stores.decisions.records(entryId)[0]?.outcome).toMatchObject({ freshContext: true });
    const entry = h.stores.registry.get(entryId);
    expect(entry?.conversations).toHaveLength(2);
    expect(currentConversation(entry ?? before).sessionId).toBeNull();
    expect((await view(h, entryId)).items.some((i) => i.kind === 'system' && i.event === 'error')).toBe(true);

    failCwd = false;
    await h.cmd({ name: 'session.switchConversation', entryId, conversationId: old.id });
    expect(currentConversation(h.stores.registry.get(entryId) ?? before)).toMatchObject({
      id: old.id,
      sessionId: old.sessionId,
    });
    // The tail of the old conversation brings its plan file back.
    expect((await view(h, entryId)).detail.planFile?.path).toBe(decision.planFilePath);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'continue' } });
    expect(h.backend.starts.at(-1)?.resumeSessionId).toBe(old.sessionId);
    await untilIdle(h, entryId);
  });

  it('external and archived entries → SESSION_EXTERNAL / SESSION_ARCHIVED (gate)', async () => {
    const external = sampleEntry({
      id: sampleId('en', 3),
      lastRunState: 'external',
      external: sampleExternalHandoff(),
    });
    const archived = sampleEntry({ id: sampleId('en', 4), archived: true, lastRunState: 'sleeping' });
    const h = await setup({ seed: { entries: [external, archived] } });
    const response: PlanResponseInput = { behavior: 'approve_fresh_context', mode: 'default' };
    expect((await respondPlanError(h, external.id, sampleId('dc', 1), response)).code).toBe(
      'SESSION_EXTERNAL',
    );
    expect((await respondPlanError(h, archived.id, sampleId('dc', 1), response)).code).toBe(
      'SESSION_ARCHIVED',
    );
  });
});

// =====================================================================================
// CR2: pendingRename after a refused send
// =====================================================================================

describe('pendingRename (CR2 follow-up)', () => {
  it('a refused /rename leaves no pendingRename (rename and sendPrompt); an accepted one is echoed', async () => {
    const h = await setup();
    const refuse = { value: false };
    const start = h.backend.start.bind(h.backend);
    h.backend.start = (req) => {
      const agent = start(req);
      const send = agent.send.bind(agent);
      agent.send = (prompt) => {
        if (refuse.value) throw new Error('session closed');
        send(prompt);
      };
      return agent;
    };
    const entryId = await idleEntry(h);
    refuse.value = true;
    await h.cmd({ name: 'session.rename', entryId, title: 'Refused name' });
    expect(h.manager.inspect(entryId)?.pendingRename).toBeNull();
    expect(h.summary(entryId)).toMatchObject({ title: 'Refused name', titleSource: 'custom' });
    expect(
      await h.cmdError({ name: 'session.sendPrompt', entryId, prompt: { text: '/rename Other' } }),
    ).toMatchObject({
      code: 'SESSION_NOT_RUNNING',
    });
    expect(h.manager.inspect(entryId)?.pendingRename).toBeNull();
    expect(h.manager.inspect(entryId)?.queue).toEqual([]);

    refuse.value = false;
    await h.cmd({ name: 'session.rename', entryId, title: 'Accepted name' });
    expect(h.session(entryId).sent.at(-1)).toMatchObject({
      content: [{ type: 'text', text: '/rename Accepted name' }],
    });
    await h.settle();
    expect(h.manager.inspect(entryId)?.pendingRename).toBeNull();
    expect(h.summary(entryId)).toMatchObject({ title: 'Accepted name', titleSource: 'custom' });
  });
});
