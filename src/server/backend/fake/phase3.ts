/**
 * Phase-3 keywords of the interactive fake scenario (WP-52): `fake:background` (a background
 * agent with progress summaries and a real output file, done after 30 s or stopped earlier by
 * stopTask), `fake:todo` (TodoWrite with status updates), `fake:files` (Read/Write/Edit on real
 * files plus an answer with file references), `fake:writes-lost` (system/session_writes_lost on
 * exit) and the answers to prompts with PDFs, attached files and inline pastes. Real files only
 * under the fake files root (`ctx.files`).
 */
import type { FixtureEvent } from '../fixture';
import type { OutgoingPrompt } from '../types';
import {
  events,
  streamedText,
  subagentEnd,
  subagentLaunch,
  taskProgress,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
  type DslContext,
  type TaskUsageSpec,
} from './dsl';
import { patchHunks } from './files';
import { promptImageCount, receivedImagesText } from './image';
import { answerTurn, contextFor, type Turn } from './turn';
import type { FakeScriptContext } from './types';

/** `fake:background`: the agent runs this long (× speed; not capped by maxDelayMs). */
export const FAKE_BACKGROUND_MS = 30_000;
export const FAKE_BACKGROUND_DESCRIPTION = 'Fake background research';
export const FAKE_BACKGROUND_STARTED = 'A background agent is working on it; I will report when it is done.';
export const FAKE_BACKGROUND_SUMMARY = 'The fake project has three files and no open problems.';
export const FAKE_BACKGROUND_DONE = `Background agent finished: ${FAKE_BACKGROUND_SUMMARY}`;

/** Raw messages of DSL events (all `message` kind). */
function messagesOf(list: readonly FixtureEvent[]): unknown[] {
  return list.flatMap((event) => (event.kind === 'message' ? [event.payload] : []));
}

const usage = (totalTokens: number, toolUses: number, durationMs: number): TaskUsageSpec => ({
  totalTokens,
  toolUses,
  durationMs,
});

export async function background(
  ctx: FakeScriptContext,
  c: DslContext,
  turn: Turn,
  sessionId: string,
): Promise<void> {
  const toolUseId = ctx.ids.toolUseId();
  const taskId = `task_${toolUseId}`;
  const description = FAKE_BACKGROUND_DESCRIPTION;
  const output = `tasks\\${taskId}.output`;
  const outputFile = await ctx.files.write(output, `[fake] ${description} started\n`);
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      subagentLaunch(c, {
        toolUseId,
        taskId,
        description,
        prompt: 'Look through the project and summarize it.',
        reply: FAKE_BACKGROUND_SUMMARY,
        runInBackground: true,
        outputFile,
      }),
      taskProgress(c, { taskId, toolUseId, description, summary: 'Reading the project files', usage: usage(1_800, 1, 1_500) }),
      streamedText(c, FAKE_BACKGROUND_STARTED),
    ),
  );
  ctx.startTask({
    taskId,
    run: async (control) => {
      await control.wait(FAKE_BACKGROUND_MS / 2);
      await ctx.files.append(output, '[fake] halfway: writing the summary\n');
      control.emit(
        messagesOf(
          taskProgress(c, { taskId, toolUseId, description, summary: 'Writing the summary', usage: usage(4_200, 3, 15_000) }),
        ),
      );
      await control.wait(FAKE_BACKGROUND_MS / 2);
      await ctx.files.append(output, `[fake] ${FAKE_BACKGROUND_SUMMARY}\n`);
      control.emit(
        messagesOf(
          subagentEnd(c, { toolUseId, taskId, summary: FAKE_BACKGROUND_SUMMARY, outputFile, usage: usage(5_600, 3, FAKE_BACKGROUND_MS) }),
        ),
      );
      control.finish('completed');
      // The CLI answers the notification in a turn of its own (F.11); state of now (model, mode).
      const now = contextFor(ctx, sessionId);
      await control.betweenTurns(
        events(
          turnOpen(now, null),
          streamedText(now, FAKE_BACKGROUND_DONE),
          turnClose(now, null, { result: { result: FAKE_BACKGROUND_DONE } }),
        ),
      );
    },
    stopped: () =>
      messagesOf(
        subagentEnd(c, {
          toolUseId,
          taskId,
          summary: `${description} was stopped.`,
          outputFile,
          status: 'stopped',
          usage: usage(2_400, 1, 5_000),
        }),
      ),
  });
  // Result now; idle only once the agent has ended (the session holds it back, F.11).
  await ctx.play(turnClose(c, turn.prompt, { result: { result: FAKE_BACKGROUND_STARTED } }));
}

// ---- fake:todo ----

export const FAKE_TODOS = ['Read the existing code', 'Make the change', 'Run the tests'] as const;
const TODO_ACTIVE = ['Reading the existing code', 'Making the change', 'Running the tests'] as const;
const TODO_RESULT =
  'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable';

type TodoStatus = 'pending' | 'in_progress' | 'completed';

function todos(statuses: readonly TodoStatus[]): Record<string, unknown>[] {
  return FAKE_TODOS.map((content, i) => ({
    content,
    status: statuses[i] ?? 'pending',
    activeForm: TODO_ACTIVE[i] ?? content,
  }));
}

export async function todo(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const versions: TodoStatus[][] = [
    ['pending', 'pending', 'pending'],
    ['in_progress', 'pending', 'pending'],
    ['completed', 'pending', 'pending'],
  ];
  let previous: Record<string, unknown>[] = [];
  const parts: FixtureEvent[][] = [turnOpen(c, turn.prompt)];
  versions.forEach((statuses, index) => {
    const list = todos(statuses);
    const toolUseId = ctx.ids.toolUseId();
    parts.push(
      toolUseBlock(c, 'TodoWrite', { todos: list }, { toolUseId, ...(index === 0 ? { thinking: 'Planning the steps.' } : {}) }),
      toolResultMessage(c, toolUseId, TODO_RESULT, { toolUseResult: { oldTodos: previous, newTodos: list } }),
    );
    if (index === 0) parts.push(streamedText(c, 'Starting with the first item.'));
    previous = list;
  });
  const answer = 'The first item is done; two are left.';
  parts.push(streamedText(c, answer), turnClose(c, turn.prompt, { result: { result: answer } }));
  await ctx.play(events(...parts));
}

// ---- fake:files ----

export const FAKE_FILES_DIR = 'files';
export const FAKE_UNC_PATH = '\\\\fake-host\\share\\x.txt';
const NOTES = '# Fake notes\n\nThe fake workspace of Parallax.\n';
/** 14 lines; line 12 is the one `fake:files` edits and references (`app.ts:12`). */
const APP_LINES = [
  '// Fake app of the Parallax FakeBackend.',
  'export interface Answer {',
  '  value: number;',
  '}',
  '',
  'export function format(answer: Answer): string {',
  '  return `The answer is ${String(answer.value)}`;',
  '}',
  '',
  'export function main(): string {',
  '  // The line below is changed by fake:files.',
  '  const answer = 41;',
  '  return format({ value: answer });',
  '}',
];

function numbered(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${String(i + 1)}\t${line}`)
    .join('\n');
}

export async function files(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const notesRel = `${FAKE_FILES_DIR}\\notes.md`;
  const appRel = `${FAKE_FILES_DIR}\\app.ts`;
  const newRel = `${FAKE_FILES_DIR}\\new-file.txt`;
  const appText = `${APP_LINES.join('\n')}\n`;
  // Prepared before the turn, like files that already exist in a project.
  const notesPath = await ctx.files.write(notesRel, NOTES);
  const appPath = await ctx.files.write(appRel, appText);
  const newPath = ctx.files.path(newRel);

  const readId = ctx.ids.toolUseId();
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      toolUseBlock(c, 'Read', { file_path: notesPath }, { toolUseId: readId, thinking: 'Reading the notes first.' }),
      toolResultMessage(c, readId, numbered(NOTES), {
        toolUseResult: {
          type: 'text',
          file: { filePath: notesPath, content: NOTES, numLines: NOTES.split('\n').length, startLine: 1, totalLines: NOTES.split('\n').length },
        },
      }),
    ),
  );

  const newText = 'Created by fake:files.\n';
  const writeId = ctx.ids.toolUseId();
  await ctx.play(toolUseBlock(c, 'Write', { file_path: newPath, content: newText }, { toolUseId: writeId }));
  await ctx.files.write(newRel, newText);
  await ctx.play(
    toolResultMessage(c, writeId, `File created successfully at: ${newPath}`, {
      toolUseResult: { type: 'create', filePath: newPath, content: newText, structuredPatch: [], originalFile: null, userModified: false },
    }),
  );

  const oldString = '  const answer = 41;';
  const newString = '  const answer = 42;';
  const edited = appText.replace(oldString, newString);
  const editId = ctx.ids.toolUseId();
  await ctx.play(
    toolUseBlock(c, 'Edit', { file_path: appPath, old_string: oldString, new_string: newString, replace_all: false }, { toolUseId: editId }),
  );
  await ctx.files.write(appRel, edited);
  await ctx.play(
    toolResultMessage(c, editId, `The file ${appPath} has been updated successfully.`, {
      toolUseResult: {
        filePath: appPath,
        oldString,
        newString,
        originalFile: appText,
        structuredPatch: patchHunks(appText, edited),
        userModified: false,
        replaceAll: false,
      },
    }),
  );

  const answer = [
    'I read, wrote and changed files in the fake workspace:',
    '',
    `- The changed line: ${appPath}:12`,
    '- The project readme: README.md',
    `- The notes: [notes.md](<${notesPath.replaceAll('\\', '/')}>)`,
    `- New: ${newPath}`,
    `- A network path stays plain text: \`${FAKE_UNC_PATH}\``,
  ].join('\n');
  await ctx.play(events(streamedText(c, answer), turnClose(c, turn.prompt, { result: { result: answer } })));
}

// ---- fake:writes-lost ----

export const FAKE_WRITES_LOST_TEXT = 'Fake: the disk is full – this session reports lost writes when it ends.';
const writesLostArmed = new WeakSet<FakeScriptContext>();

/** Answers and arms `system/session_writes_lost` for the graceful exit (once per session). */
export async function writesLost(ctx: FakeScriptContext, c: DslContext, turn: Turn, sessionId: string): Promise<void> {
  if (!writesLostArmed.has(ctx)) {
    writesLostArmed.add(ctx);
    ctx.onClose(() => [
      {
        type: 'system',
        subtype: 'session_writes_lost',
        error_code: 'ENOSPC',
        lost: ['transcript'],
        transcript_session_ids: [sessionId],
        uuid: ctx.ids.uuid(),
        session_id: sessionId,
      },
    ]);
  }
  await answerTurn(ctx, c, turn, FAKE_WRITES_LOST_TEXT);
}

// ---- attachments and pastes (ADR-146) ----

export interface ReceivedCounts {
  images: number;
  documents: number;
  files: number;
  pastes: number;
}

/** `- <path>` lines of the engine's `Attached files:` block (WP-51). */
export function attachedFileCount(text: string): number {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Attached files:');
  if (start < 0) return 0;
  let count = 0;
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    count += 1;
  }
  return count;
}

export function receivedCounts(prompt: OutgoingPrompt, text: string): ReceivedCounts {
  return {
    images: promptImageCount(prompt),
    documents: prompt.content.filter((block) => block.type === 'document').length,
    files: attachedFileCount(text),
    pastes: prompt.inlinePastes?.length ?? 0,
  };
}

/** The fake CLI's answer to what came with the prompt (one line per kind); '' if nothing. */
export function receivedText(counts: ReceivedCounts): string {
  const lines: string[] = [];
  if (counts.images > 0) lines.push(receivedImagesText(counts.images));
  if (counts.documents > 0 || counts.files > 0) {
    lines.push(`Fake: received ${String(counts.documents)} document(s), ${String(counts.files)} file(s)`);
  }
  if (counts.pastes > 0) lines.push(`Fake: received ${String(counts.pastes)} paste(s)`);
  return lines.join('\n');
}
