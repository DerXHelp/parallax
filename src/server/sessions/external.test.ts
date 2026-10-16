/**
 * WP-34 – pure helpers of the external console (ADR-104) and the attachment content (ADR-103):
 * the recorded console process, the scrubbing of launcher failure reasons (profile secrets never
 * reach a log or an error) and the order of the outgoing content blocks.
 */
import { describe, expect, it } from 'vitest';
import { sampleExternalHandoff, sampleTime } from '@shared/samples';
import type { ConsoleLaunchSpec } from '../claude/ports';
import { REDACTED } from '../lib/logger';
import { NO_ATTACHMENTS, promptContent } from './attachments';
import { CONSOLE_REASON_CHARS, consoleProcessOf, scrubConsoleReason } from './external';

function spec(p: Partial<ConsoleLaunchSpec> = {}): ConsoleLaunchSpec {
  return {
    executablePath: 'C:\\fake\\claude.exe',
    args: ['--resume', 'x'],
    env: {},
    explicitEnv: {},
    cwd: 'D:\\work',
    ...p,
  };
}

describe('consoleProcessOf', () => {
  it('pid and start time of the handoff; an unparsable time counts as unknown', () => {
    expect(consoleProcessOf(sampleExternalHandoff())).toEqual({
      pid: 52_000,
      startedAt: new Date(sampleTime(120)),
    });
    expect(consoleProcessOf(sampleExternalHandoff({ pid: null, processStartedAt: null }))).toEqual({
      pid: null,
      startedAt: null,
    });
    expect(consoleProcessOf(sampleExternalHandoff({ processStartedAt: 'not a time' })).startedAt).toBeNull();
  });
});

describe('scrubConsoleReason (secrets of the console env)', () => {
  it('replaces every explicit env value and every secret-named env value, longest first', () => {
    const s = spec({
      explicitEnv: { MY_API_KEY: 'abcd-1234-secret', SHORT: 'ab', CLAUDE_CONFIG_DIR: 'D:\\cfg' },
      env: { GITHUB_TOKEN: 'ghp_inheritedtoken', PATH: 'C:\\Windows', PARALLAX: '1' },
    });
    const reason =
      'failed: abcd-1234-secret / abcd-1234-secret-and-more / ghp_inheritedtoken in D:\\cfg (ab) C:\\Windows';
    expect(scrubConsoleReason(reason, s)).toBe(
      `failed: ${REDACTED} / ${REDACTED}-and-more / ${REDACTED} in ${REDACTED} (ab) C:\\Windows`,
    );
  });

  it('without a spec only the generic redaction; empty → "failed"; capped', () => {
    expect(scrubConsoleReason('exit 3: blocked', null)).toBe('exit 3: blocked');
    expect(scrubConsoleReason('   ', null)).toBe('failed');
    expect(scrubConsoleReason('x'.repeat(500), null)).toHaveLength(CONSOLE_REASON_CHARS);
    expect(scrubConsoleReason('API_TOKEN=abc123 rejected', null)).not.toContain('abc123');
  });
});

describe('promptContent (ADR-103)', () => {
  it('images first, then the text; an empty or blank text is left out', () => {
    const image = { type: 'image', mediaType: 'image/png', base64: 'AAAA' } as const;
    const attachments = { refs: [], images: [image, image] };
    expect(promptContent('look', attachments)).toEqual([image, image, { type: 'text', text: 'look' }]);
    expect(promptContent(' \n ', attachments)).toEqual([image, image]);
    expect(promptContent('  keep spaces ', NO_ATTACHMENTS)).toEqual([
      { type: 'text', text: '  keep spaces ' },
    ]);
  });
});
