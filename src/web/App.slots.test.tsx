import { render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleTodoList } from '@shared/samples';
import { APP_SLOTS } from './App';
import { startTasksScenario, TASKS_SESSION_KEY } from './features/tasks/testing';
import type { RunningScenario } from './playground/PlaygroundScenario';
import { FeatureSlotsProvider, type FeatureSlots } from './shell/slots';
import { resetClientStore } from './state/store';
import { TooltipProvider } from './ui/tooltip';

/**
 * WP-60 (WP-58 "Lazy-Slot-Fehlergrenze", WP-50 §8): every lazy slot of APP_SLOTS sits in a
 * SlotBoundary OUTSIDE its own Suspense. Each lazily loaded module of a slot fails to load here
 * (as a chunk that cannot be downloaded) – the slot must show the boundary's card instead of
 * taking the whole tree down, and the content next to it must stay.
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
  ['FileLink', () => createElement(slot('FileLink'), { sessionKey: KEY, path: FILE })],
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
