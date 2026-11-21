import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostState } from '@shared/model';
import { sampleHostState, sampleSettings } from '@shared/samples';
import { TooltipProvider } from '@web/ui/tooltip';
import type { SettingsEditor } from '../state/settings-editor';
import { SessionsSection } from './SessionsSection';

/** WP-115: the idle-sleep hint names pinned sessions on a computer with the overview additions. */

const editor: SettingsEditor = {
  settings: sampleSettings(),
  save: () => undefined,
  error: null,
  dismissError: () => undefined,
};

afterEach(() => {
  cleanup();
});

function show(hostState: HostState | null): string {
  cleanup();
  render(
    <TooltipProvider>
      <SessionsSection editor={editor} hostState={hostState} />
    </TooltipProvider>,
  );
  const toggle = screen.getByRole('switch', { name: 'Put idle sessions to sleep' });
  const id = toggle.getAttribute('aria-describedby') ?? '';
  return document.getElementById(id)?.textContent ?? '';
}

describe('settings section "Sessions" (WP-115)', () => {
  it('"Pinned sessions do not fall asleep" only with features.overview', () => {
    const withOverview = show(sampleHostState({ features: { git: false, search: false, overview: true } }));
    expect(withOverview).toContain('A session shown in a window in front never sleeps.');
    expect(withOverview).toContain('Pinned sessions do not fall asleep.');
  });

  it('an older computer (no overview feature) keeps the plain hint', () => {
    expect(show(sampleHostState())).not.toContain('Pinned sessions');
    expect(show(null)).not.toContain('Pinned sessions');
  });
});
