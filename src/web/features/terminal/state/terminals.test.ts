import { describe, expect, it } from 'vitest';
import { sampleTerminalId, sampleTerminalInfo } from '../testing';
import { assignNumbers, pickActive } from './terminals';

const one = sampleTerminalInfo({ terminalId: sampleTerminalId(1), shell: 'cmd' });
const two = sampleTerminalInfo({ terminalId: sampleTerminalId(2), shell: 'powershell' });
const three = sampleTerminalInfo({ terminalId: sampleTerminalId(3), shell: 'cmd' });

describe('terminal store helpers (WP-99b)', () => {
  it('keeps the active terminal, else takes its neighbour, else the first', () => {
    expect(pickActive([one, two, three], [one, two, three], two.terminalId)).toBe(two.terminalId);
    // The active one was closed: the one now at its position, at the end the new last one.
    expect(pickActive([one, two, three], [one, three], two.terminalId)).toBe(three.terminalId);
    expect(pickActive([one, two, three], [one, two], three.terminalId)).toBe(two.terminalId);
    // Nothing chosen yet, or a stale id of an earlier panel: the first.
    expect(pickActive([], [two, three], null)).toBe(two.terminalId);
    expect(pickActive([], [two, three], sampleTerminalId(9))).toBe(two.terminalId);
    expect(pickActive([one], [], one.terminalId)).toBeNull();
  });

  it('numbers tabs per shell and keeps a number while its terminal exists', () => {
    const first = assignNumbers({}, [one, two, three]);
    expect(first).toEqual({ [one.terminalId]: 1, [two.terminalId]: 1, [three.terminalId]: 2 });
    // Closing "cmd 1" does not rename "cmd 2" …
    const afterClose = assignNumbers(first, [two, three]);
    expect(afterClose).toEqual({ [two.terminalId]: 1, [three.terminalId]: 2 });
    // … and the next cmd takes the free number 1.
    const four = sampleTerminalInfo({ terminalId: sampleTerminalId(4), shell: 'cmd' });
    expect(assignNumbers(afterClose, [two, three, four])[four.terminalId]).toBe(1);
  });
});
