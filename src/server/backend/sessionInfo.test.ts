import { describe, expect, it } from 'vitest';
import { SESSION_INFO_LIMITS, SESSION_INFO_SECTIONS, sessionInfoSectionSchema } from '@shared/model';
import { exportFileName, sessionInfoFailure, sessionInfoOf } from './sessionInfo';

/** Raw answers in the shapes of claude 2.1.323 (synthetic, no account data). */
const RAW = {
  status: {
    sections: [
      {
        title: 'Session',
        rows: [
          { label: 'Version', value: '2.1.323' },
          { label: 'Session ID', value: 'abc' },
        ],
      },
      { title: 'Environment', rows: [{ value: 'Fast mode: off' }, { label: 'Turns', value: 3 }] },
    ],
  },
  memory: {
    files: [
      {
        kind: 'user',
        path: 'C:\\Users\\u\\.claude\\CLAUDE.md',
        label: 'User memory',
        description: 'd',
        exists: true,
      },
      {
        kind: 'project',
        path: 'D:\\repo\\CLAUDE.md',
        label: 'Project memory',
        description: 'd',
        exists: false,
      },
    ],
    folders: [{ kind: 'auto', path: 'C:\\m', label: 'Auto memory', description: 'notes' }],
    memories: [
      { name: 'a', path: 'C:\\m\\a.md', description: null, type: 'project', modified_ms: 1_700_000_000_000 },
    ],
    auto_memory: { enabled: true, toggleable: true, status: 'On' },
    auto_dream: { shown: false, enabled: false, toggleable: false, status: 'Off', detail: '' },
  },
  skills: {
    skills: [
      {
        name: 'review',
        display_name: 'review',
        description: 'Review',
        source: 'built-in',
        tokens: 120,
        state: 'on',
        advertised: true,
        handles: { unqualified_name: 'review' },
      },
      {
        name: 'p:lint',
        display_name: 'lint',
        description: '',
        source: 'plugin',
        tokens: 60,
        state: 'off',
        locked_by: 'plugin',
      },
    ],
  },
  hooks: {
    events: [{ name: 'PreToolUse', summary: 'Before a tool runs', supportsMatcher: true, hookCount: 1 }],
    hooks: [
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        source: 'userSettings',
        sourceLabel: 'User settings',
        type: 'command',
        displayText: 'node guard.mjs',
        commandText: 'node guard.mjs',
        contentLabel: 'Command',
        timeout: 30,
        runsOnce: true,
        editable: { command: 'node guard.mjs', headers: { Authorization: '' } },
      },
    ],
    eventCatalog: [{ name: 'PreToolUse', summary: 'x', supportsMatcher: true }],
    policy: {
      disabledByPolicy: false,
      managedOnly: false,
      pluginOnly: false,
      allDisabled: false,
      policyHookCount: 0,
    },
    safeMode: { managedHooksStillApply: true, exitHint: 'restart without --safe' },
  },
  permissions: {
    state: {
      rules: [
        {
          behavior: 'allow',
          source: 'userSettings',
          rule: 'Bash(ls:*)',
          editability: 'persistent',
          description: { prefix: 'Run ', emphasis: 'ls' },
        },
        {
          behavior: 'deny',
          source: 'policySettings',
          rule: 'Read(.env)',
          editability: 'readonly',
          notInEffect: true,
        },
      ],
      workspaceDirectories: [{ path: 'D:\\repo', source: 'cwd' }],
      originalCwd: 'D:\\repo',
      managedOnly: false,
    },
  },
  mcp: [
    {
      name: 'docs',
      status: 'connected',
      scope: 'user',
      config: { type: 'stdio', command: 'secret.exe' },
      serverInfo: { name: 'docs', version: '1.0' },
      tools: [{ name: 'search', description: 'x' }],
    },
    { name: 'broken', status: 'failed', error: 'spawn ENOENT' },
  ],
  export: { text: '> hello\n\n⏺ hi', default_filename: '2026-11-13-101500-hello.txt' },
} as const;

describe('sessionInfoOf', () => {
  it('parses every section of the CLI shapes into a contract-valid display form', () => {
    for (const section of SESSION_INFO_SECTIONS) {
      const parsed = sessionInfoOf(section, RAW[section]);
      expect(parsed.data?.section).toBe(section);
      expect(sessionInfoSectionSchema.safeParse(parsed.data).success).toBe(true);
    }
  });

  it('status: rows without a label, numbers as text, invalid rows dropped and counted', () => {
    const parsed = sessionInfoOf('status', {
      sections: [
        {
          title: 'S',
          rows: [{ value: 'plain' }, { label: 'N', value: 3 }, { label: 'X', value: { deep: 1 } }],
        },
      ],
    });
    expect(parsed.data).toEqual({
      section: 'status',
      groups: [
        {
          title: 'S',
          rows: [
            { label: null, value: 'plain' },
            { label: 'N', value: '3' },
          ],
        },
      ],
      extra: [],
    });
    expect(parsed.unknown).toEqual(['status.rows:invalid']);
  });

  it('unknown fields: counted as keys (never values); unknown scalar top-level fields become extra rows', () => {
    const parsed = sessionInfoOf('skills', {
      skills: [{ name: 'a', state: 'on', newField: 'secret' }],
      hint: 'Use /skills',
      nested: { a: 1 },
    });
    expect(parsed.data).toMatchObject({ extra: [{ label: 'hint', value: 'Use /skills' }] });
    expect(parsed.unknown).toEqual(['skills.skills:newField', 'skills:hint', 'skills:nested']);
    expect(JSON.stringify(parsed.unknown)).not.toContain('secret');
  });

  it('memory: a kind of a newer CLI shows as "other"; times as ISO', () => {
    const parsed = sessionInfoOf('memory', {
      files: [{ kind: 'org', path: 'X:\\org.md' }],
      memories: [
        { path: 'C:\\m\\b.md', modified_ms: 0 },
        { path: 'C:\\m\\c.md', modified_ms: -1 },
      ],
    });
    expect(parsed.data).toMatchObject({
      files: [{ kind: 'other', path: 'X:\\org.md', label: 'X:\\org.md', exists: true }],
      memories: [
        { name: 'C:\\m\\b.md', modifiedAt: '1970-01-01T00:00:00.000Z' },
        { name: 'C:\\m\\c.md', modifiedAt: null },
      ],
      autoMemory: null,
      autoDream: null,
    });
    expect(parsed.unknown).toEqual(['memory.files.kind:org']);
  });

  it('skills: known extra fields stay unseen, bad tokens become null, locks pass through', () => {
    const parsed = sessionInfoOf('skills', {
      skills: [...RAW.skills.skills, { name: 'n', tokens: -5 }, { display_name: 'no name' }],
    });
    expect(parsed.data).toMatchObject({
      skills: [
        { name: 'review', tokens: 120, lockedBy: null },
        { name: 'p:lint', lockedBy: 'plugin', state: 'off' },
        { name: 'n', displayName: 'n', tokens: null, state: '' },
      ],
    });
    expect(parsed.unknown).toEqual(['skills.skills:invalid']);
  });

  it('hooks: the edit entry is never passed on, flags and policy/safe mode are mapped', () => {
    const parsed = sessionInfoOf('hooks', RAW.hooks);
    expect(JSON.stringify(parsed.data)).not.toContain('Authorization');
    expect(parsed.data).toMatchObject({
      events: [{ name: 'PreToolUse', matcherSupported: true, count: 1 }],
      hooks: [
        {
          matcher: 'Bash',
          command: 'node guard.mjs',
          timeoutSec: 30,
          once: true,
          background: false,
          disabled: false,
        },
      ],
      policy: { managedOnly: false, policyHookCount: 0, policyUnreadable: false },
      safeMode: { managedHooksStillApply: true },
      bareMode: null,
      errors: [],
    });
    expect(parsed.unknown).toEqual([]);
  });

  it('permissions: the wire answer and the bare state; descriptions and settings errors', () => {
    const wrapped = sessionInfoOf('permissions', RAW.permissions);
    const bare = sessionInfoOf('permissions', {
      ...RAW.permissions.state,
      errors: [{ path: 'C:\\s.json', message: 'bad JSON' }],
    });
    expect(wrapped.data).toMatchObject({
      rules: [
        { behavior: 'allow', description: { prefix: 'Run ', emphasis: 'ls', suffix: null } },
        { behavior: 'deny', notInEffect: true, description: null },
      ],
      directories: [{ path: 'D:\\repo', source: 'cwd' }],
      cwd: 'D:\\repo',
    });
    expect(bare.data).toMatchObject({ errors: [{ file: null, path: 'C:\\s.json', message: 'bad JSON' }] });
  });

  it('mcp: plain list or the wire answer; only the transport of the config, never its command', () => {
    const plain = sessionInfoOf('mcp', RAW.mcp);
    const wire = sessionInfoOf('mcp', { mcpServers: RAW.mcp });
    expect(plain.data).toEqual(wire.data);
    expect(plain.data).toMatchObject({
      servers: [
        {
          name: 'docs',
          status: 'connected',
          transport: 'stdio',
          serverVersion: 'docs 1.0',
          tools: ['search'],
          error: null,
        },
        { name: 'broken', status: 'failed', error: 'spawn ENOENT', transport: null, tools: [] },
      ],
    });
    expect(JSON.stringify(plain.data)).not.toContain('secret.exe');
  });

  it('export: text cut to the limit with the total length, a safe file name', () => {
    const long = 'x'.repeat(SESSION_INFO_LIMITS.exportChars + 5);
    expect(sessionInfoOf('export', { text: long, default_filename: 'a.txt' }).data).toMatchObject({
      totalChars: SESSION_INFO_LIMITS.exportChars + 5,
      truncated: true,
      filename: 'a.txt',
    });
    expect(sessionInfoOf('export', RAW.export).data).toMatchObject({
      truncated: false,
      totalChars: RAW.export.text.length,
    });
  });

  it('lists are cut to the list cap (truncated)', () => {
    const skills = Array.from({ length: SESSION_INFO_LIMITS.listMax + 3 }, (_, i) => ({
      name: `s${String(i)}`,
    }));
    const parsed = sessionInfoOf('skills', { skills });
    expect(parsed.data).toMatchObject({ truncated: true });
    expect(parsed.data?.section === 'skills' ? parsed.data.skills.length : 0).toBe(
      SESSION_INFO_LIMITS.listMax,
    );
  });

  it('an unknown shape is null (the tab says "not available")', () => {
    for (const section of SESSION_INFO_SECTIONS) {
      expect(sessionInfoOf(section, 'nope').data).toBeNull();
      expect(sessionInfoOf(section, { other: 1 }).data).toBeNull();
    }
  });
});

describe('exportFileName', () => {
  it('removes characters Windows forbids and keeps .txt', () => {
    expect(exportFileName('2026-11-13 10:15 fix "login"?.txt')).toBe('2026-11-13 10-15 fix -login--.txt');
    expect(exportFileName('a\u0001b/c\\d')).toBe('a-b-c-d.txt');
  });

  it('reserved names, trailing dots, empty names and long names', () => {
    expect(exportFileName('con')).toBe('_con.txt');
    expect(exportFileName('LPT1.txt')).toBe('_LPT1.txt');
    expect(exportFileName('name... ')).toBe('name.txt');
    expect(exportFileName('')).toBe('claude-conversation.txt');
    expect(exportFileName(undefined)).toBe('claude-conversation.txt');
    expect(exportFileName('x'.repeat(500)).length).toBe(SESSION_INFO_LIMITS.fileNameChars);
  });
});

describe('sessionInfoFailure', () => {
  it('an older or restricted CLI is "unavailable", anything else "failed"', () => {
    expect(sessionInfoFailure(new Error('Unsupported control request subtype: get_status'))).toBe(
      'unavailable',
    );
    expect(sessionInfoFailure(new Error('get_status is not available in this build'))).toBe('unavailable');
    expect(sessionInfoFailure(new Error('get_memory_dialog is not available on this connection'))).toBe(
      'unavailable',
    );
    expect(sessionInfoFailure(new Error('get_status is not available in a cloud-hosted session'))).toBe(
      'unavailable',
    );
    expect(sessionInfoFailure(new Error('Request timed out'))).toBe('failed');
    expect(sessionInfoFailure('boom')).toBe('failed');
  });
});
