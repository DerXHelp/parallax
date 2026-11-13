/**
 * WP-67 §1.4: the session-info step of `pnpm cli-check` with a fake Query handle – never live. Raw
 * answers in the shapes of claude 2.1.323 (synthetic, the status rows carry a fake account line that
 * must never reach the result, the report or the profile); the actions are only checked for existence.
 */
import { describe, expect, it } from 'vitest';
import { parseCliProfile } from '../../src/server/claude/cliProfile';
import { compareObservation, sessionInfoFindings } from './compare';
import { observationFrom } from './observation';
import { evaluate, formatReport, runRecordSchema } from './report';
import { sampleObservation, sampleProfile, sampleRecord } from './samples';
import { probeSessionInfo, sessionInfoProfile, type SessionInfoProbeHandle } from './sessionInfo';

const ACCOUNT_LINE = 'someone@example.com';

const ANSWERS = {
  getStatus: { sections: [{ title: 'Account', rows: [{ label: 'Email', value: ACCOUNT_LINE }] }] },
  getMemoryDialog: {
    files: [{ kind: 'user', path: 'C:\\Users\\someone\\.claude\\CLAUDE.md', exists: true }],
  },
  getSkillsDialog: { skills: [{ name: 'review', state: 'on', tokens: 10, brandNew: true }] },
  getHooksListing: { hooks: [] },
  listPermissionRules: { state: { rules: [{ behavior: 'allow', rule: 'Bash(ls:*)' }] } },
  mcpServerStatus: [],
  exportConversation: { text: '> Reply with exactly: OK', default_filename: 'x.txt' },
};

type Method = keyof typeof ANSWERS;

function handle(override: Partial<Record<Method, unknown>> = {}, actions = true) {
  const calls: string[] = [];
  const read = (method: Method) => () => {
    calls.push(method);
    const answer = method in override ? override[method] : ANSWERS[method];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  const action = (name: string) => () => {
    calls.push(name);
    return Promise.resolve();
  };
  const h: SessionInfoProbeHandle & { calls: string[] } = {
    calls,
    getStatus: read('getStatus'),
    getMemoryDialog: read('getMemoryDialog'),
    getSkillsDialog: read('getSkillsDialog'),
    getHooksListing: read('getHooksListing'),
    listPermissionRules: read('listPermissionRules'),
    mcpServerStatus: read('mcpServerStatus'),
    exportConversation: read('exportConversation'),
    ...(actions
      ? {
          reconnectMcpServer: action('reconnectMcpServer'),
          toggleMcpServer: action('toggleMcpServer'),
          reloadSkills: action('reloadSkills'),
          reloadPlugins: action('reloadPlugins'),
        }
      : {}),
  };
  return h;
}

describe('probeSessionInfo', () => {
  it('each read method once, in tab order; actions never called; counts and unknown keys only', async () => {
    const h = handle();
    const lines: string[] = [];
    const result = await probeSessionInfo(h, { timeoutMs: 1000, log: (l) => lines.push(l) });
    expect(h.calls).toEqual([
      'getStatus',
      'getMemoryDialog',
      'getSkillsDialog',
      'getHooksListing',
      'listPermissionRules',
      'mcpServerStatus',
      'exportConversation',
    ]);
    expect(result.sections.map((s) => [s.section, s.available, s.rows])).toEqual([
      ['status', true, 1],
      ['memory', true, 1],
      ['skills', true, 1],
      ['hooks', true, 0],
      ['permissions', true, 1],
      ['mcp', true, 0],
      ['export', true, null],
    ]);
    expect(result.sections.find((s) => s.section === 'skills')?.unknown).toEqual(['skills.skills:brandNew']);
    expect(result).toMatchObject({ mcpActions: true, reload: true });
    expect(JSON.stringify(result)).not.toContain(ACCOUNT_LINE);
    expect(JSON.stringify(result)).not.toContain('someone');
    expect(lines.join('\n')).toContain(
      'session info ok (1 unknown field(s)), MCP actions present, reloads present',
    );
  });

  it('missing methods, refused requests, failures and unknown shapes are findings, not stops', async () => {
    const h = handle(
      {
        getStatus: new Error('get_status is not available in this build'),
        getHooksListing: new Error('Request timed out'),
        getSkillsDialog: { rows: [] },
      },
      false,
    );
    delete h.exportConversation;
    const lines: string[] = [];
    const result = await probeSessionInfo(h, { timeoutMs: 1000, log: (l) => lines.push(l) });
    const detail = (section: string) => result.sections.find((s) => s.section === section)?.detail;
    expect(detail('status')).toBe('getStatus refused: get_status is not available in this build');
    expect(detail('hooks')).toBe('getHooksListing failed: Request timed out');
    expect(detail('skills')).toBe('the answer of getSkillsDialog has an unknown shape');
    expect(detail('export')).toBe('Query.exportConversation is missing (SDK)');
    expect(result).toMatchObject({ mcpActions: false, reload: false });
    expect(lines.join('\n')).toContain('NOT ok for status, skills, hooks, export');
  });

  it('a request that never answers times out', async () => {
    const h = handle();
    h.getStatus = () => new Promise<unknown>(() => undefined);
    const result = await probeSessionInfo(h, { timeoutMs: 5 });
    expect(result.sections[0]).toMatchObject({ section: 'status', available: false });
    expect(result.sections[0]?.detail).toContain('getStatus failed');
    expect(result.sections.slice(1).every((s) => s.available)).toBe(true);
  });

  it('sessionInfoProfile: one boolean per tab plus the actions', async () => {
    const result = await probeSessionInfo(handle({ mcpServerStatus: 'nope' }), { timeoutMs: 1000 });
    expect(sessionInfoProfile(result)).toEqual({
      status: true,
      memory: true,
      skills: true,
      hooks: true,
      permissions: true,
      mcp: false,
      export: true,
      mcpActions: true,
      reload: true,
    });
  });
});

describe('profile and comparison (WP-67)', () => {
  it('profiles before WP-67 read the field as null; observations carry it', () => {
    const { sessionInfo: _ignored, ...older } = sampleProfile();
    expect(parseCliProfile(older)).toMatchObject({ sessionInfo: null });
    const info = sampleObservation().sessionInfo;
    const observation = observationFrom(
      {
        init: { type: 'system', subtype: 'init', claude_code_version: '2.1.323' },
        initializationResult: null,
        supportedModels: null,
        contextUsage: null,
        sessionInfo: info,
      },
      '0.3.322',
    );
    expect(observation.sessionInfo).toEqual(info);
  });

  it('true → false is a deviation per tab with the place in Parallax; a first check gives notes', () => {
    const info = sampleObservation().sessionInfo;
    if (info === null) throw new Error('sample without session info');
    const lost = sessionInfoFindings(
      sampleProfile(),
      sampleObservation({ sessionInfo: { ...info, hooks: false, reload: false } }),
    );
    expect(lost.map((f) => [f.area, f.level])).toEqual([
      ['sessionInfo.hooks', 'deviation'],
      ['sessionInfo.reload', 'deviation'],
    ]);
    expect(lost[0]?.hint).toContain('backend/sessionInfo.ts');
    const first = sessionInfoFindings(sampleProfile({ sessionInfo: null }), sampleObservation());
    expect(first).toHaveLength(9);
    expect(first.every((f) => f.level === 'note')).toBe(true);
    expect(compareObservation(sampleProfile(), sampleObservation())).toEqual([]);
  });

  it('the run record keeps the step; the report lists it without values (older records read as null)', () => {
    const record = sampleRecord();
    expect(runRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const { probe } = record;
    if (probe === null) throw new Error('sample without probe');
    const { sessionInfo: _ignored, ...olderProbe } = probe;
    expect(runRecordSchema.parse({ ...record, probe: olderProbe }).probe?.sessionInfo).toBeNull();
    const profile = sampleProfile();
    const green = formatReport({
      record,
      profile,
      profilePath: 'p.json',
      evaluation: evaluate(record, profile),
      mode: 'live',
    });
    expect(green).toContain('- session info status: ok (3 row(s), no unknown fields)');
    expect(green).toContain('- session info export: ok (no unknown fields)');
    expect(green).toContain('- MCP actions (reconnectMcpServer, toggleMcpServer): present');

    const info = sampleObservation().sessionInfo;
    if (info === null || probe.sessionInfo === null) throw new Error('sample without session info');
    const failed = sampleRecord({
      observation: sampleObservation({ sessionInfo: { ...info, mcp: false } }),
      probe: {
        ...probe,
        sessionInfo: {
          ...probe.sessionInfo,
          sections: probe.sessionInfo.sections.map((s) =>
            s.section === 'mcp'
              ? { ...s, available: false, detail: 'Query.mcpServerStatus is missing (SDK)', rows: null }
              : s,
          ),
        },
      },
    });
    const evaluation = evaluate(failed, profile);
    expect(evaluation.exitCode).toBe(1);
    const text = formatReport({ record: failed, profile, profilePath: 'p.json', evaluation, mode: 'live' });
    expect(text).toContain('- session info mcp: NOT ok – Query.mcpServerStatus is missing (SDK)');
  });
});
