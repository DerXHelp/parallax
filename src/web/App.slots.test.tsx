import { render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleTodoList } from '@shared/samples';
import { APP_SLOTS } from './App';
import { startTasksScenario, TASKS_SESSION_KEY } from './features/tasks/testing';
import type { RunningScenario } from './playground/PlaygroundScenario';
import { NotificationCenter } from './shell/NotificationCenter';
import { QUIET_SLOT_NOTICE_ID, resetQuietSlotFailures } from './shell/SlotBoundary';
import { FeatureSlotsProvider, type FeatureSlots } from './shell/slots';
import { clientStore, resetClientStore } from './state/store';
import { TooltipProvider } from './ui/tooltip';

/**
 * WP-60 (WP-58 "Lazy-Slot-Fehlergrenze", WP-50 §8): every lazy slot of APP_SLOTS sits in a
 * SlotBoundary OUTSIDE its own Suspense. Each lazily loaded module of a slot fails to load here
 * (as a chunk that cannot be downloaded) – the slot must show the boundary's card instead of
 * taking the whole tree down, and the content next to it must stay. `FileLink` is the quiet
 * exception (R5W-02): its references stay plain text, the window gets one notice.
 */

vi.mock('./features/transcript/TranscriptView', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});
vi.mock('./features/transcript/ToolInputPreview', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});
vi.mock('./features/transcript/markdown/MarkdownRenderer', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});
vi.mock('./features/decisions/components/PlanPanel', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});
vi.mock('./features/preferences', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});
vi.mock('./features/profiles', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});
vi.mock('./features/files/FileLink', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});
vi.mock('./features/files/FilePanel', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});
vi.mock('./features/files/FilesPanel', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});
vi.mock('./features/tasks/TasksPanel', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});
vi.mock('./features/tasks/TaskStrip', () => {
  throw new Error('Failed to fetch dynamically imported module (test)');
});

let running: RunningScenario | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
  resetQuietSlotFailures();
});

function slot<K extends keyof FeatureSlots>(key: K): FeatureSlots[K] {
  const component = APP_SLOTS[key];
  if (component === undefined) throw new Error(`slot ${key} is not wired`);
  return component;
}

const KEY = TASKS_SESSION_KEY;
const FILE = 'D:\\work\\sample\\README.md';

/** One element per lazy slot (createElement keeps each slot's own prop type). */
const LAZY_SLOTS: [keyof FeatureSlots, () => ReactNode][] = [
  ['Transcript', () => createElement(slot('Transcript'), { sessionKey: KEY })],
  ['Markdown', () => createElement(slot('Markdown'), { text: '# Title', sessionKey: KEY })],
  [
    'ToolInputPreview',
    () => createElement(slot('ToolInputPreview'), { toolName: 'Read', input: {}, sessionKey: KEY }),
  ],
  ['PlanPanel', () => createElement(slot('PlanPanel'), { sessionKey: KEY })],
  ['SettingsPage', () => createElement(slot('SettingsPage'), { section: 'about', onClose: () => undefined })],
  ['ProfilesSettings', () => createElement(slot('ProfilesSettings'), {})],
  [
    'FilePanel',
    () => createElement(slot('FilePanel'), { sessionKey: KEY, path: FILE, line: null, col: null }),
  ],
  ['FilesPanel', () => createElement(slot('FilesPanel'), { sessionKey: KEY })],
  ['TasksPanel', () => createElement(slot('TasksPanel'), { sessionKey: KEY })],
  // Loads its chunk only with open todos (the scenario below has them).
  ['TaskStrip', () => createElement(slot('TaskStrip'), { sessionKey: KEY })],
];

describe('APP_SLOTS: a lazy slot whose chunk fails shows the SlotBoundary card (WP-58, WP-60)', () => {
  it.each(LAZY_SLOTS)('%s', async (_key, make) => {
    running = startTasksScenario({ todos: sampleTodoList() });
    render(
      <FeatureSlotsProvider slots={APP_SLOTS}>
        <TooltipProvider>
          <p>still here</p>
          <div data-testid="slot">{make()}</div>
        </TooltipProvider>
      </FeatureSlotsProvider>,
    );
    const host = await screen.findByTestId('slot');
    await waitFor(
      () => {
        expect(host.querySelector('[data-slot="slot-error"]')).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    expect(within(host).getByText('This area could not be loaded')).toBeTruthy();
    expect(screen.getByText('still here')).toBeTruthy();
  });
});

describe('APP_SLOTS.FileLink: a failed chunk keeps the references as text (R5W-02)', () => {
  it('20 references in a paragraph: plain text, no card, no div in the p, at most one alert in the window', async () => {
    running = startTasksScenario({ todos: sampleTodoList() });
    const FileLink = slot('FileLink');
    const paths = Array.from({ length: 20 }, (_, index) => `D:\\work\\sample\\src\\file${String(index)}.ts`);
    render(
      <FeatureSlotsProvider slots={APP_SLOTS}>
        <TooltipProvider>
          <p data-testid="paragraph">
            {paths.map((path, index) => (
              <FileLink key={path} sessionKey={KEY} path={path} line={index === 0 ? 12 : null} />
            ))}
            <FileLink sessionKey={KEY} path={FILE}>
              {'the README'}
            </FileLink>
          </p>
          <FileLink sessionKey={KEY} path={FILE} variant="menu" />
          <NotificationCenter />
        </TooltipProvider>
      </FeatureSlotsProvider>,
    );
    const paragraph = screen.getByTestId('paragraph');
    await waitFor(
      () => {
        expect(paragraph.querySelectorAll('[data-slot="file-link-fallback"]')).toHaveLength(21);
      },
      { timeout: 10_000 },
    );
    const texts = [...paragraph.querySelectorAll('[data-slot="file-link-fallback"]')].map(
      (element) => element.textContent,
    );
    expect(texts[0]).toBe('src\\file0.ts:12');
    expect(texts[1]).toBe('src\\file1.ts');
    expect(texts[20]).toBe('the README');
    expect(document.querySelector('[data-slot="slot-error"]')).toBeNull();
    expect(paragraph.querySelector('div')).toBeNull();
    // The menu variant (actions only) shows nothing instead of a card.
    expect(document.querySelectorAll('[data-slot="file-link-fallback"]')).toHaveLength(21);
    // One loud message for the window: the notice of the NotificationCenter.
    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(1);
    });
    expect(clientStore.getState().notices.map((notice) => notice.id)).toEqual([QUIET_SLOT_NOTICE_ID]);
  });
});
