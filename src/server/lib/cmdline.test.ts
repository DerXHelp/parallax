import { describe, expect, it } from 'vitest';
import { quoteWindowsArg, windowsCommandLine } from './cmdline';
import { spawnHidden } from './process';

/** [argument, expected quoting] – CommandLineToArgvW rules (MS docs). */
const TABLE: [string, string][] = [
  ['plain', 'plain'],
  ['', '""'],
  ['with space', '"with space"'],
  ['tab\there', '"tab\there"'],
  ['say "hi"', '"say \\"hi\\""'],
  ['"', '"\\""'],
  ['C:\\path\\', 'C:\\path\\'],
  ['C:\\with space\\', '"C:\\with space\\\\"'],
  ['a\\"b', '"a\\\\\\"b"'],
  ['a\\\\"b', '"a\\\\\\\\\\"b"'],
  ['a\\b c', '"a\\b c"'],
  ['--resume', '--resume'],
  ['Ärger über Öl', '"Ärger über Öl"'],
  ['ÄÖÜß', 'ÄÖÜß'],
  ['%PATH%&|^<>', '%PATH%&|^<>'],
  ['line\nbreak', '"line\nbreak"'],
];

describe('windowsCommandLine (CommandLineToArgvW rules)', () => {
  it.each(TABLE)('quotes %j as %s', (arg, quoted) => {
    expect(quoteWindowsArg(arg)).toBe(quoted);
  });

  it('joins the quoted arguments with one space', () => {
    expect(windowsCommandLine(['--resume', 'abc', '--model', 'claude opus', ''])).toBe(
      '--resume abc --model "claude opus" ""',
    );
    expect(windowsCommandLine([])).toBe('');
  });

  it.runIf(process.platform === 'win32')(
    'round trip: a real process splits the line back into exactly the arguments',
    async () => {
      const args = TABLE.map(([arg]) => arg);
      // `node -e <script> -- …`: process.argv = [execPath, …args] (`--` ends node's own options).
      const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
      // Verbatim: our line is the whole command line after "node" (no libuv re-quoting).
      const child = spawnHidden(process.execPath, [windowsCommandLine(['-e', script, '--', ...args])], {
        argv0: 'node',
        windowsVerbatimArguments: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(code).toBe(0);
      expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(args);
    },
    60_000,
  );
});
