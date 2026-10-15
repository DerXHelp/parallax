/**
 * Type tests: the SDK enums mirrored in src/shared/common.ts must match SDK 0.3.296, so an SDK
 * upgrade that changes them fails the typecheck (B "SDK-Upgrade-Prozess").
 */
import type {
  EffortLevel as SdkEffortLevel,
  PermissionMode as SdkPermissionMode,
  PermissionUpdateDestination,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expectTypeOf, it } from 'vitest';
import type { EffortLevel, PermissionMode, RuleDestination } from '@shared/common';
import type { ParseProfileArgs, ProfileArgIssueParams } from '../claude/ports';
import type { ReduceStatusContext, StatusSignal } from '../sessions/ports';
import type { DecisionStore } from '../sync/ports';
import type {
  AgentBackend,
  BackendSessionInfo,
  HistoryMessage,
  OutgoingPrompt,
  StartSessionRequest,
} from './types';

describe('SDK mirror types', () => {
  it('permission modes and effort levels equal the SDK', () => {
    expectTypeOf<PermissionMode>().toEqualTypeOf<SdkPermissionMode>();
    expectTypeOf<EffortLevel>().toEqualTypeOf<SdkEffortLevel>();
  });

  it('rule destinations are SDK destinations (without cliArg)', () => {
    expectTypeOf<RuleDestination>().toExtend<PermissionUpdateDestination>();
    expectTypeOf<Exclude<PermissionUpdateDestination, RuleDestination>>().toEqualTypeOf<'cliArg'>();
  });

  it('backend port uses the shared enums', () => {
    expectTypeOf<StartSessionRequest['permissionMode']>().toEqualTypeOf<PermissionMode | null>();
    expectTypeOf<OutgoingPrompt['priority']>().toEqualTypeOf<'next' | 'now'>();
    expectTypeOf<AgentBackend['kind']>().toEqualTypeOf<'sdk' | 'fake'>();
  });
});

describe('R0 port refinements', () => {
  type Signal<T extends StatusSignal['type']> = Extract<StatusSignal, { type: T }>;

  it('unknown permission modes of a newer CLI are null (R0-05d)', () => {
    expectTypeOf<Signal<'init'>['permissionMode']>().toEqualTypeOf<PermissionMode | null>();
    expectTypeOf<Signal<'permission_mode'>['mode']>().toEqualTypeOf<PermissionMode | null>();
  });

  it('turn_result marks startup failures; the reducer knows whether session_state exists (R0-05a)', () => {
    expectTypeOf<Signal<'turn_result'>['startupFailure']>().toEqualTypeOf<boolean>();
    expectTypeOf<ReduceStatusContext>().toEqualTypeOf<{
      viewedByVisibleClient: boolean;
      sessionStateSeen: boolean;
    }>();
  });

  it('profile args: pure parser, issues carry index + flag (R0-04)', () => {
    expectTypeOf<ParseProfileArgs>().parameters.toEqualTypeOf<[readonly string[], boolean]>();
    expectTypeOf<ProfileArgIssueParams['index']>().toEqualTypeOf<number>();
    expectTypeOf<ProfileArgIssueParams['flag']>().toEqualTypeOf<string>();
  });
});

describe('R1 contract package (additive)', () => {
  type Signal<T extends StatusSignal['type']> = Extract<StatusSignal, { type: T }>;

  it('context_estimate carries the context window of the last result (R1-07)', () => {
    expectTypeOf<Signal<'context_estimate'>['contextWindow']>().toEqualTypeOf<number | null>();
  });

  it('history messages may carry the SessionMessage origin; session info the first prompt', () => {
    expectTypeOf<HistoryMessage['origin']>().toEqualTypeOf<{ kind: string } | null | undefined>();
    expectTypeOf<BackendSessionInfo['firstPrompt']>().toEqualTypeOf<string | null>();
  });

  it('the decision store can be flushed through the port (WP-13 §6 Nr. 1)', () => {
    expectTypeOf<DecisionStore['flush']>().toEqualTypeOf<() => Promise<void>>();
  });
});
