import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { TaskInfo, ToolCallItem } from '@shared/model';
import {
  SAMPLE_IDS,
  sampleDetail,
  sampleItems,
  sampleSessionSnapshot,
  sampleSummary,
  sampleSystemItems,
  sampleTime,
} from '@shared/samples';
import type { RunningScenario } from '@web/playground/PlaygroundScenario';
import { FeatureSlotsProvider, type FeatureSlots, type FileLinkSlotProps } from '@web/shell/slots';
import { clientStore, resetClientStore, updateHost } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { resetExpansion } from '../state/expansion';
import { startTranscriptScenario } from '../testing';
import { AgentCard } from './AgentCard';
import { PlanCard } from './PlanCard';
import { SystemRow } from './SystemRow';
import { ToolCallRow } from './ToolCallRow';

/** Tool cards, plan card, task rows and the agent card link their files (WP-55). */

const ENTRY = SAMPLE_IDS.entry;
const KEY = makeSessionKey(LOCAL_HOST_ID, ENTRY);
const CWD = 'D:\\work\\sample';

/** FileLink stand-in: shows the props it got. */
function ProbeFileLink({ path, line, verify, children }: FileLinkSlotProps) {
  return (
    <span data-testid="file-link" data-path={path} data-line={line ?? ''} data-verify={String(verify)}>
      {children ?? path}
    </span>
  );
}
const SLOTS: Partial<FeatureSlots> = { FileLink: ProbeFileLink };

function renderWithSlots(element: ReactElement) {
  return render(
    <TooltipProvider>
      <FeatureSlotsProvider slots={SLOTS}>{element}</FeatureSlotsProvider>
    </TooltipProvider>,
  );
}

function links() {
  return screen.queryAllByTestId('file-link').map((link) => ({
    text: link.textContent,
    path: link.dataset.path,
    line: link.dataset.line,
    verify: link.dataset.verify,
  }));
}

let running: RunningScenario | null = null;

beforeEach(() => {
  updateHost(clientStore, LOCAL_HOST_ID, () => ({
    summaries: { [ENTRY]: sampleSummary({ entryId: ENTRY }) },
  }));
});

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
  resetExpansion();
});

function tool(
  toolName: string,
  input: ToolCallItem['input'],
  patch: Partial<ToolCallItem> = {},
): ToolCallItem {
  return sampleItems.toolCall({ toolName, input, result: null, ...patch });
}

describe('tool cards link their file (verify: false)', () => {
  it('Edit: the path relative to the cwd, at the first changed line of the patch', () => {
    const item = tool(
      'Edit',
      { file_path: 'src\\main.ts', old_string: 'a', new_string: 'b' },
      {
        result: {
          isError: false,
          content: [],
          structured: {
            structuredPatch: [
              { oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' one', ' two', '-a', '+b'] },
            ],
          },
          structuredTruncated: null,
          at: sampleTime(5),
        },
      },
    );
    renderWithSlots(<ToolCallRow item={item} sessionKey={KEY} />);
    expect(links()).toEqual([
      { text: 'src\\main.ts', path: `${CWD}\\src\\main.ts`, line: '12', verify: 'false' },
    ]);
    // Not inside the toggle button (no interactive element in a button).
    expect(screen.getByTestId('file-link').closest('button')).toBeNull();
  });

  it.each<[string, ToolCallItem['input'], string, string]>([
    ['Read', { file_path: 'D:/work/sample/README.md', offset: 40, limit: 20 }, `${CWD}\\README.md`, '40'],
    ['Read', { file_path: 'D:\\work\\sample\\README.md' }, `${CWD}\\README.md`, ''],
    ['Write', { file_path: 'docs/new.md', content: '# New' }, `${CWD}\\docs\\new.md`, ''],
    ['MultiEdit', { file_path: '/d/work/sample/a.ts', edits: [] }, `${CWD}\\a.ts`, ''],
    [
      'NotebookEdit',
      { notebook_path: 'C:\\nb\\analysis.ipynb', new_source: 'x' },
      'C:\\nb\\analysis.ipynb',
      '',
    ],
  ])('%s %j', (toolName, input, path, line) => {
    renderWithSlots(<ToolCallRow item={tool(toolName, input)} sessionKey={KEY} />);
    expect(links()).toEqual([expect.objectContaining({ path, line, verify: 'false' })]);
  });

  it('no link while the input streams, for UNC paths, or without a known cwd for a relative path', () => {
    const { unmount } = renderWithSlots(
      <ToolCallRow
        item={tool('Write', { file_path: 'docs/ne', content: '' }, { status: 'streaming_input' })}
        sessionKey={KEY}
      />,
    );
    expect(links()).toEqual([]);
    unmount();
    renderWithSlots(
      <ToolCallRow item={tool('Read', { file_path: '\\\\server\\share\\a.ts' })} sessionKey={KEY} />,
    );
    expect(links()).toEqual([]);
    expect(screen.getByText(/share/).closest('[data-file-ref="text"]')).not.toBeNull();
  });

  it('Glob hits and Grep content groups (at their first line) are links', async () => {
    const user = userEvent.setup();
    const glob = tool(
      'Glob',
      { pattern: '**/*.md' },
      {
        result: {
          isError: false,
          content: [{ type: 'text', text: { text: 'README.md\ndocs\\a.md', truncated: null } }],
          structured: {
            mode: 'files_with_matches',
            filenames: ['README.md', 'D:\\work\\sample\\docs\\a.md'],
          },
          structuredTruncated: null,
          at: sampleTime(5),
        },
      },
    );
    const grep = sampleItems.toolCall({
      id: 'grep-1',
      toolName: 'Grep',
      input: { pattern: 'foo', output_mode: 'content' },
      result: {
        isError: false,
        content: [
          {
            type: 'text',
            text: { text: 'src/a.ts:3:foo\nsrc/a.ts:9:foo()\nsrc/b.ts:1:foo', truncated: null },
          },
        ],
        structured: null,
        structuredTruncated: null,
        at: sampleTime(5),
      },
    });
    renderWithSlots(
      <>
        <ToolCallRow item={glob} sessionKey={KEY} />
        <ToolCallRow item={grep} sessionKey={KEY} />
      </>,
    );
    for (const toggle of screen.getAllByRole('button', { expanded: false })) await user.click(toggle);
    expect(links()).toEqual([
      { text: 'README.md', path: `${CWD}\\README.md`, line: '', verify: 'false' },
      {
        text: expect.stringContaining('a.md') as string,
        path: `${CWD}\\docs\\a.md`,
        line: '',
        verify: 'false',
      },
      { text: 'src/a.ts', path: `${CWD}\\src\\a.ts`, line: '3', verify: 'false' },
      { text: 'src/b.ts', path: `${CWD}\\src\\b.ts`, line: '1', verify: 'false' },
    ]);
  });

  it('the plan card links planFilePath', () => {
    const item = sampleItems.toolCall({
      toolName: 'ExitPlanMode',
      input: { plan: '# Plan', planFilePath: 'C:\\Users\\user\\.claude\\plans\\p.md' },
    });
    renderWithSlots(<PlanCard item={item} sessionKey={KEY} />);
    expect(screen.getByText('Plan file:')).toBeTruthy();
    expect(links()).toContainEqual({
      text: expect.stringContaining('p.md') as string,
      path: 'C:\\Users\\user\\.claude\\plans\\p.md',
      line: '',
      verify: 'false',
    });
  });

  it('a task notification links its output file', () => {
    renderWithSlots(<SystemRow item={sampleSystemItems.task_notification()} sessionKey={KEY} />);
    expect(screen.getByText('Output file:')).toBeTruthy();
    expect(links()).toEqual([
      expect.objectContaining({
        path: 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\tasks\\task_01.output',
        verify: 'false',
      }),
    ]);
  });
});

function agentTask(patch: Partial<TaskInfo> = {}): TaskInfo {
  return {
    taskId: 'task_agent_1',
    taskType: 'local_agent',
    status: 'running',
    description: 'Explore the code',
    subagentType: 'Explore',
    isBackgrounded: true,
    summary: 'Reading the transcript renderers',
    usage: { totalTokens: 12_400, toolUses: 7, durationMs: 30_000 },
    startedAt: sampleTime(1),
    endedAt: null,
    outputFile: 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\tasks\\task_agent_1.output',
    ...patch,
  };
}

function agent(patch: Partial<ToolCallItem> = {}): ToolCallItem {
  return sampleItems.toolCall({
    id: 'agent-1',
    toolUseId: 'toolu_agent_1',
    toolName: 'Agent',
    input: { description: 'Explore the code', prompt: 'Find the renderers', subagent_type: 'Explore' },
    status: 'background',
    result: null,
    task: agentTask(),
    ...patch,
  });
}

describe('agent card (WP-55)', () => {
  it('running: Stop, the progress summary and the output file', () => {
    renderWithSlots(<AgentCard item={agent()} sessionKey={KEY} />);
    expect(screen.getByRole('button', { name: 'Stop the agent “Explore the code”' })).toBeTruthy();
    expect(screen.getByText('Reading the transcript renderers')).toBeTruthy();
    expect(screen.getByText('Output file:')).toBeTruthy();
    expect(links()).toEqual([
      expect.objectContaining({
        path: 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\tasks\\task_agent_1.output',
        verify: 'false',
      }),
    ]);
  });

  it.each<[string, Partial<ToolCallItem>]>([
    ['finished', { status: 'done', task: agentTask({ status: 'completed', endedAt: sampleTime(30) }) }],
    ['stopped', { status: 'interrupted', task: agentTask({ status: 'stopped', endedAt: sampleTime(30) }) }],
    ['without task', { status: 'running', task: null }],
  ])('%s: no Stop', (_label, patch) => {
    renderWithSlots(<AgentCard item={agent(patch)} sessionKey={KEY} />);
    expect(screen.queryByRole('button', { name: /Stop the agent/ })).toBeNull();
  });

  function startWithAgent(item: ToolCallItem): RunningScenario {
    running = startTranscriptScenario([
      {
        snapshot: sampleSessionSnapshot({
          entryId: ENTRY,
          seq: 0,
          items: [item],
          detail: sampleDetail({ entryId: ENTRY }),
        }),
        summary: sampleSummary({ entryId: ENTRY }),
      },
    ]);
    return running;
  }

  it('Stop sends session.stopTask for the task and stays busy until the task ends', async () => {
    const user = userEvent.setup();
    const item = agent();
    const scenario = startWithAgent(item);
    renderWithSlots(<AgentCard item={item} sessionKey={KEY} />);
    const stop = screen.getByRole('button', { name: 'Stop the agent “Explore the code”' });
    await user.click(stop);
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.stopTask',
        entryId: ENTRY,
        taskId: 'task_agent_1',
      });
    });
    expect(stop).toHaveProperty('disabled', true);
    expect(clientStore.getState().notices).toEqual([]);
  });

  it(
    'TASK_NOT_FOUND is silent (the task ended meanwhile); another error shows a notice',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      const item = agent();
      const scenario = startWithAgent(item);
      scenario.host.failNext('session.stopTask', makeError('TASK_NOT_FOUND', { taskId: 'task_agent_1' }));
      scenario.host.failNext('session.stopTask', makeError('INTERNAL_ERROR'));
      renderWithSlots(<AgentCard item={item} sessionKey={KEY} />);
      const stop = screen.getByRole('button', { name: 'Stop the agent “Explore the code”' });
      await user.click(stop);
      await waitFor(() => {
        expect(stop).toHaveProperty('disabled', false);
      });
      expect(clientStore.getState().notices).toEqual([]);
      await user.click(stop);
      await waitFor(() => {
        expect(
          clientStore
            .getState()
            .notices.map((notice) => ('error' in notice.content ? notice.content.error.code : null)),
        ).toEqual(['INTERNAL_ERROR']);
      });
      expect(stop).toHaveProperty('disabled', false);
    },
  );
});
