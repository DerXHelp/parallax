import { describe, expect, it } from 'vitest';
import type { ToolCallItem } from '@shared/model';
import { sampleItems, sampleTime } from '@shared/samples';
import { isPlanFilePath, liveWriteContent, planFileActivity, planToolPath } from './plan-file';

const PLAN = 'C:\\Users\\user\\.claude\\plans\\json-registry.md';

function call(order: number, p: Partial<ToolCallItem>): ToolCallItem {
  return sampleItems.toolCall({
    id: `msg_${String(order)}:0`,
    messageId: `msg_${String(order)}`,
    order,
    toolUseId: `toolu_${String(order)}`,
    toolName: 'Write',
    input: { file_path: PLAN, content: '# Plan' },
    status: 'done',
    parentToolUseId: null,
    ...p,
  });
}

function done(at: string): NonNullable<ToolCallItem['result']> {
  return {
    isError: false,
    content: [{ type: 'text', text: { text: 'OK', truncated: null } }],
    structured: null,
    structuredTruncated: null,
    at,
  };
}

describe('plan file rule (ADR-148)', () => {
  it('reads the path of Write/Edit/MultiEdit – from the partial input once file_path is complete', () => {
    expect(planToolPath({ toolName: 'Write', input: { file_path: PLAN }, inputPartial: null })).toBe(PLAN);
    expect(planToolPath({ toolName: 'Edit', input: { file_path: PLAN }, inputPartial: null })).toBe(PLAN);
    expect(planToolPath({ toolName: 'Read', input: { file_path: PLAN }, inputPartial: null })).toBeNull();
    expect(planToolPath({ toolName: 'Write', input: {}, inputPartial: '{"file_path":"C:\\\\Us' })).toBeNull();
    expect(
      planToolPath({
        toolName: 'Write',
        input: {},
        inputPartial: JSON.stringify({ file_path: PLAN }).slice(0, -1),
      }),
    ).toBe(PLAN);
    // Git Bash paths are converted; UNC/device paths fail the C.10 filter.
    expect(
      planToolPath({ toolName: 'Write', input: { file_path: '/c/plans/a.md' }, inputPartial: null }),
    ).toBe('C:\\plans\\a.md');
    expect(
      planToolPath({
        toolName: 'Write',
        input: { file_path: '\\\\server\\share\\a.md' },
        inputPartial: null,
      }),
    ).toBeNull();
  });

  it('matches the known plan file case-insensitively, any .md only in plan mode', () => {
    const rule = { planPath: PLAN, planMode: false };
    expect(isPlanFilePath(PLAN.toUpperCase(), rule)).toBe(true);
    expect(isPlanFilePath('D:\\work\\README.md', rule)).toBe(false);
    expect(isPlanFilePath('D:\\work\\README.md', { planPath: null, planMode: true })).toBe(true);
    expect(isPlanFilePath('D:\\work\\main.ts', { planPath: null, planMode: true })).toBe(false);
  });
});

describe('planFileActivity', () => {
  const rule = { planPath: PLAN, planMode: false };

  it('reports a running Write as live and the newest finished write time', () => {
    const items = [
      call(1, { result: done(sampleTime(10)) }),
      call(2, { toolName: 'Edit', result: done(sampleTime(20)) }),
      call(3, {
        status: 'streaming_input',
        input: {},
        inputPartial: `{"file_path":${JSON.stringify(PLAN)},"con`,
      }),
    ];
    expect(planFileActivity(items, rule)).toEqual({
      liveItemId: 'msg_3:0',
      path: PLAN,
      writtenAt: Date.parse(sampleTime(20)),
    });
    // Cached per items array and rule.
    expect(planFileActivity(items, rule)).toBe(planFileActivity(items, rule));
  });

  it('ignores subagents, other files, failed writes; a running Edit is not live', () => {
    const items = [
      call(1, { parentToolUseId: 'toolu_agent', status: 'running', result: null }),
      call(2, { input: { file_path: 'D:\\work\\notes.md', content: 'x' }, status: 'running', result: null }),
      call(3, { result: { ...done(sampleTime(5)), isError: true } }),
      call(4, { toolName: 'Edit', status: 'running', result: null }),
    ];
    expect(planFileActivity(items, rule)).toEqual({ liveItemId: null, path: PLAN, writtenAt: null });
    expect(planFileActivity([], rule)).toEqual({ liveItemId: null, path: null, writtenAt: null });
  });

  it('in plan mode a Write on any .md file is the plan file (before the engine reports planFile)', () => {
    const draft = 'C:\\Users\\user\\.claude\\plans\\draft.md';
    const items = [call(1, { input: { file_path: draft, content: '#' }, status: 'pending', result: null })];
    expect(planFileActivity(items, { planPath: null, planMode: true })).toEqual({
      liveItemId: 'msg_1:0',
      path: draft,
      writtenAt: null,
    });
    expect(planFileActivity(items, { planPath: null, planMode: false }).path).toBeNull();
  });
});

describe('liveWriteContent', () => {
  it('decodes the streamed content, then takes the final input', () => {
    expect(liveWriteContent({ input: {}, inputPartial: '' })).toBe('');
    expect(
      liveWriteContent({ input: {}, inputPartial: '{"file_path":"C:\\\\a.md","content":"# P\\nx' }),
    ).toBe('# P\nx');
    expect(liveWriteContent({ input: { content: '# Final' }, inputPartial: null })).toBe('# Final');
    expect(liveWriteContent({ input: null, inputPartial: null })).toBe('');
  });
});
