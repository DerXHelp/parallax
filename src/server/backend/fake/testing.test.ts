import { describe, expect, it } from 'vitest';
import { normalizeContextUsage } from '../../sessions/normalizer';
import { toPermissionRequest } from '../permissionRequest';
import { FAKE_MODELS, fakeContextUsage, resolveFakeModel } from './defaults';
import { fixtureDecisionResponder, loadFixtureScenario, recordedPrompts, recordedResult } from './testing';

describe('fake testing helpers', () => {
  it('fixtureDecisionResponder answers the recorded decision per toolUseID (copies)', async () => {
    const parsed = await loadFixtureScenario('permissions');
    const responder = fixtureDecisionResponder(parsed);
    const signal = new AbortController().signal;
    const allow = await responder(
      toPermissionRequest('Bash', {}, { toolUseID: 'toolu_01TFCa1bkp5TtrSeYxbDMKWU', requestId: 'r' }),
      signal,
    );
    expect(allow).toMatchObject({
      behavior: 'allow',
      decisionClassification: 'user_permanent',
      updatedPermissions: [{ type: 'addRules', destination: 'session' }],
    });
    const deny = await responder(
      toPermissionRequest('Bash', {}, { toolUseID: 'toolu_01QGg8JT4H4khkjVKDncyDFD', requestId: 'r' }),
      signal,
    );
    expect(deny).toEqual({
      behavior: 'deny',
      message: 'Stopped by the user.',
      interrupt: true,
      decisionClassification: 'user_reject',
    });
    await expect(
      responder(toPermissionRequest('Bash', {}, { toolUseID: 'nope', requestId: 'r' }), signal),
    ).resolves.toMatchObject({
      behavior: 'deny',
    });
  });

  it('recordedResult tolerates odd classifications and drops invalid updates', () => {
    expect(
      recordedResult({
        behavior: 'allow',
        decisionClassification: 'weird',
        updatedPermissions: [{ type: 'x' }],
      }),
    ).toEqual({
      behavior: 'allow',
      updatedPermissions: [],
    });
    expect(recordedResult('x')).toBeNull();
  });

  it('recordedPrompts: text and priority of every input event, fresh uuids', async () => {
    const parsed = await loadFixtureScenario('queue-priority');
    let n = 0;
    const prompts = recordedPrompts(parsed.events, () => `uuid-${String((n += 1))}`);
    expect(prompts.map((p) => p.priority)).toEqual(['next', 'next', 'next', 'now']);
    expect(prompts[3]).toEqual({
      uuid: 'uuid-4',
      content: [{ type: 'text', text: 'Reply with exactly: NOW' }],
      priority: 'now',
    });
  });
});

describe('fake defaults', () => {
  it('getContextUsage grows per turn and normalizes', () => {
    const at = new Date('2026-10-15T08:00:00.000Z');
    const zero = normalizeContextUsage(fakeContextUsage(0), { contextWindow: null }, at, 'summary');
    const three = normalizeContextUsage(fakeContextUsage(3), { contextWindow: null }, at, 'summary');
    expect(zero).toMatchObject({ totalTokens: 20_000, maxTokens: 200_000, percentage: 10, source: 'sdk' });
    expect(three?.totalTokens).toBe(24_500);
    expect(three?.categories.map((c) => c.kind)).toEqual(['used', 'used', 'used', 'buffer', 'free']);
  });

  it('models like auth-probe#24; aliases resolve to full ids', () => {
    expect(FAKE_MODELS.map((m) => m.value)).toEqual([
      'default',
      'opus',
      'claude-fable-5-1[1m]',
      'sonnet',
      'haiku',
    ]);
    expect(resolveFakeModel(null)).toBe('claude-haiku-5-5');
    expect(resolveFakeModel('sonnet')).toBe('claude-sonnet-5-5');
    expect(resolveFakeModel('claude-x')).toBe('claude-x');
  });
});
