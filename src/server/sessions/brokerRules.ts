/**
 * Pure rules of the PermissionBroker (WP-13 §3.4, ADR-012, architecture §5.2, F.3, F.5, F.6,
 * C.4): the offer of a permission card, the server-built `PermissionResult` for a client intent,
 * the validation of an intent and the cancel answers. No state, no I/O – table-tested.
 */
import type { PermissionResult, PermissionRuleValue, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import {
  RULE_DESTINATIONS,
  type DecisionKind,
  type PermissionMode,
  type RuleDestination,
} from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  type CANCEL_REASONS,
  questionDecisionSchema,
  type Decision,
  type DecisionOutcome,
  type DecisionResponse,
  type PermissionDecision,
  type PermissionOffer,
  type PlanDecision,
  type QuestionDecision,
} from '@shared/model';
import type { PermissionRequest } from '../backend/types';

export type CancelReason = (typeof CANCEL_REASONS)[number];

/** Default texts sent to the CLI (English, never shown in the UI). */
export const BROKER_MESSAGES = {
  denied: 'The user denied this action.',
  declined: 'The user declined to answer.',
  interrupted: 'The user interrupted.',
  newMessage: 'The user sent a new message instead.',
  cancelled: 'Cancelled.',
} as const;

/** AskUserQuestion → question, ExitPlanMode → plan, everything else → permission. */
export function decisionKindFor(toolName: string): DecisionKind {
  if (toolName === 'AskUserQuestion') return 'question';
  if (toolName === 'ExitPlanMode') return 'plan';
  return 'permission';
}

export type Questions = QuestionDecision['questions'];

/** AskUserQuestion input → questions (zod, with defaults); null if unusable (→ permission card). */
export function parseQuestions(input: Record<string, unknown>): Questions | null {
  const parsed = questionDecisionSchema.shape.questions.safeParse(input.questions);
  return parsed.success ? parsed.data : null;
}

/** ExitPlanMode input → plan text + plan file (C.4); null if `plan` is not a string (→ permission card). */
export function parsePlan(
  input: Record<string, unknown>,
): { plan: string; planFilePath: string | null } | null {
  if (typeof input.plan !== 'string') return null;
  return {
    plan: input.plan,
    planFilePath: typeof input.planFilePath === 'string' ? input.planFilePath : null,
  };
}

/** Modes for that `acceptEdits` is never offered (already at least as permissive). */
const NO_ACCEPT_EDITS_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  'acceptEdits',
  'auto',
  'bypassPermissions',
]);

/**
 * The offer of a permission card (§3.4 "Angebot"): only `addRules` with behavior allow (never
 * deny/ask), `addDirectories`, all four destinations unless suppressed or nothing to remember,
 * `acceptEdits` only when suggested and the current mode is not already more permissive.
 */
export function buildOffer(req: PermissionRequest, mode: PermissionMode | null): PermissionOffer {
  const rules: PermissionOffer['rules'] = [];
  const ruleKeys = new Set<string>();
  const directories: string[] = [];
  let suggestsAcceptEdits = false;
  for (const suggestion of req.suggestions) {
    if (suggestion.type === 'addRules' && suggestion.behavior === 'allow') {
      for (const rule of suggestion.rules) {
        const entry = { toolName: rule.toolName, ruleContent: rule.ruleContent ?? null };
        const key = JSON.stringify([entry.toolName, entry.ruleContent]);
        if (ruleKeys.has(key)) continue;
        ruleKeys.add(key);
        rules.push(entry);
      }
    } else if (suggestion.type === 'addDirectories') {
      for (const directory of suggestion.directories) {
        if (!directories.includes(directory)) directories.push(directory);
      }
    } else if (suggestion.type === 'setMode' && suggestion.mode === 'acceptEdits') {
      suggestsAcceptEdits = true;
    }
  }
  const remember = (rules.length > 0 || directories.length > 0) && !req.suppressAlwaysAllowRule;
  return {
    rules,
    directories,
    ruleDestinations: remember ? [...RULE_DESTINATIONS] : [],
    acceptEdits: suggestsAcceptEdits && (mode === null || !NO_ACCEPT_EDITS_MODES.has(mode)),
    defaultToNo: req.defaultToNo,
  };
}

/** Modes offered for a plan approval (C.4), in this order. */
export function approveModes(o: { supportsAutoMode: boolean; allowsBypass: boolean }): PermissionMode[] {
  const modes: PermissionMode[] = ['acceptEdits'];
  if (o.supportsAutoMode) modes.push('auto');
  modes.push('default');
  if (o.allowsBypass) modes.push('bypassPermissions');
  return modes;
}

// ---- Validation (§3.4 "Prüfungen", architecture §5.2) ----

export interface ValidationTarget {
  decision: Decision;
  /** Resolved, cancelled or claimed (an expired plan being resumed). */
  resolved: boolean;
}

function unavailable(path: string, message: string): ErrorPayload {
  return makeError('DECISION_OPTION_UNAVAILABLE', { path }, message);
}

function validateQuestion(
  decision: QuestionDecision,
  response: Extract<DecisionResponse, { kind: 'question' }>,
) {
  if (response.response.behavior !== 'answer') return null;
  const seen = new Set<string>();
  for (const [index, answer] of response.response.answers.entries()) {
    const question = decision.questions.find((q) => q.question === answer.question);
    if (question === undefined) return unavailable(`answers.${String(index)}.question`, 'unknown question');
    if (seen.has(answer.question))
      return unavailable(`answers.${String(index)}.question`, 'question answered twice');
    seen.add(answer.question);
    const labels = new Set(question.options.map((o) => o.label));
    if (answer.selected.some((label) => !labels.has(label))) {
      return unavailable(`answers.${String(index)}.selected`, 'label not offered');
    }
    if (!question.multiSelect && answer.selected.length > 1) {
      return unavailable(`answers.${String(index)}.selected`, 'single select');
    }
    if (new Set(answer.selected).size !== answer.selected.length) {
      return unavailable(`answers.${String(index)}.selected`, 'label selected twice');
    }
    const other = answer.otherText?.trim() ?? '';
    if (answer.selected.length === 0 && other === '') {
      return unavailable(`answers.${String(index)}.selected`, 'empty answer');
    }
  }
  return null;
}

/**
 * Checks an intent against the stored decision (§3.4 "Prüfungen"). Order: not found → already
 * resolved → expired (only plan approve may answer an expired card) → kind → options.
 */
export function validateResponse(
  target: ValidationTarget | undefined,
  response: DecisionResponse,
): ErrorPayload | null {
  if (target === undefined) return makeError('DECISION_NOT_FOUND');
  const { decision } = target;
  const params = { decisionId: decision.id };
  if (target.resolved) return makeError('DECISION_ALREADY_RESOLVED', params);
  const planApprove = response.kind === 'plan' && response.response.behavior === 'approve';
  if (decision.state === 'expired' && !planApprove) return makeError('DECISION_EXPIRED', params);
  if (response.kind !== decision.kind) return unavailable('kind', `decision is a ${decision.kind}`);

  if (decision.kind === 'permission' && response.kind === 'permission') {
    const r = response.response;
    if (r.behavior === 'allow') {
      if (r.remember !== null && !decision.offer.ruleDestinations.includes(r.remember)) {
        return unavailable('remember', 'destination not offered');
      }
      if (r.acceptEdits && !decision.offer.acceptEdits)
        return unavailable('acceptEdits', 'acceptEdits not offered');
    }
    return null;
  }
  if (decision.kind === 'question' && response.kind === 'question')
    return validateQuestion(decision, response);
  if (decision.kind === 'plan' && response.kind === 'plan') {
    const r = response.response;
    if (r.behavior === 'approve_fresh_context') {
      return makeError('NOT_IMPLEMENTED', { feature: 'approve_fresh_context' });
    }
    if (r.behavior === 'approve' && !decision.approveModes.includes(r.mode)) {
      return unavailable('mode', 'mode not offered');
    }
  }
  return null;
}

// ---- Intent → PermissionResult (§3.4 table; updatedInput from the UNCAPPED original input) ----

export interface BuiltResult {
  result: PermissionResult;
  outcome: DecisionOutcome;
}

function ruleValue(rule: PermissionOffer['rules'][number]): PermissionRuleValue {
  return rule.ruleContent === null
    ? { toolName: rule.toolName }
    : { toolName: rule.toolName, ruleContent: rule.ruleContent };
}

/** `updatedPermissions` for "remember at D" (+ acceptEdits), built ONLY from the offer (ADR-012). */
export function rememberUpdates(
  offer: PermissionOffer,
  remember: RuleDestination | null,
  acceptEdits: boolean,
): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [];
  if (remember !== null && offer.rules.length > 0) {
    updates.push({
      type: 'addRules',
      rules: offer.rules.map(ruleValue),
      behavior: 'allow',
      destination: remember,
    });
  }
  if (remember !== null && offer.directories.length > 0) {
    updates.push({ type: 'addDirectories', directories: [...offer.directories], destination: remember });
  }
  if (acceptEdits) updates.push({ type: 'setMode', mode: 'acceptEdits', destination: 'session' });
  return updates;
}

function permissionResult(
  decision: PermissionDecision,
  input: Record<string, unknown>,
  response: Extract<DecisionResponse, { kind: 'permission' }>['response'],
): BuiltResult {
  if (response.behavior === 'deny') {
    const message = response.message.trim() === '' ? BROKER_MESSAGES.denied : response.message;
    return {
      result: {
        behavior: 'deny',
        message,
        interrupt: response.interrupt,
        decisionClassification: 'user_reject',
      },
      outcome: { type: 'denied', withMessage: response.message.trim() !== '', interrupt: response.interrupt },
    };
  }
  const updates = rememberUpdates(decision.offer, response.remember, response.acceptEdits);
  const permanent = response.remember !== null && response.remember !== 'session';
  return {
    result: {
      behavior: 'allow',
      updatedInput: input,
      ...(updates.length > 0 ? { updatedPermissions: updates } : {}),
      decisionClassification: permanent ? 'user_permanent' : 'user_temporary',
    },
    outcome: { type: 'allowed', remember: response.remember, acceptEdits: response.acceptEdits },
  };
}

function questionResult(
  decision: QuestionDecision,
  input: Record<string, unknown>,
  response: Extract<DecisionResponse, { kind: 'question' }>['response'],
): BuiltResult {
  if (response.behavior === 'decline') {
    const message = response.message.trim() === '' ? BROKER_MESSAGES.declined : response.message;
    return {
      result: { behavior: 'deny', message, decisionClassification: 'user_reject' },
      outcome: { type: 'declined' },
    };
  }
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes?: string; preview?: string }> = {};
  for (const answer of response.answers) {
    const other = answer.otherText !== null && answer.otherText.trim() !== '' ? [answer.otherText] : [];
    answers[answer.question] = [...answer.selected, ...other].join(', ');
    const annotation: { notes?: string; preview?: string } = {};
    if (answer.notes !== null && answer.notes.trim() !== '') annotation.notes = answer.notes;
    // F.5 (ask-user-question#45): the preview of the ONLY selected option.
    const only = answer.selected.length === 1 ? answer.selected[0] : undefined;
    const question = decision.questions.find((q) => q.question === answer.question);
    const preview = question?.options.find((o) => o.label === only)?.preview ?? null;
    if (preview !== null && preview !== '') annotation.preview = preview;
    if (Object.keys(annotation).length > 0) annotations[answer.question] = annotation;
  }
  return {
    result: {
      behavior: 'allow',
      updatedInput: { ...input, answers, annotations },
      decisionClassification: 'user_temporary',
    },
    outcome: { type: 'answered' },
  };
}

function planResult(
  decision: PlanDecision,
  input: Record<string, unknown>,
  response: Extract<DecisionResponse, { kind: 'plan' }>['response'],
): BuiltResult {
  if (response.behavior === 'revise') {
    return {
      result: { behavior: 'deny', message: response.feedback, decisionClassification: 'user_reject' },
      outcome: { type: 'plan_revised' },
    };
  }
  if (response.behavior === 'approve_fresh_context')
    throw new Error('approve_fresh_context is not implemented');
  const edited = response.editedPlan !== null && response.editedPlan !== decision.plan;
  return {
    result: {
      behavior: 'allow',
      updatedInput: response.editedPlan === null ? input : { ...input, plan: response.editedPlan },
      // C.4: the mode is always explicit, destination always 'session'.
      updatedPermissions: [{ type: 'setMode', mode: response.mode, destination: 'session' }],
      decisionClassification: 'user_temporary',
    },
    outcome: { type: 'plan_approved', mode: response.mode, edited },
  };
}

/**
 * The server-built PermissionResult + outcome for a VALIDATED intent (call validateResponse
 * first). `input` is the uncapped original input of the open canUseTool request.
 */
export function buildResult(
  decision: Decision,
  input: Record<string, unknown>,
  response: DecisionResponse,
): BuiltResult {
  if (decision.kind === 'permission' && response.kind === 'permission') {
    return permissionResult(decision, input, response.response);
  }
  if (decision.kind === 'question' && response.kind === 'question') {
    return questionResult(decision, input, response.response);
  }
  if (decision.kind === 'plan' && response.kind === 'plan')
    return planResult(decision, input, response.response);
  throw new Error(`response kind ${response.kind} does not match decision kind ${decision.kind}`);
}

/**
 * SDK answer when the engine cancels an open decision (§3.4 "Abbruch"): interrupt → deny with
 * `interrupt: true` BEFORE interrupt(); prompt with priority 'now' → deny without interrupt;
 * process exit, reset, aborted signal → deny (the CLI no longer reads it).
 */
export function cancelResult(reason: CancelReason, answer: 'deny' | 'deny-interrupt'): PermissionResult {
  if (answer === 'deny-interrupt') {
    return {
      behavior: 'deny',
      message: BROKER_MESSAGES.interrupted,
      interrupt: true,
      decisionClassification: 'user_reject',
    };
  }
  if (reason === 'interrupted') {
    return {
      behavior: 'deny',
      message: BROKER_MESSAGES.newMessage,
      interrupt: false,
      decisionClassification: 'user_reject',
    };
  }
  return { behavior: 'deny', message: BROKER_MESSAGES.cancelled, interrupt: false };
}
