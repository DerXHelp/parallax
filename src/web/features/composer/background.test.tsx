import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import type { TranscriptItem } from '@shared/model';
import { sampleItems, sampleTime } from '@shared/samples';
import { clientStore, resetClientStore } from '@web/state/store';
import { DEMO_ENTRIES } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { BackgroundAll } from './BackgroundAll';

/**
 * WP-65 §1.5: "Move all to background" next to Stop – only while a Bash call or subagent runs in
 * the foreground – and Ctrl+B with the focus in the session's pane.
 */

vi.setConfig({ testTimeout: 30_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
});

function Pane({ sessionKey }: { sessionKey: string }) {
  const composerRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <section data-session-key={sessionKey}>
        <textarea aria-label="transcript" />
        <div ref={composerRef}>
          <textarea aria-label="message" />
          <BackgroundAll sessionKey={sessionKey} composerRef={composerRef} online />
        </div>
      </section>
      <input aria-label="elsewhere" />
    </>
  );
}

function bash(status: 'running' | 'background' | 'done', toolName = 'Bash'): TranscriptItem {
  return sampleItems.toolCall({
    id: `it_${toolName}`,
    order: 50,
    at: sampleTime(50),
    toolUseId: `toolu_${toolName}`,
    toolName,
    input: { command: 'pnpm test --watch' },
    status,
    result: null,
  });
}

function start(): Harness {
  harness = renderWithHost((key) => <Pane sessionKey={key('working')} />, { entries: ['working'] });
  harness.running.connection.subscribe(DEMO_ENTRIES.working);
  return harness;
}

function push(h: Harness, item: TranscriptItem): void {
  act(() => {
    h.host.pushOps(DEMO_ENTRIES.working, [{ op: 'item.upsert', item }]);
  });
}

describe('BackgroundAll (WP-65 §1.5)', () => {
  it('appears only while a Bash call or subagent runs in the foreground; the click moves everything', async () => {
    const h = start();
    expect(screen.queryByRole('button', { name: 'Move all to background' })).toBeNull();
    push(h, bash('done'));
    push(h, bash('running'));
    const button = await screen.findByRole('button', { name: 'Move all to background' });
    await userEvent.setup().click(button);
    await waitFor(() => {
      expect(h.commands('session.backgroundTasks')).toEqual([
        { name: 'session.backgroundTasks', entryId: DEMO_ENTRIES.working, toolUseId: null },
      ]);
    });
    push(h, bash('background'));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Move all to background' })).toBeNull();
    });
    push(h, bash('running', 'Agent'));
    expect(await screen.findByRole('button', { name: 'Move all to background' })).toBeTruthy();
  });

  it('Ctrl+B only with the focus in the session pane (also in the message field)', async () => {
    const h = start();
    push(h, bash('running'));
    await screen.findByRole('button', { name: 'Move all to background' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('textbox', { name: 'elsewhere' }));
    await user.keyboard('{Control>}b{/Control}');
    expect(h.commands('session.backgroundTasks')).toEqual([]);
    await user.click(screen.getByRole('textbox', { name: 'message' }));
    await user.keyboard('{Control>}b{/Control}');
    await waitFor(() => {
      expect(h.commands('session.backgroundTasks')).toHaveLength(1);
    });
    // The fake host moved the call; a subagent starts in the foreground.
    push(h, bash('running', 'Agent'));
    await screen.findByRole('button', { name: 'Move all to background' });
    await user.click(screen.getByRole('textbox', { name: 'transcript' }));
    await user.keyboard('{Control>}b{/Control}');
    await waitFor(() => {
      expect(h.commands('session.backgroundTasks')).toHaveLength(2);
    });
  });

  it('Ctrl+B does nothing while nothing can move; a refusal becomes a notice', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(screen.getByRole('textbox', { name: 'message' }));
    await user.keyboard('{Control>}b{/Control}');
    expect(h.commands('session.backgroundTasks')).toEqual([]);
    push(h, bash('running'));
    h.host.failNext('session.backgroundTasks', makeError('SESSION_NOT_RUNNING'));
    await user.click(await screen.findByRole('button', { name: 'Move all to background' }));
    await waitFor(() => {
      expect(clientStore.getState().notices.map((notice) => notice.id)).toContain(
        `composer-background-${h.key('working')}`,
      );
    });
  });
});
