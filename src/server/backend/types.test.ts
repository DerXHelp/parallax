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
import type { AgentBackend, OutgoingPrompt, StartSessionRequest } from './types';

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
