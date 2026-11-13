/**
 * WP-69 at the Agent card: "Transcript" opens the agent's transcript in the side panel (request
 * `openSubagent`, only with a mounted side panel host and a known agent id); a read-only transcript
 * (the subagent panel) shows neither Stop nor "Background".
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleItems, sampleSystemItems } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { registerShellRequestHandler, type ShellRequestOf } from '@web/shell/requests';
import { registerSidePanelHost, resetSidePanelState } from '@web/shell/side-panel/state';
import { resetClientStore } from '@web/state/store';
import { TranscriptSettingsContext } from '../context';
import { resetExpansion } from '../state/expansion';
import { AgentCard } from './AgentCard';
import { TranscriptRow } from './TranscriptRow';

const KEY = 'local:en_00000000000000000000000000000001';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setLanguage('en');
  resetSidePanelState();
  resetClientStore();
  resetExpansion();
});

function runningAgent() {
  const notification = sampleSystemItems.task_notification();
  return sampleItems.toolCall({
    id: 'msg_agent:0',
    toolUseId: 'toolu_agent',
    toolName: 'Agent',
    input: { description: 'Explore the project', prompt: 'Look around.', subagent_type: 'Explore' },
    status: 'running',
    result: null,
    task: {
      ...notification.task,
      taskId: 'a655391549dc96788',
      taskType: 'local_agent',
      status: 'running',
      isBackgrounded: false,
      outputFile: null,
      endedAt: null,
    },
  });
}

describe('Agent card – open transcript (WP-69)', () => {
  it('with a side panel host: "Transcript" sends openSubagent with id, title and type', async () => {
    const requests: ShellRequestOf<'openSubagent'>[] = [];
    cleanups.push(
      registerSidePanelHost(KEY),
      registerShellRequestHandler('openSubagent', (request) => {
        requests.push(request);
        return true;
      }),
    );
    const user = userEvent.setup();
    render(<AgentCard item={runningAgent()} sessionKey={KEY} />);
    await user.click(screen.getByRole('button', { name: 'Open the transcript of the agent “Explore the project”' }));
    expect(requests).toEqual([
      {
        kind: 'openSubagent',
        sessionKey: KEY,
        agentId: 'a655391549dc96788',
        title: 'Explore the project',
        subagentType: 'Explore',
      },
    ]);
    // The session transcript keeps its actions.
    expect(screen.getByRole('button', { name: 'Stop the agent “Explore the project”' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move “Explore the project” to the background' })).toBeTruthy();
  });

  it('no button without a host or without an agent id; German label', () => {
    const { unmount } = render(<AgentCard item={runningAgent()} sessionKey={KEY} />);
    expect(screen.queryByRole('button', { name: /transcript/i })).toBeNull();
    unmount();
    cleanups.push(registerSidePanelHost(KEY));
    const { unmount: unmountPlain } = render(
      <AgentCard item={{ ...runningAgent(), task: null }} sessionKey={KEY} />,
    );
    expect(screen.queryByRole('button', { name: /transcript/i })).toBeNull();
    unmountPlain();
    act(() => {
      setLanguage('de');
    });
    render(<AgentCard item={runningAgent()} sessionKey={KEY} />);
    expect(screen.getByRole('button', { name: 'Verlauf des Agenten „Explore the project“ öffnen' })).toBeTruthy();
  });

  it('read-only (the subagent panel): neither Stop nor "Background"', () => {
    render(
      <TranscriptSettingsContext value={{ sessionModel: null, showCost: false, Row: TranscriptRow, readOnly: true }}>
        <AgentCard item={runningAgent()} sessionKey={KEY} />
      </TranscriptSettingsContext>,
    );
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /background/i })).toBeNull();
  });
});
