import { describe, expect, it } from 'vitest';
import { terminalIdSchema as commonTerminalIdSchema } from './common';
import { SAMPLE_IDS, SAMPLE_TIME } from './samples';
import { TERMINAL_COMMANDS, terminalIdSchema, terminalInfoSchema } from './terminal';

const info = {
  terminalId: `tm_${'c'.repeat(32)}`,
  entryId: SAMPLE_IDS.entry,
  shell: 'bash',
  cwd: '/home/demo/project',
  createdAt: SAMPLE_TIME,
  cols: 80,
  rows: 24,
  state: 'running',
  exitCode: null,
  title: null,
} as const;

describe('terminal contracts (102e)', () => {
  it('re-exports the terminal id of common', () => {
    expect(terminalIdSchema).toBe(commonTerminalIdSchema);
    expect(terminalIdSchema.safeParse(info.terminalId).success).toBe(true);
    expect(terminalIdSchema.safeParse('tm_1').success).toBe(false);
  });

  it('TerminalInfo.command: shell by default, claude for "Continue in terminal"', () => {
    expect(TERMINAL_COMMANDS).toEqual(['shell', 'claude', 'script']);
    expect(terminalInfoSchema.parse(info).command).toBe('shell');
    expect(terminalInfoSchema.parse({ ...info, command: 'claude' }).command).toBe('claude');
    expect(terminalInfoSchema.safeParse({ ...info, command: 'vim' }).success).toBe(false);
  });
});
