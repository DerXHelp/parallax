/**
 * Synthetic stream for the size rules (R0-11): a Write with 60 Ki content (input string capped,
 * full input as blob), a Bash with 100 Ki stdout (text capped, structured deduplicated), a Read
 * (file.content removed from structured), an image tool result (blob) and a tool whose
 * structured result alone exceeds LIMITS.itemStructuredChars.
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { assistant, init, input, lifecycle, result, sequence, state, toolResult, uuid } from './build';

const PROMPT = uuid(900);
const WRITE = 'toolu_syn_write_big';
const BASH = 'toolu_syn_bash_big';
const READ = 'toolu_syn_read';
const SHOT = 'toolu_syn_screenshot';
const MCP = 'toolu_syn_mcp_big';

const bigContent = 'x'.repeat(60 * 1024);
const bigStdout = Array.from({ length: 4000 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'y'.repeat(14)}`).join('\n');
const fileText = 'alpha\nbeta';
/** 1×1 transparent PNG. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Write, run, read, screenshot'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3),
  assistant(4, 'msg_syn_big_1', {
    type: 'tool_use',
    id: WRITE,
    name: 'Write',
    input: { file_path: 'D:\\work\\synthetic\\big.txt', content: bigContent },
  }),
  toolResult(5, WRITE, 'File created successfully at: D:\\work\\synthetic\\big.txt', {
    tool_use_result: { type: 'create', filePath: 'D:\\work\\synthetic\\big.txt', content: bigContent, structuredPatch: [] },
  }),
  assistant(6, 'msg_syn_big_2', { type: 'tool_use', id: BASH, name: 'Bash', input: { command: 'cat big.log' } }),
  toolResult(7, BASH, bigStdout, {
    tool_use_result: { stdout: bigStdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  }),
  assistant(8, 'msg_syn_big_3', { type: 'tool_use', id: READ, name: 'Read', input: { file_path: 'D:\\work\\synthetic\\a.txt' } }),
  toolResult(9, READ, '1\talpha\n2\tbeta', {
    tool_use_result: {
      type: 'text',
      file: { filePath: 'D:\\work\\synthetic\\a.txt', content: fileText, numLines: 2, startLine: 1, totalLines: 2 },
    },
  }),
  assistant(10, 'msg_syn_big_4', { type: 'tool_use', id: SHOT, name: 'mcp__browser__screenshot', input: {} }),
  toolResult(11, SHOT, [
    { type: 'text', text: 'Screenshot taken' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
  ]),
  assistant(12, 'msg_syn_big_5', { type: 'tool_use', id: MCP, name: 'mcp__db__dump', input: { table: 'logs' } }),
  toolResult(13, MCP, 'dumped', { tool_use_result: { rows: Array.from({ length: 3000 }, (_, i) => ({ id: i, v: 'row' })) } }),
  result(14),
  lifecycle(15, PROMPT, 'completed'),
  state(16, 'idle'),
]);
