import { describe, expect, it } from 'vitest';
import { cliProfileSchema } from '../../src/server/claude/cliProfile';
import { observationFrom, profileFromObservation, profileJson, sortedUnique } from './observation';
import { sampleObservation } from './samples';

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: '11111111-2222-3333-4444-555555555555',
  cwd: 'C:\\Users\\user\\AppData\\Local\\Temp\\parallax-cli-check-x\\work',
  model: 'claude-haiku-5-5',
  permissionMode: 'default',
  output_style: 'default',
  apiKeySource: 'none',
  claude_code_version: '2.1.322',
  tools: ['Write', 'Bash', 'mcp__claude_ai_Docs__read', 'AskUserQuestion', 'Bash', 42],
  slash_commands: ['compact', 'clear'],
  agents: ['general-purpose', 'Explore'],
  skills: ['simplify'],
  capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1'],
  brand_new_field: { nested: true },
};

describe('observationFrom (WP-62)', () => {
  it('extracts sorted lists, drops mcp__ tools, keeps only keys of initializationResult', () => {
    const observation = observationFrom(
      {
        init: INIT,
        initializationResult: { pid: 4711, account: { email: 'user@example.com', organization: 'Org' }, models: [] },
        supportedModels: [{ value: 'sonnet' }, { value: 'haiku' }, { value: 'haiku' }],
        contextUsage: {
          categories: [{ id: 'system_prompt' }, { name: 'no id' }, { id: 'messages' }],
          deferredBuiltinTools: [{ name: 'Monitor', tokens: 1, isLoaded: false }, { name: 'mcp__x__y', tokens: 1, isLoaded: false }],
        },
      },
      '0.3.322',
    );
    expect(observation).toEqual({
      cliVersion: '2.1.322',
      sdkVersion: '0.3.322',
      model: 'claude-haiku-5-5',
      permissionMode: 'default',
      outputStyle: 'default',
      initKeys: sortedUnique(Object.keys(INIT)),
      tools: ['AskUserQuestion', 'Bash', 'Write'],
      deferredTools: ['Monitor'],
      capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'],
      initializationKeys: ['account', 'models', 'pid'],
      models: ['haiku', 'sonnet'],
      contextCategories: ['messages', 'system_prompt'],
      slashCommands: ['clear', 'compact'],
      agents: ['Explore', 'general-purpose'],
      skills: ['simplify'],
      // WP-64/WP-65: not checked in this raw probe.
      remoteControl: null,
      sessionTitle: null,
      usageQuery: null,
      backgroundTasks: null,
    });
    expect(JSON.stringify(observation)).not.toContain('example.com');
  });

  it('without deferredBuiltinTools (summary answer) the deferred list is null; missing init throws', () => {
    const observation = observationFrom(
      { init: INIT, initializationResult: null, supportedModels: null, contextUsage: { categories: [] } },
      '0.3.322',
    );
    expect(observation.deferredTools).toBeNull();
    expect(observation.models).toEqual([]);
    expect(observation.initializationKeys).toEqual([]);
    expect(() =>
      observationFrom({ init: { type: 'assistant' }, initializationResult: null, supportedModels: null, contextUsage: null }, 'x'),
    ).toThrow('system/init');
  });
});

describe('profile file', () => {
  it('profileFromObservation + profileJson: schema order, one item per line, valid again', () => {
    const profile = profileFromObservation(sampleObservation(), new Date('2026-11-12T15:02:00.000Z'));
    const text = profileJson(profile);
    expect(text.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(Object.keys(cliProfileSchema.shape));
    expect(text).toContain('  "tools": [\n    "AskUserQuestion",\n    "Bash",');
    expect(cliProfileSchema.parse(JSON.parse(text))).toEqual(profile);
    expect(profile.checkedAt).toBe('2026-11-12T15:02:00.000Z');
  });
});
