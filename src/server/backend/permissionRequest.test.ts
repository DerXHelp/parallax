import { describe, expect, it } from 'vitest';
import { fixtureCanUseToolPayloadSchema } from './fixture';
import { loadAllFixtures } from '../sessions/normalizer/testing/harness';
import { toPermissionRequest } from './permissionRequest';

const fixtures = await loadAllFixtures();
const payloads = [...fixtures].flatMap(([name, fixture]) =>
  fixture.events
    .filter((e) => e.kind === 'canUseTool')
    .map((e) => ({
      name: `${name}#${String(e.seq)}`,
      payload: fixtureCanUseToolPayloadSchema.parse(e.payload),
    })),
);

describe('toPermissionRequest – every recorded canUseTool payload', () => {
  it('covers the recorded payloads', () => {
    expect(payloads.length).toBeGreaterThanOrEqual(15);
  });

  it.each(payloads)('$name', ({ payload }) => {
    const options = payload.options;
    const req = toPermissionRequest(payload.toolName, payload.input, {
      ...options,
      signal: new AbortController().signal,
    });
    expect(req.toolName).toBe(payload.toolName);
    expect(req.input).toBe(payload.input);
    expect(req.toolUseId).toBe(options.toolUseID);
    expect(req.requestId).toBe(options.requestId);
    expect(req.agentId).toBe(options.agentID ?? null);
    // Every recorded suggestion is a valid PermissionUpdate (nothing dropped).
    expect(req.suggestions).toEqual(options.suggestions ?? []);
    expect(req.blockedPath).toBe(options.blockedPath ?? null);
    expect(req.decisionReason).toBe(options.decisionReason ?? null);
    expect(req.decisionReasonType).toBe(options.decisionReasonType ?? null);
    expect(req.title).toBe(options.title ?? null);
    expect(req.displayName).toBe(options.displayName ?? null);
    expect(req.description).toBe(options.description ?? null);
    expect(req.defaultToNo).toBe(options.defaultToNo === true);
    expect(req.suppressAlwaysAllowRule).toBe(options.suppressAlwaysAllowRule === true);
    expect(req.requiresUserInteraction).toBe(options.requiresUserInteraction === true);
    expect(req.mcpServer).toBeNull();
    // raw = all option keys except signal.
    expect(req.raw).toEqual(options);
    expect(Object.keys(req.raw)).not.toContain('signal');
  });

  it('takes over the untyped keys seen in the recordings', () => {
    const all = payloads.map(({ payload }) =>
      toPermissionRequest(payload.toolName, payload.input, payload.options),
    );
    expect(all.some((r) => r.decisionReasonType !== null)).toBe(true);
    expect(
      all
        .filter((r) => r.toolName === 'AskUserQuestion' || r.toolName === 'ExitPlanMode')
        .every((r) => r.requiresUserInteraction),
    ).toBe(true);
  });
});

describe('toPermissionRequest – tolerance', () => {
  it('drops invalid suggestions, keeps valid ones', () => {
    const req = toPermissionRequest(
      'Bash',
      { command: 'ls' },
      {
        toolUseID: 'toolu_1',
        requestId: 'req_1',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
            behavior: 'allow',
            destination: 'session',
          },
          { type: 'addRules', rules: 'nope', behavior: 'allow', destination: 'session' },
          { type: 'setMode', mode: 'turbo', destination: 'session' },
          { type: 'teleport' },
          { type: 'addDirectories', directories: ['D:\\work'], destination: 'localSettings', extra: 1 },
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        ],
      },
    );
    expect(req.suggestions).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
        behavior: 'allow',
        destination: 'session',
      },
      { type: 'addDirectories', directories: ['D:\\work'], destination: 'localSettings' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]);
  });

  it('never throws: non-object options, wrong types and missing ids', () => {
    for (const options of [
      undefined,
      null,
      'x',
      42,
      [],
      { suggestions: 'no', defaultToNo: 'yes', title: 7, mcpServer: 'x' },
    ]) {
      const req = toPermissionRequest('Write', {}, options);
      expect(req.toolUseId).toBe('');
      expect(req.requestId).toBe('');
      expect(req.suggestions).toEqual([]);
      expect(req.defaultToNo).toBe(false);
      expect(req.title).toBeNull();
      expect(req.mcpServer).toBeNull();
    }
  });

  it('maps all typed and untyped option keys', () => {
    const signal = new AbortController().signal;
    const req = toPermissionRequest(
      'mcp__github__create_issue',
      { title: 'x' },
      {
        signal,
        toolUseID: 'toolu_2',
        requestId: 'req_2',
        agentID: 'agent_7',
        blockedPath: 'D:\\outside',
        decisionReason: 'This command requires approval',
        decisionReasonType: 'other',
        title: 'Claude wants to create an issue',
        displayName: 'create_issue',
        description: 'Create an issue',
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
        requiresUserInteraction: true,
        mcpServer: { name: 'github', source: 'user' },
        matchedAskRule: 'mcp__github',
      },
    );
    expect(req).toEqual({
      toolName: 'mcp__github__create_issue',
      input: { title: 'x' },
      toolUseId: 'toolu_2',
      requestId: 'req_2',
      agentId: 'agent_7',
      suggestions: [],
      blockedPath: 'D:\\outside',
      decisionReason: 'This command requires approval',
      decisionReasonType: 'other',
      title: 'Claude wants to create an issue',
      displayName: 'create_issue',
      description: 'Create an issue',
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
      requiresUserInteraction: true,
      mcpServer: { name: 'github', source: 'user' },
      raw: {
        toolUseID: 'toolu_2',
        requestId: 'req_2',
        agentID: 'agent_7',
        blockedPath: 'D:\\outside',
        decisionReason: 'This command requires approval',
        decisionReasonType: 'other',
        title: 'Claude wants to create an issue',
        displayName: 'create_issue',
        description: 'Create an issue',
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
        requiresUserInteraction: true,
        mcpServer: { name: 'github', source: 'user' },
        matchedAskRule: 'mcp__github',
      },
    });
  });
});
