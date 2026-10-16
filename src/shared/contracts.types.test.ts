/**
 * Type tests of the contracts (checked by `tsc -b`; the runtime part is trivial). They pin the
 * public types so an accidental contract change fails the typecheck.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type { DecisionKind, EntryId, PermissionMode, RuleDestination } from './common';
import { ERROR_CODES, type ErrorCode, type ErrorPayload } from './errors';
import {
  takeAuthCodeFromHash,
  type AuthExchangeResponse,
  type AuthStatusResponse,
  type HealthResponse,
  type LauncherCodeResponse,
} from './http';
import type {
  Decision,
  DecisionOutcome,
  DecisionResponse,
  FsListing,
  SessionDetail,
  SessionDetailPatch,
  Settings,
  SettingsPatch,
  SystemEvent,
  TranscriptItem,
  TranscriptItemKind,
} from './model';
import type { PathIssue } from './paths';
import {
  type SERVER_MESSAGE_TYPES,
  parseCommandResult,
  parseServerMessage,
  type ClientMessageType,
  type Command,
  type CommandName,
  type CommandOf,
  type CommandResult,
  type HostCommand,
  type HostCommandName,
  type ServerMessage,
  type ServerMessageType,
  type SessionOp,
  type SessionOpName,
} from './protocol';
import {
  deriveDisplayStatus,
  type DisplayStatus,
  type DisplayStatusKind,
  type NotificationKind,
  type StatusFacts,
} from './status';
import type { SessionViewState } from './sync';

function assertNever(value: never): never {
  throw new Error(`unexpected ${String(value)}`);
}

/** Exhaustive switches: adding a member without handling it is a compile error. */
function opLabel(op: SessionOp): string {
  switch (op.op) {
    case 'item.upsert':
      return op.item.id;
    case 'item.delta':
      return op.itemId;
    case 'item.remove':
      return op.itemId;
    case 'conversation.reset':
      return op.conversationId;
    case 'decision.upsert':
      return op.decision.id;
    case 'decision.resolved':
      return op.decisionId;
    case 'detail.patch':
      return 'detail';
    default:
      return assertNever(op);
  }
}

function itemLabel(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user_message':
    case 'assistant_text':
    case 'thinking':
    case 'tool_call':
    case 'turn_result':
      return item.kind;
    case 'system':
      return systemLabel(item.event);
    default:
      return assertNever(item);
  }
}

function systemLabel(event: SystemEvent): string {
  switch (event) {
    case 'compact_boundary':
    case 'api_retry':
    case 'rate_limit':
    case 'notification':
    case 'informational':
    case 'hook':
    case 'permission_denied':
    case 'memory_recall':
    case 'local_command_output':
    case 'model_fallback':
    case 'interrupted':
    case 'conversation_reset':
    case 'task_notification':
    case 'error':
    case 'unknown':
    case 'handoff':
      return event;
    default:
      return assertNever(event);
  }
}

function displayLabel(kind: DisplayStatusKind): string {
  switch (kind) {
    case 'needs-permission':
    case 'needs-answer':
    case 'needs-review':
    case 'needs-resume':
    case 'error':
    case 'interrupted':
    case 'rate-limited':
    case 'starting':
    case 'working':
    case 'background':
    case 'done':
    case 'idle':
    case 'sleeping':
    case 'external':
      return kind;
    default:
      return assertNever(kind);
  }
}

/** i18n tables are typed Record<ErrorCode, string> (WP-14): a missing code is a compile error. */
const errorTexts: Record<ErrorCode, string> = Object.fromEntries(
  ERROR_CODES.map((code) => [code, code]),
) as Record<ErrorCode, string>;

describe('contract types', () => {
  it('command results are typed per command', () => {
    expectTypeOf<CommandResult<'session.create'>>().toEqualTypeOf<{
      entryId: string;
      messageUuid: string | null;
    }>();
    expectTypeOf<CommandResult<'session.sendPrompt'>>().toEqualTypeOf<{ messageUuid: string }>();
    expectTypeOf<CommandResult<'decision.respond'>>().toEqualTypeOf<{ outcome: DecisionOutcome }>();
    expectTypeOf(parseCommandResult('session.interrupt', {})).toEqualTypeOf<{
      stillQueued: string[];
    } | null>();
  });

  it('commands are a discriminated union by name', () => {
    expectTypeOf<Extract<Command, { name: 'decision.respond' }>>().toEqualTypeOf<
      CommandOf<'decision.respond'>
    >();
    expectTypeOf<CommandOf<'decision.respond'>['response']>().toEqualTypeOf<DecisionResponse>();
    expectTypeOf<CommandOf<'decision.respond'>['entryId']>().toEqualTypeOf<EntryId>();
    expectTypeOf<CommandOf<'settings.update'>['patch']>().toEqualTypeOf<SettingsPatch>();
    expectTypeOf<SettingsPatch>().toEqualTypeOf<Partial<Settings>>();
    expectTypeOf<CommandName>().toExtend<string>();
  });

  it('host commands (Phase 2, ADR-101) carry no entryId', () => {
    expectTypeOf<HostCommandName>().toExtend<CommandName>();
    expectTypeOf<HostCommand>().toEqualTypeOf<Extract<Command, { name: HostCommandName }>>();
    expectTypeOf<Extract<keyof HostCommand, 'entryId'>>().toEqualTypeOf<never>();
    expectTypeOf<CommandResult<'fs.listDirectory'>>().toEqualTypeOf<FsListing>();
  });

  it('SERVER_MESSAGE_TYPES is complete', () => {
    expectTypeOf<(typeof SERVER_MESSAGE_TYPES)[number]>().toEqualTypeOf<ServerMessageType>();
    expectTypeOf<ClientMessageType>().toEqualTypeOf<
      'clientHello' | 'presence' | 'subscribe' | 'unsubscribe' | 'cmd'
    >();
  });

  it('parse helpers return discriminated results', () => {
    const result = parseServerMessage('{}');
    if (result.ok === true) expectTypeOf(result.message).toEqualTypeOf<ServerMessage>();
    else if (result.ok === 'ignored') expectTypeOf(result.type).toEqualTypeOf<string>();
    else expectTypeOf(result.error).toEqualTypeOf<ErrorPayload>();
  });

  it('enums and kinds', () => {
    expectTypeOf<SessionOpName>().toEqualTypeOf<
      | 'item.upsert'
      | 'item.delta'
      | 'item.remove'
      | 'conversation.reset'
      | 'decision.upsert'
      | 'decision.resolved'
      | 'detail.patch'
    >();
    expectTypeOf<TranscriptItemKind>().toEqualTypeOf<
      'user_message' | 'assistant_text' | 'thinking' | 'tool_call' | 'system' | 'turn_result'
    >();
    expectTypeOf<Decision['kind']>().toEqualTypeOf<DecisionKind>();
    expectTypeOf<RuleDestination>().toEqualTypeOf<
      'session' | 'localSettings' | 'projectSettings' | 'userSettings'
    >();
    expectTypeOf<PermissionMode>().toEqualTypeOf<
      'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'
    >();
    expectTypeOf<NotificationKind>().toEqualTypeOf<
      'permission' | 'question' | 'plan' | 'done' | 'error' | 'rate_limit'
    >();
    expectTypeOf(ERROR_CODES).toEqualTypeOf<ErrorCode[]>();
    expectTypeOf(errorTexts).toEqualTypeOf<Record<ErrorCode, string>>();
  });

  it('detail patch has every detail field except entryId', () => {
    expectTypeOf<keyof SessionDetailPatch>().toEqualTypeOf<Exclude<keyof SessionDetail, 'entryId'>>();
  });

  it('status and view state', () => {
    expectTypeOf(deriveDisplayStatus).parameters.toEqualTypeOf<[StatusFacts, Date]>();
    expectTypeOf(deriveDisplayStatus).returns.toEqualTypeOf<DisplayStatus>();
    expectTypeOf<SessionViewState['items']>().toEqualTypeOf<TranscriptItem[]>();
    expectTypeOf<SessionViewState['decisions']>().toEqualTypeOf<Decision[]>();
  });

  it('HTTP contract types (R0-01)', () => {
    expectTypeOf<HealthResponse['product']>().toEqualTypeOf<'parallax'>();
    expectTypeOf<AuthStatusResponse>().toEqualTypeOf<{ authenticated: boolean; serverInstanceId: string }>();
    expectTypeOf<AuthExchangeResponse['authenticated']>().toEqualTypeOf<true>();
    expectTypeOf<LauncherCodeResponse>().toEqualTypeOf<{
      code: string;
      expiresAt: string;
      serverInstanceId: string;
    }>();
    expectTypeOf(takeAuthCodeFromHash).returns.toEqualTypeOf<{ code: string | null; hash: string }>();
    expectTypeOf<PathIssue>().toExtend<string>();
  });

  it('R0-14 adds needs-resume to the display kinds', () => {
    expectTypeOf<'needs-resume'>().toExtend<DisplayStatusKind>();
  });

  it('exhaustive switches compile', () => {
    expectTypeOf(opLabel).returns.toBeString();
    expectTypeOf(itemLabel).returns.toBeString();
    expectTypeOf(displayLabel).returns.toBeString();
  });
});
