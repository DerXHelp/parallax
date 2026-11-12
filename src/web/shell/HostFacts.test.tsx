import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClaudeInstallStatus } from '@shared/model';
import { sampleClaudeInstallStatus, sampleHostState, sampleProfileSummary } from '@shared/samples';
import { newerThanTested } from '@web/lib/version';
import { resetClientStore } from '@web/state/store';
import { HostFacts } from './HostFacts';

afterEach(() => {
  resetClientStore();
});

function renderFacts(claude: Partial<ClaudeInstallStatus>) {
  const hostState = sampleHostState({ profiles: [sampleProfileSummary({ claude: sampleClaudeInstallStatus(claude) })] });
  render(<HostFacts hostState={hostState} />);
  return document.querySelector<HTMLElement>('[data-info="claude"]');
}

describe('HostFacts: claude newer than the version tested with Parallax (WP-62)', () => {
  it('shows a quiet note (no error colour) when the installed claude is newer', () => {
    const info = renderFacts({ version: '2.1.330', testedVersion: '2.1.322' });
    const note = screen.getByText('Claude Code 2.1.330 is newer than the version tested with Parallax (2.1.322).');
    expect(note.getAttribute('data-slot')).toBe('claude-untested');
    expect(note.className).not.toContain('destructive');
    // The version line stays first (e2e/live reads "Claude Code <v>" from this element).
    expect(info?.textContent.startsWith('Claude Code 2.1.330')).toBe(true);
    expect(info?.getAttribute('data-version-status')).toBe('ok');
  });

  it.each<[string, Partial<ClaudeInstallStatus>]>([
    ['same version (FakeBackend)', { version: '2.1.322', testedVersion: '2.1.322' }],
    ['older than tested', { version: '2.1.300', testedVersion: '2.1.322' }],
    ['no profile', { version: '2.1.330', testedVersion: null }],
    ['unknown version', { version: null, testedVersion: '2.1.322' }],
    ['too old for the SDK', { version: '2.1.330', testedVersion: '2.1.322', versionStatus: 'too_old' }],
  ])('no note: %s', (_name, claude) => {
    renderFacts(claude);
    expect(document.querySelector('[data-slot="claude-untested"]')).toBeNull();
  });
});

describe('newerThanTested', () => {
  it('returns the tested version only when the installed one is newer', () => {
    expect(newerThanTested({ version: '2.1.330', testedVersion: '2.1.322' })).toBe('2.1.322');
    expect(newerThanTested({ version: '2.2.0', testedVersion: '2.1.322' })).toBe('2.1.322');
    expect(newerThanTested({ version: '2.1.322', testedVersion: '2.1.322' })).toBeNull();
    expect(newerThanTested({ version: '2.1.300', testedVersion: '2.1.322' })).toBeNull();
    expect(newerThanTested({ version: ' ', testedVersion: '2.1.322' })).toBeNull();
    expect(newerThanTested({ version: '2.1.330', testedVersion: 'not a version' })).toBeNull();
    expect(newerThanTested({ version: '2.1.330', testedVersion: null })).toBeNull();
  });
});
