import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import type { QueuedPrompt } from '@shared/model';
import type { Command } from '@shared/protocol';
import { sampleDecisions, sampleId } from '@shared/samples';
import { INITIAL_STATUS_FACTS } from '@shared/status';
import type { PlaygroundDemo } from '@web/playground/types';
import type { FakeAck, FakeHost } from '@web/state/fake-host';
import type { FeatureSlots } from '@web/shell/slots';
import { DEMO_ENTRIES, type DemoData } from '../decisions/lib/demo-data';
import type { DemoHost } from '../decisions/lib/demo-host';
import { DemoButton, DemoSession } from '../decisions/lib/demo-session';
import { Composer } from './Composer';
import { ComposerDemo } from './demo/ComposerDemo';
import { DEMO_COMMANDS, sampleScreenshot, withDetail, withSummary } from './demo/data';
import { addAttachmentFiles } from './state/attachments';

/**
 * Playground demos of the composer (WP-16; `#playground=composer/<id>`) in the real SessionPane.
 * The FakeHost has no prompt queue (R1W-22): `simulateQueue` adds one – while the session works a
 * `next` prompt waits in `detail.queue` ("sending" → "queued") and is taken over after a while;
 * Stop ends the turn and takes the queue over. The queue shows in the header badge and – with
 * the transcript slot – grey at the end of the transcript, not in the composer (R2W-04).
 */

const TAKE_OVER_MS = 4000;

function setQueue(host: FakeHost, entryId: string, queue: QueuedPrompt[]): void {
  host.pushOps(entryId, [{ op: 'detail.patch', patch: { queue } }]);
  host.patchSummary(entryId, {}, { queuedPrompts: queue.length });
}

function takeOver(host: FakeHost, entryId: string): void {
  const view = host.view(entryId);
  if (view === null) return;
  let order = view.items.at(-1)?.order ?? 0;
  const ops = view.detail.queue.map((prompt) => ({
    op: 'item.upsert' as const,
    item: {
      kind: 'user_message' as const,
      id: prompt.messageUuid,
      order: ++order,
      at: new Date().toISOString(),
      parentToolUseId: null,
      text: prompt.text,
      attachments: [],
      origin: 'human' as const,
      slashCommand: null,
      priority: prompt.priority,
    },
  }));
  if (ops.length > 0) host.pushOps(entryId, ops);
  setQueue(host, entryId, []);
}

function simulateQueue(cmd: Command, host: FakeHost): FakeAck | undefined {
  if (cmd.name === 'session.sendPrompt' && cmd.priority === 'next') {
    const summary = host.summaries.get(cmd.entryId);
    if (summary?.status.runState !== 'working') return undefined;
    const messageUuid = crypto.randomUUID();
    const queued: QueuedPrompt = {
      messageUuid,
      text: { text: cmd.prompt.text, truncated: null },
      attachments: [],
      priority: 'next',
      state: 'sending',
      queuedAt: new Date().toISOString(),
    };
    setQueue(host, cmd.entryId, [...(host.view(cmd.entryId)?.detail.queue ?? []), queued]);
    host.later(() => {
      const queue = host.view(cmd.entryId)?.detail.queue ?? [];
      setQueue(
        host,
        cmd.entryId,
        queue.map((prompt) => (prompt.messageUuid === messageUuid ? { ...prompt, state: 'queued' } : prompt)),
      );
    }, 700);
    host.later(() => {
      takeOver(host, cmd.entryId);
    }, TAKE_OVER_MS);
    return { ok: true, result: { messageUuid } };
  }
  if (cmd.name === 'session.interrupt') {
    host.interruptStreams(cmd.entryId);
    takeOver(host, cmd.entryId);
    host.patchSummary(cmd.entryId, { lastActivityAt: new Date().toISOString() }, { runState: 'idle' });
    return { ok: true, result: { stillQueued: [] } };
  }
  return undefined;
}

/** Phase-2 commands the FakeHost leaves to the packages (WP-30): a plausible engine answer. */
function phase2Commands(cmd: Command, host: FakeHost): FakeAck | undefined {
  const now = new Date().toISOString();
  switch (cmd.name) {
    case 'session.setFastMode':
      host.patchSummary(cmd.entryId, { fastMode: cmd.enabled });
      return { ok: true, result: {} };
    case 'session.openExternal':
      host.patchSummary(
        cmd.entryId,
        { external: { since: now, pid: 52_000, running: true } },
        { runState: 'external' },
      );
      host.pushOps(cmd.entryId, [
        {
          op: 'item.upsert',
          item: {
            kind: 'system',
            id: crypto.randomUUID(),
            order: (host.view(cmd.entryId)?.items.at(-1)?.order ?? 0) + 1,
            at: now,
            parentToolUseId: null,
            event: 'handoff',
            phase: 'external',
            importedItems: 0,
          },
        },
      ]);
      return { ok: true, result: { pid: 52_000 } };
    case 'session.reclaim':
      host.patchSummary(cmd.entryId, { external: null }, { runState: 'sleeping' });
      host.pushOps(cmd.entryId, [
        {
          op: 'item.upsert',
          item: {
            kind: 'system',
            id: crypto.randomUUID(),
            order: (host.view(cmd.entryId)?.items.at(-1)?.order ?? 0) + 1,
            at: now,
            parentToolUseId: null,
            event: 'handoff',
            phase: 'returned',
            importedItems: 2,
          },
        },
      ]);
      return { ok: true, result: { importedItems: 2 } };
    case 'session.continueAfterLimit': {
      const until = host.summaries.get(cmd.entryId)?.status.rateLimitedUntil ?? null;
      const future = until !== null && Date.parse(until) > Date.now();
      if (!cmd.enabled) host.patchSummary(cmd.entryId, {}, { wakeupAt: null });
      else if (future) host.patchSummary(cmd.entryId, {}, { wakeupAt: until });
      else host.patchSummary(cmd.entryId, {}, { wakeupAt: null, rateLimitedUntil: null });
      return { ok: true, result: { continueAt: cmd.enabled && future ? until : null } };
    }
    default:
      return undefined;
  }
}

/** The slash catalog plus the CLI's own terminal list (L1). */
function withCatalog(data: DemoData): DemoData {
  return {
    ...data,
    sessions: data.sessions.map((session) => ({
      ...session,
      detail: {
        ...session.detail,
        commands: DEMO_COMMANDS,
        init:
          session.detail.init === null
            ? null
            : { ...session.detail.init, terminalSlashCommands: ['statusline', 'theme'] },
      },
    })),
  };
}

function setLimit(running: DemoHost | null, untilOffsetMs: number, planned: boolean): void {
  if (running === null) return;
  const until = new Date(Date.now() + untilOffsetMs).toISOString();
  running.host.patchSummary(
    DEMO_ENTRIES.idle,
    {},
    { rateLimitedUntil: until, wakeupAt: planned ? until : null },
  );
}

async function addScreenshot(entryId: EntryId, name: string): Promise<void> {
  addAttachmentFiles(makeSessionKey(LOCAL_HOST_ID, entryId), [await sampleScreenshot(name)]);
}

let lateCounter = 0;

/** Opens a permission of the main agent or a subagent in the `working` demo session. */
function openLateDecision(running: DemoHost | null, requester: 'main' | 'subagent'): void {
  if (running === null) return;
  const entryId = DEMO_ENTRIES.working;
  lateCounter += 1;
  const decision = sampleDecisions.permission({
    entryId,
    id: sampleId('dc', 0xd00 + lateCounter),
    toolUseId: `toolu_demo_late_${String(lateCounter)}`,
    createdAt: new Date().toISOString(),
    input: { command: 'pnpm install', description: 'Install dependencies' },
    description: 'Install dependencies',
    requester:
      requester === 'main'
        ? { kind: 'main' }
        : {
            kind: 'subagent',
            agentId: 'agent_explore_1',
            description: 'Explore the store code',
            parentToolUseId: 'toolu_demo_agent',
          },
  });
  running.host.pushOps(entryId, [{ op: 'decision.upsert', decision }]);
  running.host.syncDecisionCounts(entryId);
}

export const demos: PlaygroundDemo[] = [
  {
    id: 'idle',
    title: 'Composer – idle (mode, model + effort, context 71 %)',
    description: 'Enter sends, Shift+Enter breaks the line; the draft survives a reload.',
    render: () => <DemoSession entries={['idle']} show="idle" />,
  },
  {
    id: 'working',
    title: 'Composer – working (queue, send now, stop, Esc)',
    description: 'Enter queues (priority next), "Send now" interrupts; Esc in the empty field stops.',
    render: () => <DemoSession entries={['working']} show="working" onCommand={simulateQueue} />,
  },
  {
    id: 'with-permission',
    title: 'Composer – open permission ("send as answer" = deny + message)',
    render: () => <DemoSession entries={['permission']} show="permission" />,
  },
  {
    id: 'late-decision',
    title: 'Composer – a decision appears while typing (target lock, R2W-01)',
    description:
      'Type first, then open a permission: Enter still queues the text; "Send as answer" answers explicitly.',
    render: () => (
      <DemoSession
        entries={['working']}
        show="working"
        onCommand={simulateQueue}
        controls={(host) => (
          <>
            <DemoButton
              label="Open a permission now"
              onClick={() => {
                openLateDecision(host.current, 'main');
              }}
            />
            <DemoButton
              label="Open a subagent permission"
              onClick={() => {
                openLateDecision(host.current, 'subagent');
              }}
            />
          </>
        )}
      />
    ),
  },
  {
    id: 'with-plan',
    title: 'Composer – open plan ("keep planning with feedback")',
    render: () => <DemoSession entries={['plan']} show="plan" />,
  },
  {
    id: 'bypass',
    title: 'Composer – profile allows bypass (red mode)',
    render: () => <DemoSession entries={['bypass']} show="bypass" />,
  },
  {
    id: 'slash',
    title: 'Composer – slash menu with catalog (WP-37)',
    description:
      'Type /: native commands (Parallax), Claude Code, skills, MCP; /model, /effort, /fast, /help, /status, /resume, /rename run here; /vim or /theme shows the terminal hint.',
    render: () => <ComposerDemo setup={withCatalog} onCommand={phase2Commands} />,
  },
  {
    id: 'slash-plain',
    title: 'Composer – slash menu without catalog (names from init)',
    description: 'Before supportedCommands() reported: only names, no descriptions or origin.',
    render: () => (
      <ComposerDemo setup={(data) => withDetail(data, { commands: null })} onCommand={phase2Commands} />
    ),
  },
  {
    id: 'attachments',
    title: 'Composer – screenshots: paste, drop, paper clip (WP-37)',
    description:
      'Chips with preview and upload state (fake uploader, 1.2 s). Names with "fail" get 413, with "type" 415. Sending waits for uploads.',
    render: () => (
      <ComposerDemo
        onCommand={phase2Commands}
        controls={() => (
          <>
            <DemoButton
              label="Add a 2560×1440 screenshot (scaled to 1568)"
              onClick={() => {
                void addScreenshot(DEMO_ENTRIES.idle, 'Screenshot 2026-10-16 141502.png');
              }}
            />
            <DemoButton
              label="Add one that fails (413)"
              onClick={() => {
                void addScreenshot(DEMO_ENTRIES.idle, 'fail-too-large.png');
              }}
            />
            <DemoButton
              label="Add one with a rejected type (415)"
              onClick={() => {
                void addScreenshot(DEMO_ENTRIES.idle, 'wrong-type.png');
              }}
            />
          </>
        )}
      />
    ),
  },
  {
    id: 'suggestion',
    title: 'Composer – prompt suggestion as ghost text (ADR-117)',
    description: 'Empty field shows the suggestion; Tab takes it.',
    render: () => (
      <ComposerDemo
        setup={(data) => withDetail(data, { promptSuggestion: 'Run the tests and fix what fails' })}
      />
    ),
  },
  {
    id: 'rate-limit',
    title: 'Composer – rate-limit banner (ADR-112)',
    description: 'Limited → "Continue at HH:MM" plans → "Cancel"; after the reset "Continue" right away.',
    render: () => (
      <ComposerDemo
        setup={(data) =>
          withSummary(data, {
            status: {
              ...(data.summaries[0]?.status ?? INITIAL_STATUS_FACTS),
              rateLimitedUntil: new Date(Date.now() + 2 * 3600_000).toISOString(),
            },
          })
        }
        onCommand={phase2Commands}
        controls={(host) => (
          <>
            <DemoButton
              label="Limited (2 h)"
              onClick={() => {
                setLimit(host.current, 2 * 3600_000, false);
              }}
            />
            <DemoButton
              label="Continue planned"
              onClick={() => {
                setLimit(host.current, 2 * 3600_000, true);
              }}
            />
            <DemoButton
              label="Limit reset (expired)"
              onClick={() => {
                setLimit(host.current, -60_000, false);
              }}
            />
            <DemoButton
              label="Resets in 10 s"
              onClick={() => {
                setLimit(host.current, 10_000, false);
              }}
            />
          </>
        )}
      />
    ),
  },
  {
    id: 'disabled',
    title: 'Composer – archived / open in an external console',
    description: 'No field, one short line; the pane banner has the actions ("Restore", "Take back").',
    render: () => (
      <ComposerDemo
        setup={(data) => withSummary(data, { archived: true })}
        onCommand={phase2Commands}
        controls={(host) => (
          <>
            <DemoButton
              label="Archive"
              onClick={() => {
                host.current?.host.patchSummary(DEMO_ENTRIES.idle, { archived: true });
              }}
            />
            <DemoButton
              label="Open in external console"
              onClick={() => {
                host.current?.host.patchSummary(
                  DEMO_ENTRIES.idle,
                  {
                    archived: false,
                    external: { since: new Date().toISOString(), pid: 52_000, running: true },
                  },
                  { runState: 'external' },
                );
              }}
            />
            <DemoButton
              label="Console ended"
              onClick={() => {
                host.current?.host.patchSummary(DEMO_ENTRIES.idle, {
                  external: { since: new Date().toISOString(), pid: 52_000, running: false },
                });
              }}
            />
          </>
        )}
      />
    ),
  },
];

export const slots: Partial<FeatureSlots> = { Composer };
