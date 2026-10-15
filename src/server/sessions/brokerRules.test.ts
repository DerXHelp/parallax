import { describe, expect, it } from 'vitest';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { RULE_DESTINATIONS, type PermissionMode } from '@shared/common';
import type { DecisionResponse, PermissionDecision } from '@shared/model';
import { sampleDecisions } from '@shared/samples';
import type { PermissionRequest } from '../backend/types';
import { fixtureCanUseToolPayloadSchema, fixtureDecisionPayloadSchema } from '../backend/fixture';
import { toPermissionRequest } from '../backend/permissionRequest';
import { loadAllFixtures } from './normalizer/testing/harness';
import {
  BROKER_MESSAGES,
  approveModes,
  buildOffer,
  buildResult,
  cancelResult,
  decisionKindFor,
  parsePlan,
  parseQuestions,
  rememberUpdates,
  validateResponse,
} from './brokerRules';

const fixtures = await loadAllFixtures();

/** The recorded canUseTool request of a fixture event. */
function recorded(fixture: string, seq: number): PermissionRequest {
  const event = fixtures.get(fixture)?.events.find((e) => e.seq === seq);
  if (event?.kind !== 'canUseTool') throw new Error(`${fixture}#${String(seq)} is not a canUseTool event`);
  const payload = fixtureCanUseToolPayloadSchema.parse(event.payload);
  return toPermissionRequest(payload.toolName, payload.input, payload.options);
}

function request(p: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    toolName: 'Bash',
    input: { command: 'ls' },
    toolUseId: 'toolu_1',
    requestId: 'req_1',
    agentId: null,
    suggestions: [],
    blockedPath: null,
    decisionReason: null,
    decisionReasonType: null,
    title: null,
    displayName: null,
    description: null,
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    requiresUserInteraction: false,
    mcpServer: null,
    raw: {},
    ...p,
  };
}

const ADD_RULES: PermissionUpdate = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'mkdir x' }],
  behavior: 'allow',
  destination: 'localSettings',
};
const ADD_DIRS: PermissionUpdate = {
  type: 'addDirectories',
  directories: ['D:\\work'],
  destination: 'session',
};
const SET_ACCEPT: PermissionUpdate = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };

describe('decisionKindFor / parseQuestions / parsePlan', () => {
  it('maps the tool names', () => {
    expect(decisionKindFor('AskUserQuestion')).toBe('question');
    expect(decisionKindFor('ExitPlanMode')).toBe('plan');
    expect(decisionKindFor('Bash')).toBe('permission');
    expect(decisionKindFor('mcp__x__y')).toBe('permission');
  });

  it('parses the recorded AskUserQuestion input with defaults; unusable → null', () => {
    const questions = parseQuestions(recorded('ask-user-question', 44).input);
    expect(questions).toHaveLength(1);
    expect(questions?.[0]).toMatchObject({
      question: 'Which color should the button be?',
      header: 'Color',
      multiSelect: false,
    });
    expect(questions?.[0]?.options.map((o) => o.label)).toEqual(['Red', 'Blue']);
    expect(parseQuestions({ questions: [{ question: 'q', options: [{ label: 'a' }] }] })).toEqual([
      {
        question: 'q',
        header: '',
        multiSelect: false,
        options: [{ label: 'a', description: '', preview: null }],
      },
    ]);
    expect(parseQuestions({})).toBeNull();
    expect(parseQuestions({ questions: [] })).toBeNull();
    expect(parseQuestions({ questions: [{ question: 1 }] })).toBeNull();
  });

  it('parses the recorded ExitPlanMode input; no plan text → null', () => {
    expect(parsePlan(recorded('plan-mode', 55).input)).toEqual({
      plan: expect.stringContaining('## Plan') as string,
      planFilePath: '<HOME>\\.claude\\plans\\plan-how-to-create-velvet-quail.md',
    });
    expect(parsePlan({ plan: 'x' })).toEqual({ plan: 'x', planFilePath: null });
    expect(parsePlan({ plan: 3 })).toBeNull();
  });
});

describe('buildOffer (F.3, ADR-012)', () => {
  it('Write: only setMode acceptEdits → no remember option, acceptEdits offered (permissions#40)', () => {
    expect(buildOffer(recorded('permissions', 40), 'default')).toEqual({
      rules: [],
      directories: [],
      ruleDestinations: [],
      acceptEdits: true,
      defaultToNo: false,
    });
  });

  it('Bash: addRules localSettings + addDirectories + setMode → rules, directories, all four destinations (permissions#45)', () => {
    expect(buildOffer(recorded('permissions', 45), 'default')).toEqual({
      rules: [{ toolName: 'Bash', ruleContent: 'mkdir -p spike-dir && ls -1' }],
      directories: ['<SCRATCH>\\work\\permissions'],
      ruleDestinations: [...RULE_DESTINATIONS],
      acceptEdits: true,
      defaultToNo: false,
    });
  });

  it('PowerShell: addDirectories + setMode without rules (permissions#167)', () => {
    expect(buildOffer(recorded('permissions', 167), 'default')).toMatchObject({
      rules: [],
      directories: ['<SCRATCH>\\work\\permissions'],
      ruleDestinations: [...RULE_DESTINATIONS],
      acceptEdits: true,
    });
  });

  it('without suggestions: nothing to remember, no acceptEdits', () => {
    expect(buildOffer(request(), 'default')).toEqual({
      rules: [],
      directories: [],
      ruleDestinations: [],
      acceptEdits: false,
      defaultToNo: false,
    });
  });

  it('filters deny/ask rules and non-add updates, dedupes rules and directories', () => {
    const offer = buildOffer(
      request({
        suggestions: [
          ADD_RULES,
          { ...ADD_RULES, destination: 'session' },
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash' }, { toolName: 'Read', ruleContent: '*' }],
            behavior: 'allow',
            destination: 'cliArg',
          },
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'rm -rf' }],
            behavior: 'deny',
            destination: 'session',
          },
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'curl' }],
            behavior: 'ask',
            destination: 'session',
          },
          { type: 'replaceRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' },
          { type: 'removeDirectories', directories: ['D:\\gone'], destination: 'session' },
          ADD_DIRS,
          { ...ADD_DIRS, directories: ['D:\\work', 'D:\\other'] },
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ],
      }),
      'default',
    );
    expect(offer.rules).toEqual([
      { toolName: 'Bash', ruleContent: 'mkdir x' },
      { toolName: 'Bash', ruleContent: null },
      { toolName: 'Read', ruleContent: '*' },
    ]);
    expect(offer.directories).toEqual(['D:\\work', 'D:\\other']);
    expect(offer.acceptEdits).toBe(false);
    // cliArg is never a destination (ADR-012).
    expect(offer.ruleDestinations).not.toContain('cliArg');
  });

  it('suppressAlwaysAllowRule → no destinations; defaultToNo is passed through', () => {
    const offer = buildOffer(
      request({ suggestions: [ADD_RULES, SET_ACCEPT], suppressAlwaysAllowRule: true, defaultToNo: true }),
      null,
    );
    expect(offer.ruleDestinations).toEqual([]);
    expect(offer.rules).toHaveLength(1);
    expect(offer.acceptEdits).toBe(true);
    expect(offer.defaultToNo).toBe(true);
  });

  it.each<[PermissionMode | null, boolean]>([
    [null, true],
    ['default', true],
    ['plan', true],
    ['dontAsk', true],
    ['acceptEdits', false],
    ['auto', false],
    ['bypassPermissions', false],
  ])('acceptEdits in mode %s → %s', (mode, expected) => {
    expect(buildOffer(request({ suggestions: [SET_ACCEPT] }), mode).acceptEdits).toBe(expected);
  });
});

describe('approveModes (C.4)', () => {
  it.each([
    [false, false, ['acceptEdits', 'default']],
    [true, false, ['acceptEdits', 'auto', 'default']],
    [false, true, ['acceptEdits', 'default', 'bypassPermissions']],
    [true, true, ['acceptEdits', 'auto', 'default', 'bypassPermissions']],
  ])('auto=%s bypass=%s → %j', (supportsAutoMode, allowsBypass, modes) => {
    expect(approveModes({ supportsAutoMode, allowsBypass })).toEqual(modes);
  });
});

// ---- buildResult: one test per row of the §3.4 table ----

const permission = (offer: Partial<PermissionDecision['offer']> = {}): PermissionDecision =>
  sampleDecisions.permission({
    offer: {
      rules: [{ toolName: 'Bash', ruleContent: 'mkdir build' }],
      directories: ['D:\\work'],
      ruleDestinations: [...RULE_DESTINATIONS],
      acceptEdits: true,
      defaultToNo: false,
      ...offer,
    },
  });
const INPUT = { command: 'mkdir build', description: 'Create build folder', long: 'x'.repeat(10) };
const perm = (response: Extract<DecisionResponse, { kind: 'permission' }>['response']): DecisionResponse => ({
  kind: 'permission',
  response,
});

describe('buildResult – permission', () => {
  it('allow once', () => {
    expect(
      buildResult(permission(), INPUT, perm({ behavior: 'allow', remember: null, acceptEdits: false })),
    ).toEqual({
      result: { behavior: 'allow', updatedInput: INPUT, decisionClassification: 'user_temporary' },
      outcome: { type: 'allowed', remember: null, acceptEdits: false },
    });
  });

  it.each(RULE_DESTINATIONS)('remember at %s: rules AND directories at that destination', (destination) => {
    const built = buildResult(
      permission(),
      INPUT,
      perm({ behavior: 'allow', remember: destination, acceptEdits: false }),
    );
    expect(built.result).toEqual({
      behavior: 'allow',
      updatedInput: INPUT,
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'mkdir build' }],
          behavior: 'allow',
          destination,
        },
        { type: 'addDirectories', directories: ['D:\\work'], destination },
      ],
      decisionClassification: destination === 'session' ? 'user_temporary' : 'user_permanent',
    });
    expect(built.outcome).toEqual({ type: 'allowed', remember: destination, acceptEdits: false });
  });

  it('remember with only rules / only directories; rule without content', () => {
    expect(
      rememberUpdates(
        { ...permission().offer, directories: [], rules: [{ toolName: 'Edit', ruleContent: null }] },
        'session',
        false,
      ),
    ).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' },
    ]);
    expect(rememberUpdates({ ...permission().offer, rules: [] }, 'localSettings', false)).toEqual([
      { type: 'addDirectories', directories: ['D:\\work'], destination: 'localSettings' },
    ]);
  });

  it('acceptEdits adds setMode with destination session (also combined with remember)', () => {
    expect(
      buildResult(permission(), INPUT, perm({ behavior: 'allow', remember: null, acceptEdits: true })).result,
    ).toEqual({
      behavior: 'allow',
      updatedInput: INPUT,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      decisionClassification: 'user_temporary',
    });
    const both = buildResult(
      permission(),
      INPUT,
      perm({ behavior: 'allow', remember: 'userSettings', acceptEdits: true }),
    );
    expect(both.result.behavior === 'allow' ? both.result.updatedPermissions?.at(-1) : null).toEqual({
      type: 'setMode',
      mode: 'acceptEdits',
      destination: 'session',
    });
    expect(both.outcome).toEqual({ type: 'allowed', remember: 'userSettings', acceptEdits: true });
  });

  it('deny with message, without message (default text), with interrupt', () => {
    expect(
      buildResult(permission(), INPUT, perm({ behavior: 'deny', message: 'Not now', interrupt: false })),
    ).toEqual({
      result: {
        behavior: 'deny',
        message: 'Not now',
        interrupt: false,
        decisionClassification: 'user_reject',
      },
      outcome: { type: 'denied', withMessage: true, interrupt: false },
    });
    expect(
      buildResult(permission(), INPUT, perm({ behavior: 'deny', message: '  ', interrupt: true })),
    ).toEqual({
      result: {
        behavior: 'deny',
        message: BROKER_MESSAGES.denied,
        interrupt: true,
        decisionClassification: 'user_reject',
      },
      outcome: { type: 'denied', withMessage: false, interrupt: true },
    });
  });
});

describe('buildResult – question (F.5, ask-user-question#45)', () => {
  const question = sampleDecisions.question({
    questions: [
      {
        question: 'Which color should the button be?',
        header: 'Color',
        multiSelect: false,
        options: [
          { label: 'Red', description: '', preview: 'red-preview' },
          { label: 'Blue', description: '', preview: 'blue-preview' },
        ],
      },
      {
        question: 'Which extras?',
        header: '',
        multiSelect: true,
        options: [
          { label: 'Icon', description: '', preview: null },
          { label: 'Shadow', description: '', preview: 'shadow' },
        ],
      },
    ],
  });
  const input = { questions: [{ question: 'Which color should the button be?' }] };

  it('reproduces the recorded updatedInput exactly', () => {
    const req = recorded('ask-user-question', 44);
    const questions = parseQuestions(req.input);
    if (questions === null) throw new Error('questions');
    const decision = sampleDecisions.question({ questions });
    const built = buildResult(decision, req.input, {
      kind: 'question',
      response: {
        behavior: 'answer',
        answers: [
          {
            question: 'Which color should the button be?',
            selected: ['Blue'],
            otherText: null,
            notes: 'Spike note: prefer a darker shade',
          },
        ],
      },
    });
    const event = fixtures.get('ask-user-question')?.events.find((e) => e.seq === 45);
    expect(built.result).toEqual(fixtureDecisionPayloadSchema.parse(event?.payload).result);
    expect(built.outcome).toEqual({ type: 'answered' });
  });

  it('answers: multi-select comma-joined + other text; annotations only with content; preview only for one selection', () => {
    const built = buildResult(question, input, {
      kind: 'question',
      response: {
        behavior: 'answer',
        answers: [
          { question: 'Which color should the button be?', selected: [], otherText: 'Green', notes: null },
          { question: 'Which extras?', selected: ['Icon', 'Shadow'], otherText: 'Glow', notes: 'subtle' },
        ],
      },
    });
    expect(built.result).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: { 'Which color should the button be?': 'Green', 'Which extras?': 'Icon, Shadow, Glow' },
        annotations: { 'Which extras?': { notes: 'subtle' } },
      },
      decisionClassification: 'user_temporary',
    });
  });

  it('decline with and without message', () => {
    expect(
      buildResult(question, input, { kind: 'question', response: { behavior: 'decline', message: '' } }),
    ).toEqual({
      result: { behavior: 'deny', message: BROKER_MESSAGES.declined, decisionClassification: 'user_reject' },
      outcome: { type: 'declined' },
    });
    expect(
      buildResult(question, input, { kind: 'question', response: { behavior: 'decline', message: 'skip' } })
        .result,
    ).toMatchObject({
      message: 'skip',
    });
  });
});

describe('buildResult – plan (F.6, C.4)', () => {
  const plan = sampleDecisions.plan();
  const input = { plan: plan.plan, planFilePath: plan.planFilePath };

  it('approve without edit: input unchanged, setMode with destination session', () => {
    expect(
      buildResult(plan, input, {
        kind: 'plan',
        response: { behavior: 'approve', mode: 'default', editedPlan: null },
      }),
    ).toEqual({
      result: {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
        decisionClassification: 'user_temporary',
      },
      outcome: { type: 'plan_approved', mode: 'default', edited: false },
    });
  });

  it('approve with edited plan (plan-mode#99 shape); same text → edited false', () => {
    const edited = buildResult(plan, input, {
      kind: 'plan',
      response: { behavior: 'approve', mode: 'acceptEdits', editedPlan: `${plan.plan}\n- more` },
    });
    expect(edited.result).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, plan: `${plan.plan}\n- more` },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      decisionClassification: 'user_temporary',
    });
    expect(edited.outcome).toEqual({ type: 'plan_approved', mode: 'acceptEdits', edited: true });
    const same = buildResult(plan, input, {
      kind: 'plan',
      response: { behavior: 'approve', mode: 'auto', editedPlan: plan.plan },
    });
    expect(same.outcome).toEqual({ type: 'plan_approved', mode: 'auto', edited: false });
  });

  it('revise → deny with the feedback', () => {
    expect(
      buildResult(plan, input, { kind: 'plan', response: { behavior: 'revise', feedback: 'Add tests.' } }),
    ).toEqual({
      result: { behavior: 'deny', message: 'Add tests.', decisionClassification: 'user_reject' },
      outcome: { type: 'plan_revised' },
    });
  });

  it('approve_fresh_context and kind mismatches throw (validateResponse rejects them first)', () => {
    expect(() =>
      buildResult(plan, input, {
        kind: 'plan',
        response: { behavior: 'approve_fresh_context', mode: 'auto' },
      }),
    ).toThrow();
    expect(() => buildResult(plan, input, perm({ behavior: 'deny', message: '', interrupt: false }))).toThrow(
      /does not match/,
    );
  });
});

// ---- validateResponse: one test per error row ----

describe('validateResponse (§3.4 Prüfungen, architecture §5.2)', () => {
  const open = (decision = permission()) => ({ decision, resolved: false });

  it('unknown id → DECISION_NOT_FOUND; resolved → DECISION_ALREADY_RESOLVED', () => {
    expect(
      validateResponse(undefined, perm({ behavior: 'allow', remember: null, acceptEdits: false }))?.code,
    ).toBe('DECISION_NOT_FOUND');
    expect(
      validateResponse(
        { decision: permission(), resolved: true },
        perm({ behavior: 'allow', remember: null, acceptEdits: false }),
      )?.code,
    ).toBe('DECISION_ALREADY_RESOLVED');
  });

  it('expired: everything but plan approve → DECISION_EXPIRED', () => {
    const expiredPermission = { decision: { ...permission(), state: 'expired' as const }, resolved: false };
    expect(
      validateResponse(expiredPermission, perm({ behavior: 'allow', remember: null, acceptEdits: false }))
        ?.code,
    ).toBe('DECISION_EXPIRED');
    const expiredPlan = {
      decision: { ...sampleDecisions.plan(), state: 'expired' as const },
      resolved: false,
    };
    expect(
      validateResponse(expiredPlan, { kind: 'plan', response: { behavior: 'revise', feedback: 'x' } })?.code,
    ).toBe('DECISION_EXPIRED');
    expect(
      validateResponse(expiredPlan, {
        kind: 'plan',
        response: { behavior: 'approve_fresh_context', mode: 'auto' },
      })?.code,
    ).toBe('DECISION_EXPIRED');
    expect(
      validateResponse(expiredPlan, {
        kind: 'plan',
        response: { behavior: 'approve', mode: 'acceptEdits', editedPlan: null },
      }),
    ).toBeNull();
    expect(
      validateResponse(expiredPlan, {
        kind: 'plan',
        response: { behavior: 'approve', mode: 'bypassPermissions', editedPlan: null },
      }),
    ).toMatchObject({ code: 'DECISION_OPTION_UNAVAILABLE', params: { path: 'mode' } });
  });

  it('kind mismatch → DECISION_OPTION_UNAVAILABLE', () => {
    expect(
      validateResponse(open(), { kind: 'question', response: { behavior: 'decline', message: '' } }),
    ).toMatchObject({
      code: 'DECISION_OPTION_UNAVAILABLE',
      params: { path: 'kind' },
    });
  });

  it('remember destination not in the offer → DECISION_OPTION_UNAVAILABLE', () => {
    const noRemember = open(permission({ ruleDestinations: [] }));
    expect(
      validateResponse(noRemember, perm({ behavior: 'allow', remember: 'session', acceptEdits: false })),
    ).toMatchObject({
      code: 'DECISION_OPTION_UNAVAILABLE',
      params: { path: 'remember' },
    });
    const sessionOnly = open(permission({ ruleDestinations: ['session'] }));
    expect(
      validateResponse(sessionOnly, perm({ behavior: 'allow', remember: 'userSettings', acceptEdits: false }))
        ?.code,
    ).toBe('DECISION_OPTION_UNAVAILABLE');
    expect(
      validateResponse(sessionOnly, perm({ behavior: 'allow', remember: 'session', acceptEdits: false })),
    ).toBeNull();
  });

  it('acceptEdits without offer.acceptEdits → DECISION_OPTION_UNAVAILABLE', () => {
    expect(
      validateResponse(
        open(permission({ acceptEdits: false })),
        perm({ behavior: 'allow', remember: null, acceptEdits: true }),
      ),
    ).toMatchObject({
      code: 'DECISION_OPTION_UNAVAILABLE',
      params: { path: 'acceptEdits' },
    });
    expect(validateResponse(open(), perm({ behavior: 'deny', message: '', interrupt: true }))).toBeNull();
  });

  describe('questions', () => {
    const decision = sampleDecisions.question({
      questions: [
        {
          question: 'Single?',
          header: '',
          multiSelect: false,
          options: [
            { label: 'A', description: '', preview: null },
            { label: 'B', description: '', preview: null },
          ],
        },
        {
          question: 'Multi?',
          header: '',
          multiSelect: true,
          options: [
            { label: 'X', description: '', preview: null },
            { label: 'Y', description: '', preview: null },
          ],
        },
      ],
    });
    const answer = (
      answers: { question: string; selected: string[]; otherText?: string | null }[],
    ): DecisionResponse => ({
      kind: 'question',
      response: { behavior: 'answer', answers: answers.map((a) => ({ otherText: null, notes: null, ...a })) },
    });
    const check = (answers: Parameters<typeof answer>[0]) =>
      validateResponse({ decision, resolved: false }, answer(answers));

    it('valid answers (unanswered questions allowed, other text alone)', () => {
      expect(check([{ question: 'Single?', selected: ['A'] }])).toBeNull();
      expect(
        check([
          { question: 'Multi?', selected: ['X', 'Y'] },
          { question: 'Single?', selected: [], otherText: 'C' },
        ]),
      ).toBeNull();
    });

    it.each([
      ['unknown question', [{ question: 'Other?', selected: ['A'] }], 'answers.0.question'],
      [
        'question twice',
        [
          { question: 'Single?', selected: ['A'] },
          { question: 'Single?', selected: ['B'] },
        ],
        'answers.1.question',
      ],
      ['foreign label', [{ question: 'Single?', selected: ['Z'] }], 'answers.0.selected'],
      [
        'two labels without multiSelect',
        [{ question: 'Single?', selected: ['A', 'B'] }],
        'answers.0.selected',
      ],
      ['label twice', [{ question: 'Multi?', selected: ['X', 'X'] }], 'answers.0.selected'],
      ['empty answer', [{ question: 'Multi?', selected: [], otherText: '  ' }], 'answers.0.selected'],
    ])('%s → DECISION_OPTION_UNAVAILABLE (%s)', (_name, answers, path) => {
      expect(check(answers)).toMatchObject({ code: 'DECISION_OPTION_UNAVAILABLE', params: { path } });
    });
  });

  it('plan: mode not in approveModes, approve_fresh_context → NOT_IMPLEMENTED', () => {
    const plan = {
      decision: sampleDecisions.plan({ approveModes: ['acceptEdits', 'default'] }),
      resolved: false,
    };
    expect(
      validateResponse(plan, {
        kind: 'plan',
        response: { behavior: 'approve', mode: 'auto', editedPlan: null },
      }),
    ).toMatchObject({
      code: 'DECISION_OPTION_UNAVAILABLE',
      params: { path: 'mode' },
    });
    expect(
      validateResponse(plan, {
        kind: 'plan',
        response: { behavior: 'approve_fresh_context', mode: 'default' },
      })?.code,
    ).toBe('NOT_IMPLEMENTED');
    expect(
      validateResponse(plan, { kind: 'plan', response: { behavior: 'revise', feedback: 'x' } }),
    ).toBeNull();
  });
});

describe('cancelResult (§3.4 Abbruch)', () => {
  it.each([
    [
      'interrupted',
      'deny-interrupt',
      {
        behavior: 'deny',
        message: BROKER_MESSAGES.interrupted,
        interrupt: true,
        decisionClassification: 'user_reject',
      },
    ],
    [
      'interrupted',
      'deny',
      {
        behavior: 'deny',
        message: BROKER_MESSAGES.newMessage,
        interrupt: false,
        decisionClassification: 'user_reject',
      },
    ],
    ['process_exit', 'deny', { behavior: 'deny', message: BROKER_MESSAGES.cancelled, interrupt: false }],
    [
      'conversation_reset',
      'deny',
      { behavior: 'deny', message: BROKER_MESSAGES.cancelled, interrupt: false },
    ],
    ['signal_aborted', 'deny', { behavior: 'deny', message: BROKER_MESSAGES.cancelled, interrupt: false }],
  ] as const)('%s / %s', (reason, answer, expected) => {
    expect(cancelResult(reason, answer)).toEqual(expected);
  });
});
